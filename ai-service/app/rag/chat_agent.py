"""
Interactive Bid Manager chat agent using local Postgres pgvector + Ollama.
"""
from collections import defaultdict
from typing import Dict

from langchain_classic.chains import create_history_aware_retriever, create_retrieval_chain
from langchain_classic.chains.combine_documents import create_stuff_documents_chain
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables import RunnableWithMessageHistory
from langchain_ollama import ChatOllama, OllamaEmbeddings

from app.config import settings

# The LLM model to use for generation — upgrade this to a larger model when available.
LLM_MODEL = "qwen2.5:1.5b-instruct"
# Fallback if the 1.5b is not yet pulled
LLM_MODEL_FALLBACK = "qwen2.5:0.5b-instruct"

# Number of cosine-similarity chunks to add AFTER name-matched chunks are included.
TOP_K = 6


def _resolve_llm_model() -> str:
    """Return the best available LLM model."""
    import urllib.request, json as _json
    try:
        with urllib.request.urlopen(f"{settings.OLLAMA_URL}/api/tags", timeout=3) as resp:
            data = _json.loads(resp.read())
            available = {m["name"] for m in data.get("models", [])}
            if LLM_MODEL in available:
                return LLM_MODEL
    except Exception:
        pass
    return LLM_MODEL_FALLBACK


def build_chain():
    from app.rag.models import EmployeeRagVector, init_rag_schema
    from app.rag.db import engine
    from langchain_core.retrievers import BaseRetriever
    from langchain_core.callbacks import CallbackManagerForRetrieverRun
    from langchain_core.documents import Document as LCDocument
    from sqlalchemy.orm import Session
    from sqlalchemy import select
    import re

    # Ensure schema exists
    init_rag_schema()

    embedder = OllamaEmbeddings(
        model=settings.EMBEDDING_MODEL,
        base_url=settings.OLLAMA_URL,
    )

    class PostgresRetriever(BaseRetriever):
        def _get_relevant_documents(
            self, query: str, *, run_manager: CallbackManagerForRetrieverRun
        ) -> list[LCDocument]:

            emb = embedder.embed_query(query)
            seen_ids: set[int] = set()
            docs: list[LCDocument] = []

            with Session(engine) as session:
                # ── Load all vectors ───────────────────────────────────────
                all_vecs = session.execute(
                    select(EmployeeRagVector.id, EmployeeRagVector.user_id,
                           EmployeeRagVector.content, EmployeeRagVector.metadata_json)
                ).all()

                # Map: user_id → list of rows
                uid_to_rows: dict = defaultdict(list)
                for row in all_vecs:
                    uid_to_rows[row.user_id].append(row)

                # ── Build name registry from profile chunks ────────────────
                # name_word (lowercase) → list of (uid, full_name, email)
                name_word_map: dict = defaultdict(list)

                for uid, rows in uid_to_rows.items():
                    profile_row = next(
                        (r for r in rows if r.metadata_json.get("chunk_type") == "profile"),
                        None
                    )
                    if not profile_row:
                        continue

                    first_line = profile_row.content.split("\n")[0]
                    name_match = re.match(
                        r"^([A-Za-zÀ-ÿ\s]+?)(?:\s\u2014|\s+is\s)", first_line
                    )
                    full_name = name_match.group(1).strip() if name_match else ""
                    email_match = re.search(r"Email:\s*(\S+)", profile_row.content)
                    email = email_match.group(1) if email_match else "unknown"

                    for part in full_name.lower().split():
                        if len(part) > 2:
                            name_word_map[part].append((uid, full_name, email))

                # ── Phase 1: detect mentioned employees & disambiguate ─────
                query_lower = query.lower()
                matched_uids: dict = {}          # uid → (full_name, email)
                ambiguous_groups: list = []      # list of groups of (uid, name, email)

                for word, matches in name_word_map.items():
                    if word in query_lower:
                        unique_uids = {m[0]: m for m in matches}
                        if len(unique_uids) > 1:
                            # Multiple distinct employees share this name word
                            ambiguous_groups.append(list(unique_uids.values()))
                        else:
                            uid, full_name, email = list(unique_uids.values())[0]
                            matched_uids[uid] = (full_name, email)

                # Handle ambiguous matches
                for group in ambiguous_groups:
                    # Include all matching employees' chunks
                    for uid, full_name, email in group:
                        matched_uids[uid] = (full_name, email)

                    # Inject a disambiguation notice FIRST in the context
                    names_list = "\n".join(
                        f"  - {full_name} (email: {email})"
                        for _, full_name, email in group
                    )
                    notice = (
                        "[DISAMBIGUATION REQUIRED] Multiple employees share a similar name. "
                        "You MUST ask the user to clarify which person they mean by email or "
                        "full name before providing any specific information. "
                        f"The matching employees are:\n{names_list}"
                    )
                    docs.insert(0, LCDocument(
                        page_content=notice,
                        metadata={"chunk_type": "disambiguation_notice"}
                    ))

                # Force-include ALL chunks for each matched employee
                for uid in matched_uids:
                    for r in uid_to_rows[uid]:
                        chunk_type = r.metadata_json.get("chunk_type", "")
                        if r.id not in seen_ids and chunk_type != "directory":
                            seen_ids.add(r.id)
                            docs.append(LCDocument(
                                page_content=r.content,
                                metadata=r.metadata_json or {}
                            ))

                # ── Phase 2: cosine similarity fill (only for general queries) ──
                # If a specific employee was named, we already have all their data.
                # Adding cosine matches would only contaminate the context with
                # other employees' chunks and confuse the model.
                if not matched_uids:
                    stmt = (
                        select(EmployeeRagVector)
                        .order_by(EmployeeRagVector.embedding.cosine_distance(emb))
                        .limit(TOP_K)
                    )
                    for r in session.execute(stmt).scalars().all():
                        if r.id not in seen_ids:
                            seen_ids.add(r.id)
                            docs.append(LCDocument(
                                page_content=r.content,
                                metadata=r.metadata_json or {}
                            ))

            return docs

    retriever = PostgresRetriever()

    model_name = _resolve_llm_model()
    print(f"[chat_agent] Using LLM: {model_name}")

    llm = ChatOllama(
        model=model_name,
        base_url=settings.OLLAMA_URL,
        temperature=0.0,
        disable_streaming=True,
        num_ctx=4096,
    )

    # History-aware retriever: rewrites follow-ups as standalone questions
    contextualize_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "Given the chat history and the user's latest question, rewrite it as a "
                "complete standalone question that can be understood without the chat history. "
                "Include any employee names or topics mentioned earlier if they are relevant. "
                "Output ONLY the rewritten question, nothing else.",
            ),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ]
    )
    history_aware_retriever = create_history_aware_retriever(
        llm=llm,
        retriever=retriever,
        prompt=contextualize_prompt,
    )

    qa_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """You are a Bid Manager assistant. Your ONLY source of information is the context below.

STRICT RULES — follow all of them:
1. ONLY state facts that are explicitly written in the context. Do NOT infer, guess, or generalize.
2. NEVER invent, assume, or add information that is not in the context.
3. If someone asks you to translate text: translate ONLY the exact words that appear in the context. Do NOT use your own knowledge to introduce new terms.
4. If a fact is not in the context, say exactly: "I don't have that information."
5. When multiple employees appear in the context, carefully attribute each fact to the correct employee by matching the name in the section header (e.g. "Jazil Gafsi — Certifications:").
6. Do NOT say one employee has information that belongs to a different employee.
7. Keep answers concise and factual.
8. If the context contains a [DISAMBIGUATION REQUIRED] notice, you MUST ask the user to clarify which person they mean before answering. Do NOT guess or answer for both.

Context (each section is labeled with the employee name):
{context}""",
            ),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ]
    )
    qa_chain = create_stuff_documents_chain(llm=llm, prompt=qa_prompt)
    rag_chain = create_retrieval_chain(history_aware_retriever, qa_chain)

    store: Dict[str, InMemoryChatMessageHistory] = defaultdict(InMemoryChatMessageHistory)
    conversational_chain = RunnableWithMessageHistory(
        rag_chain,
        lambda session_id: store[session_id],
        input_messages_key="input",
        history_messages_key="chat_history",
        output_messages_key="answer",
    )
    return conversational_chain


def chat_loop():
    chain = build_chain()
    session_id = "cli"
    print("Bid Manager ready. Type 'exit' to quit.\n")
    while True:
        try:
            user_input = input("You: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nBye.")
            break
        if not user_input:
            continue
        if user_input.lower() in {"exit", "quit", "q"}:
            print("Bye.")
            break

        import time
        t0 = time.time()
        print("...retrieving + generating (please wait)", flush=True)
        result = chain.invoke(
            {"input": user_input},
            config={"configurable": {"session_id": session_id}},
        )
        dt = time.time() - t0
        answer = result.get("answer", "")
        print(f"Bid Manager: {answer}\n(took {dt:.1f}s)\n")


if __name__ == "__main__":
    chat_loop()
