from app.rag.models import init_rag_schema


if __name__ == "__main__":
    # Convenience entrypoint for local one-shot schema initialization.
    init_rag_schema()
    print("RAG schema initialized.")
