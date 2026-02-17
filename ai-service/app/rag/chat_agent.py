"""
Interactive Bid Manager chat agent using Qdrant + Hybrid (BM25 + semantic) retrieval.
"""
from collections import defaultdict
import time
from typing import Dict, List

from langchain.chains import create_history_aware_retriever, create_retrieval_chain
from langchain.chains.combine_documents import create_stuff_documents_chain
from langchain_community.retrievers import BM25Retriever
from langchain.retrievers import EnsembleRetriever
from langchain_core.retrievers import BaseRetriever
from langchain_qdrant import QdrantVectorStore
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables import RunnableWithMessageHistory
from langchain_ollama import ChatOllama, OllamaEmbeddings
from qdrant_client import QdrantClient
from qdrant_client.http import models
from sqlalchemy import select

from app.config import settings
from app.rag.db import SessionLocal
from app.rag.models import AISearchQuery, EmployeeRagVector
def build_chain():
    embedder = OllamaEmbeddings(
        model=settings.EMBEDDING_MODEL,
        base_url=settings.OLLAMA_URL,
    )
    # Dense semantic retriever from Qdrant (stable LC 0.3.x API)
    vectorstore = QdrantVectorStore.from_existing_collection(
        embedding=embedder,
        collection_name="employees",  # ensure this matches the Qdrant collection name
        url=settings.QDRANT_URL,
    )
    dense_retriever = vectorstore.as_retriever(search_kwargs={"k": 5})

    # Build BM25 retriever from raw CV text stored in Postgres
    with SessionLocal() as db:
        rows = db.execute(
            select(EmployeeRagVector.content, EmployeeRagVector.metadata_json)
        ).all()
    docs: List[Document] = [
        Document(page_content=row[0], metadata=row[1] or {}) for row in rows if row[0]
    ]
    bm25 = BM25Retriever.from_documents(docs) if docs else BM25Retriever.from_texts([])
    bm25.k = 5

    base_retriever = EnsembleRetriever(retrievers=[bm25, dense_retriever], weights=[0.7, 0.3])

    def select_metadata(query: str, meta: dict) -> dict:
        q = query.lower()
        selected: dict = {}
        if "name" in meta:
            selected["name"] = meta["name"]
        if any(word in q for word in ("certif", "cisco")):
            if "certifications" in meta:
                selected["certifications"] = meta["certifications"]
        elif "project" in q:
            if "projects" in meta:
                selected["projects"] = meta["projects"]
        else:
            if "skills" in meta:
                selected["skills"] = meta["skills"]
        return selected

    class FilteredRetriever(BaseRetriever):
        def _get_relevant_documents(self, query: str) -> List[Document]:
            docs = base_retriever.invoke(query)
            filtered_docs: List[Document] = []
            for d in docs:
                meta = d.metadata or {}
                subset = select_metadata(query, meta)
                q = query.lower()
                # keyword-level pruning for certifications
                matching_certs: List[str] = []
                if "certifications" in subset and subset["certifications"]:
                    certs = subset["certifications"]
                    cert_list = certs if isinstance(certs, list) else [certs]
                    for c in cert_list:
                        c_str = str(c)
                        if any(kw in c_str.lower() for kw in q.split()):
                            matching_certs.append(c_str)
                parts: List[str] = []
                name = subset.get("name", "Unknown")
                parts.append(f"Candidate: {name}")
                if matching_certs:
                    parts.append("Matching Certs: " + ", ".join(matching_certs))
                elif "skills" in subset and subset["skills"]:
                    skills = subset["skills"]
                    parts.append(
                        "Skills: "
                        + (", ".join(skills) if isinstance(skills, list) else str(skills))
                    )
                elif "projects" in subset and subset["projects"]:
                    projects = subset["projects"]
                    if isinstance(projects, list):
                        parts.append("Projects: " + "; ".join([str(p) for p in projects]))
                    else:
                        parts.append(f"Projects: {projects}")

                slim_content = " | ".join(parts)
                d.page_content = slim_content
                d.metadata = {"name": name, "matching_certs": matching_certs}
                filtered_docs.append(d)
            return filtered_docs

    retriever = FilteredRetriever()

    llm = ChatOllama(
        model="qwen2.5:1.5b-instruct",
        base_url=settings.OLLAMA_URL,
        temperature=0.0,
        disable_streaming=False,
        streaming=True,
        request_timeout=120,
        num_ctx=4096,
        num_predict=200,
    )

    contextualize_prompt = ChatPromptTemplate.from_template(
        "Rewrite the user's question to be a standalone search query using the history.\n"
        "History: {chat_history}\n"
        "Question: {input}\n"
        "Search Query:"
    )
    history_aware_retriever = create_history_aware_retriever(
        llm=llm,
        retriever=retriever,
        prompt=contextualize_prompt,
    )

    qa_prompt = ChatPromptTemplate.from_template(
        """
Analyze the CONTEXT and list the employees who have the requested qualification.
Rules:
- Format: [Name]: [Specific matching certs]
- Do NOT repeat the same candidate twice.
- If no match is found, say 'No candidates found.'
Context: {context}
Question: {question}
Answer:
"""
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
    return conversational_chain, retriever


def chat_loop():
    try:
        chain, retriever = build_chain()
    except Exception as exc:
        print("[ERROR] Failed to initialize retrievers. Does the Qdrant collection 'employees' exist?")
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
        # Show raw retrieved docs for debugging false positives
        try:
            docs = retriever.invoke(user_input)
            print("\n[DEBUG] Retrieved documents:")
            for i, doc in enumerate(docs, 1):
                print(f"  #{i} meta={doc.metadata} preview={doc.page_content[:150]}")
        except Exception as exc:
            print(f"[WARN] Could not fetch debug docs: {exc}")

        print("...retrieving + generating (please wait)", flush=True)
        result = chain.invoke(
            {"input": user_input, "question": user_input},
            config={"configurable": {"session_id": session_id}},
        )
        dt = time.perf_counter() - t0
        execution_time_ms = int(dt * 1000)
        context_docs = result.get("context") or result.get("source_documents") or []
        result_count = len(context_docs) if hasattr(context_docs, "__len__") else 0

        try:
            with SessionLocal() as db:
                db.add(
                    AISearchQuery(
                        query_text=user_input,
                        execution_time_ms=execution_time_ms,
                        result_count=result_count,
                    )
                )
                db.commit()
        except Exception as exc:
            print(f"[WARN] Failed to log chat query (non-blocking): {exc}")

        answer = result.get("answer") or "The documents do not contain this information"
        print(f"Bid Manager: {answer}\n(took {dt:.1f}s)\n")


if __name__ == "__main__":
    chat_loop()
