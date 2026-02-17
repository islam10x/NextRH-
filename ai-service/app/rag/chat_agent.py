"""
Interactive Bid Manager chat agent using local Qdrant + Ollama.
"""
from collections import defaultdict
from pathlib import Path
from typing import Dict

from langchain.chains import create_history_aware_retriever, create_retrieval_chain
from langchain.chains.combine_documents import create_stuff_documents_chain
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables import RunnableWithMessageHistory
from langchain_ollama import ChatOllama, OllamaEmbeddings
from langchain_qdrant import QdrantVectorStore
from qdrant_client import QdrantClient
from qdrant_client.http import models

from app.config import settings


def build_chain():
    embedder = OllamaEmbeddings(
        model=settings.EMBEDDING_MODEL,
        base_url=settings.OLLAMA_URL,
    )
    qdrant_path = (Path(__file__).resolve().parents[2] / "qdrant_local").resolve()
    client = QdrantClient(path=str(qdrant_path))
    if not client.collection_exists("employees"):
        client.create_collection(
            collection_name="employees",
            vectors_config=models.VectorParams(
                size=settings.EMBEDDING_DIM,
                distance=models.Distance.COSINE,
            ),
        )
    vectorstore = QdrantVectorStore(
        client=client,
        collection_name="employees",
        embedding=embedder,
    )
    retriever = vectorstore.as_retriever(search_kwargs={"k": 3})

    llm = ChatOllama(
        model="qwen2.5:1.5b-instruct",
        base_url=settings.OLLAMA_URL,
        temperature=0.0,
        disable_streaming=True,  # hard-disable streaming to avoid Ollama runner crashes
        request_timeout=60,
        num_ctx=1536,
        num_predict=256,
    )

    contextualize_prompt = ChatPromptTemplate.from_messages(
        [
            ("system", "You rewrite follow-up questions to standalone ones."),
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
                "You are a Bid Manager. Read only the context below.\n"
                "- If the context is empty OR the requested information is not explicitly stated, respond exactly: I don't know\n"
                "- Otherwise, answer using ONLY the context, in short bullet points.\n\nContext:\n{context}",
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
        context_docs = result.get("context") or []
        answer = result.get("answer", "")
        if not context_docs:
            answer = "I don't know"
        print(f"Bid Manager: {answer}\n(took {dt:.1f}s)\n")


if __name__ == "__main__":
    chat_loop()
