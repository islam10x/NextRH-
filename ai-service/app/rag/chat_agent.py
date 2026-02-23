"""
Bid Manager chat agent — RAG pipeline optimized for small local LLMs.

Flow: query → keyword extractor → Qdrant vector search → shrink → LLM
No LLM contextualization step — saves one full round trip per query.

Key design decision: NO payload filtering.
Payload MatchText filtering is unreliable on small collections (<10k points)
because Qdrant uses flat scan segments that ignore payload indexes at this scale.
Pure vector similarity search via nomic-embed-text handles recall correctly.
"""

import os
import re
import time
from collections import defaultdict
from typing import Dict, List

from langchain.chains import create_retrieval_chain
from langchain.chains.combine_documents import create_stuff_documents_chain
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.retrievers import BaseRetriever
from langchain_core.runnables import RunnableLambda, RunnableWithMessageHistory
from langchain_ollama import ChatOllama, OllamaEmbeddings
from langchain_qdrant import QdrantVectorStore

from app.config import settings
from app.rag.db import SessionLocal
from app.rag.models import AISearchQuery

os.environ.setdefault("OLLAMA_KEEP_ALIVE", "-1")

# ── Keyword extraction ────────────────────────────────────────────────────────

STOP_WORDS = {
    "did", "do", "does", "anyone", "who", "has", "have", "had",
    "worked", "work", "works", "working", "studied", "study",
    "at", "in", "with", "for", "of", "to", "from", "by", "on",
    "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "can", "could", "would", "should", "will", "may", "might",
    "find", "me", "show", "list", "give", "tell", "get",
    "any", "all", "some", "what", "which", "how", "many", "much",
    "someone", "somebody", "people", "person", "employee", "employees",
    "please", "thank", "thanks", "okay", "ok", "yes", "no",
    "their", "they", "them", "our", "we", "us", "or", "and", "but",
    "where", "when",
}

GREETING_WORDS = {"hi", "hello", "hey", "bonjour", "salut", "bonsoir"}


def _extract_search_query(inputs: dict) -> str:
    text = inputs.get("input", "").strip()
    if text.lower() in GREETING_WORDS:
        print("[KEYWORDS] greeting detected, skipping retrieval")
        return ""
    tokens = re.findall(r"\b[a-zA-Z0-9][a-zA-Z0-9\.\+\#\-]*\b", text)
    keywords = [t for t in tokens if t.lower() not in STOP_WORDS and len(t) > 1]
    result = " ".join(keywords) if keywords else text
    print(f"[KEYWORDS] '{text}' → '{result}'")
    return result


# ── Retriever ─────────────────────────────────────────────────────────────────

class QdrantFilteredRetriever(BaseRetriever):
    vectorstore: QdrantVectorStore
    k: int = 3

    def __init__(self, vectorstore: QdrantVectorStore, k: int = 3):
        super().__init__(vectorstore=vectorstore, k=k)

    def _shrink(self, doc: Document, query: str) -> Document:
        meta = doc.metadata or {}
        name = meta.get("name") or "Unknown"
        certs = meta.get("certifications") or []
        skills = meta.get("skills") or []
        experience_years = meta.get("experience_years")
        experiences = meta.get("experiences") or []
        projects = meta.get("projects") or []
        education = meta.get("education") or []
        # If education not directly in metadata, try full payload
        if not education:
            payload = meta.get("metadata") or {}
            education = payload.get("structured_data", {}).get("education", []) if isinstance(payload, dict) else []

        parts: List[str] = [f"Candidate: {name}"]
        if certs:
            parts.append("Certifications: " + ", ".join(certs))
        if skills:
            parts.append("Skills: " + ", ".join(skills[:8]))
        if experience_years:
            parts.append(f"Experience: {experience_years} years")
        if experiences:
            companies = [
                str(e.get("company") or "").strip()
                for e in experiences
                if isinstance(e, dict) and str(e.get("company") or "").strip()
            ]
            if companies:
                parts.append("Companies: " + ", ".join(companies))
        if projects:
            clients = [
                str(p.get("client") or "").strip()
                for p in projects
                if isinstance(p, dict) and str(p.get("client") or "").strip()
            ]
            if clients:
                parts.append("Clients: " + ", ".join(clients[:10]))

        if education:
            edu_lines = []
            for ed in education:
                if not isinstance(ed, dict):
                    continue
                school = str(ed.get("institution") or ed.get("school") or "").strip()
                degree = str(ed.get("degree_name") or ed.get("degree") or "").strip()
                end = str(ed.get("end_date") or "").strip()
                piece = ", ".join(filter(None, [school, degree]))
                if end:
                    piece = f"{piece} ({end})" if piece else end
                if piece:
                    edu_lines.append(piece)
            if edu_lines:
                parts.append("Education: " + " | ".join(edu_lines[:2]))

        doc.page_content = " | ".join(parts)
        doc.metadata = {"name": name, "user_id": meta.get("user_id")}
        return doc

    def _get_relevant_documents(self, query: str) -> List[Document]:
        if not query.strip():
            return []
        docs = self.vectorstore.similarity_search(
            query, k=self.k, search_params={"hnsw_ef": 128}
        )
        print(f"[RETRIEVER] query='{query}' results={len(docs)}")
        return [self._shrink(doc, query) for doc in docs]


# ── History ───────────────────────────────────────────────────────────────────

class CappedChatMessageHistory(InMemoryChatMessageHistory):
    model_config = {"extra": "allow"}

    def __init__(self, max_turns: int = 3, **kwargs):
        super().__init__(**kwargs)
        object.__setattr__(self, "_max_messages", max_turns * 2)

    def add_message(self, message) -> None:  # type: ignore[override]
        super().add_message(message)
        max_messages = getattr(self, "_max_messages", 6)
        if len(self.messages) > max_messages:
            self.messages = self.messages[-max_messages:]


# ── Chain ─────────────────────────────────────────────────────────────────────

def build_chain() -> tuple[RunnableWithMessageHistory, QdrantFilteredRetriever]:
    embedder = OllamaEmbeddings(
        model=settings.EMBEDDING_MODEL,
        base_url=settings.OLLAMA_URL,
    )
    vectorstore = QdrantVectorStore.from_existing_collection(
        embedding=embedder,
        collection_name="employees",
        url=settings.QDRANT_URL,
        timeout=15.0,
    )
    retriever = QdrantFilteredRetriever(vectorstore=vectorstore, k=3)

    llm = ChatOllama(
        model="qwen2.5:1.5b-instruct",
        base_url=settings.OLLAMA_URL,
        temperature=0.0,
        streaming=True,
        request_timeout=120,
        num_ctx=2048,
        num_predict=512,
    )

    keyword_retriever = RunnableLambda(_extract_search_query) | retriever

    qa_prompt = ChatPromptTemplate.from_messages([
        (
            "system",
            "You are a recruitment assistant. Use ONLY the context.\n"
            "For greetings, reply normally.\n"
            "Otherwise: [Name]: [Evidence] — list ALL matches, never stop early.\n"
            "If context is empty: 'No candidates found.'\n\n"
            "CONTEXT:\n{context}",
        ),
        MessagesPlaceholder("chat_history"),
        ("human", "{input}"),
    ])

    qa_chain = create_stuff_documents_chain(llm=llm, prompt=qa_prompt)
    rag_chain = create_retrieval_chain(keyword_retriever, qa_chain)

    store: Dict[str, CappedChatMessageHistory] = defaultdict(
        lambda: CappedChatMessageHistory(max_turns=3)
    )
    return (
        RunnableWithMessageHistory(
            rag_chain,
            lambda session_id: store[session_id],
            input_messages_key="input",
            history_messages_key="chat_history",
            output_messages_key="answer",
        ),
        retriever,
    )


# ── CLI ───────────────────────────────────────────────────────────────────────

def _stream_answer(chain: RunnableWithMessageHistory, session_id: str, user_input: str) -> str:
    collected: List[str] = []
    for chunk in chain.stream(
        {"input": user_input},
        config={"configurable": {"session_id": session_id}},
    ):
        token = chunk.get("answer")
        if token:
            collected.append(token)
            print(token, end="", flush=True)
    print()
    return "".join(collected)


def chat_loop():
    try:
        chain, retriever = build_chain()
    except Exception as exc:
        print("[ERROR] Failed to initialise. Is the 'employees' Qdrant collection ready?")
        print("Detail:", exc)
        return

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

        t0 = time.perf_counter()
        print("...streaming reply:\n", end="", flush=True)
        answer = _stream_answer(chain, session_id, user_input)
        dt = time.perf_counter() - t0

        try:
            with SessionLocal() as db:
                db.add(AISearchQuery(
                    query_text=user_input,
                    execution_time_ms=int(dt * 1000),
                    result_count=0,
                ))
                db.commit()
        except Exception as exc:
            print(f"[WARN] DB log failed: {exc}")

        print(f"\n(took {dt:.1f}s)\n")


if __name__ == "__main__":
    chat_loop()
