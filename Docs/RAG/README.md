# RAG Setup And Testing Guide

This document summarizes what has already been implemented for the RAG module and how to test it end to end.

## 1) What Has Already Been Done

### 1.1 Database connection and vector extension
- File: `ai-service/app/rag/db.py`
- Implemented:
  - SQLAlchemy engine creation from `settings.DATABASE_URL`.
  - `SessionLocal` session factory for DB operations.
  - `init_vector_extension()` to run:
    - `CREATE EXTENSION IF NOT EXISTS vector`

Why it matters:
- The `vector` type must exist in PostgreSQL before storing embeddings.

### 1.2 RAG vector table model
- File: `ai-service/app/rag/models.py`
- Implemented table: `employee_rag_vectors`
- Columns:
  - `id` (primary key, autoincrement)
  - `user_id` (UUID, unique, indexed)
  - `content` (TEXT)
  - `metadata_json` (JSONB)
  - `embedding` (VECTOR with dimension `settings.EMBEDDING_DIM`)
- Implemented `init_rag_schema()`:
  - initializes vector extension
  - creates ORM tables via `Base.metadata.create_all(...)`

Why it matters:
- This table is the RAG knowledge index for employee profiles.

### 1.3 Schema bootstrap script
- File: `ai-service/app/rag/init_db.py`
- Implemented:
  - Entry point that calls `init_rag_schema()`
  - Prints `RAG schema initialized.`

Why it matters:
- One command initializes the RAG DB schema.

### 1.4 Ingestion pipeline (ETL)
- File: `ai-service/app/rag/etl_ingest.py`
- Implemented:
  - Load employee rows from PostgreSQL (`users` + `employee_profiles`)
  - Discover and read local `metadata.json` files
  - Build a consolidated text profile ("golden record")
  - Generate embeddings using Ollama (`nomic-embed-text`)
  - Upsert into `employee_rag_vectors`
  - `--dry-run` mode for safe validation without DB writes

Why it matters:
- This pipeline populates the vector table used for semantic retrieval in RAG.

### 1.5 Configuration
- File: `ai-service/app/config.py`
- File: `ai-service/.env`
- Implemented config keys used by RAG:
  - `DATABASE_URL`
  - `EMBEDDING_DIM`
  - `OLLAMA_URL`
  - `EMBEDDING_MODEL`
  - `RAG_METADATA_ROOTS`

Why it matters:
- Wrong config values are the most common cause of test failures.

## 2) Tools Used (and their role)

- SQLAlchemy:
  - Handles PostgreSQL connection, sessions, ORM model, and table creation.
- pgvector:
  - Adds vector column type to PostgreSQL and enables embedding storage/search.
- PostgreSQL:
  - Stores relational employee data + vectorized RAG records.
- LangChain + Ollama:
  - Generates text embeddings used in `embedding` column.

## 3) Testing Checklist (Step by Step)

Run commands from project root: `NextRH`.

### Step 0: Ensure containers are running (if using Docker DB)
```powershell
docker compose ps
```
Meaning:
- `postgres` should be `Up`. If not, start with:
```powershell
docker compose up -d postgres
```

### Step 1: Verify Python dependencies
```powershell
cd ai-service
pip show sqlalchemy pgvector psycopg langchain-ollama
```
Meaning:
- If package details are printed, dependencies are available.
- If a package is missing, install:
```powershell
pip install -r requirements.txt
```

### Step 2: Verify config is loaded
```powershell
python -c "from app.config import settings; print(settings.DATABASE_URL); print(settings.EMBEDDING_DIM)"
```
Meaning:
- Confirms `.env` is read and values are available in the app.

### Step 3: Verify database connectivity from Python
```powershell
python -c "from app.rag.db import engine; from sqlalchemy import text; \
with engine.connect() as c: print(c.execute(text('select 1')).scalar())"
```
Meaning:
- Output `1` means Python can connect to PostgreSQL.

### Step 4: Initialize RAG schema
```powershell
python -m app.rag.init_db
```
Expected output:
```text
RAG schema initialized.
```
Meaning:
- Vector extension check + table creation executed successfully.

### Step 5: Validate table existence (Docker terminal SQL)
```powershell
docker compose exec postgres psql -U postgres -d cv_management -c "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = 'employee_rag_vectors';"
```
Meaning:
- One row returned means the table exists.

### Step 6: Validate table columns
```powershell
docker compose exec postgres psql -U postgres -d cv_management -c "SELECT column_name, data_type, udt_name, is_nullable FROM information_schema.columns WHERE table_name = 'employee_rag_vectors' ORDER BY ordinal_position;"
```
Meaning:
- Expected columns:
  - `id`
  - `user_id`
  - `content`
  - `metadata_json`
  - `embedding`
- `embedding` should map to `vector` (`udt_name = vector`).

### Step 7: Validate pgvector extension
```powershell
docker compose exec postgres psql -U postgres -d cv_management -c "SELECT extname FROM pg_extension WHERE extname = 'vector';"
```
Meaning:
- If `vector` is returned, pgvector is active in this database.

### Step 8: Test ingestion in dry-run mode (no writes)
```powershell
python -m app.rag.etl_ingest --limit 2 --dry-run
```
Meaning:
- Tests metadata discovery + content build + embedding generation.
- No insert/update happens in DB.

### Step 9: Test real ingestion (writes enabled)
```powershell
python -m app.rag.etl_ingest --limit 2
```
Meaning:
- Upserts records into `employee_rag_vectors`.
- You should see `[OK] Upserted ...` logs.

### Step 10: Verify inserted rows
```powershell
docker compose exec postgres psql -U postgres -d cv_management -c "SELECT id, user_id, left(content, 120) AS preview FROM employee_rag_vectors ORDER BY id DESC LIMIT 5;"
```
Meaning:
- Returned rows confirm ingestion wrote data into the RAG table.

## 4) Important Environment Note

In this repo:
- Docker Postgres is exposed as `localhost:5432` in `docker-compose.yml`.
- Current `ai-service/.env` may use `5433`.

If connection tests fail, align the port in `ai-service/.env` with the running DB instance.

## 5) Quick Expected Outcome

After successful tests:
- `employee_rag_vectors` exists with correct columns.
- `vector` extension exists.
- Dry-run works without writes.
- Real ingestion inserts/updates rows.

At this point, the RAG data layer is ready for retrieval/query implementation.

## 6) Chat Agent (Bid Manager) – What Was Added
- File: `ai-service/app/rag/chat_agent.py`
- Persona: “The Bid Manager” (staffing expert) with conversational memory.
- Retrieval: **Qdrant** vector store (local, persisted at `./qdrant_local`). Uses `langchain_qdrant` + `qdrant-client`, retrieving top-3 documents to keep the 1.5B model focused.
- Reasoning chain:
  - `create_history_aware_retriever` to rewrite follow-up questions using chat history.
  - `create_stuff_documents_chain` with a strict system prompt: if context is missing or lacks the answer, respond exactly “I don’t know”; otherwise reply with short bullet points using only context.
  - Wrapped with `RunnableWithMessageHistory` for per-session memory (session id `cli`).
- LLM: `qwen2.5:1.5b-instruct` on Ollama, streaming disabled for stability, reduced `num_ctx/num_predict` for low-RAM environments.

## 7) How to Test the Chat Agent (fast path)
Run from repo root unless stated.

1) Ensure DB + data are ready  
   - `python -m app.rag.init_db` (once)  
   - `python -m app.rag.etl_ingest` (once; ensure rows in `employee_rag_vectors`)

2) Ensure lightweight model is available  
   - `ollama pull qwen2.5:1.5b-instruct` (or `0.5b` if RAM is very tight)  
   - Optional: remove heavier model to save disk/RAM headroom: `ollama rm qwen2.5:3b-instruct`

3) Start the chat loop  
   ```powershell
   cd ai-service
   python -m app.rag.chat_agent
   ```

4) Try sample prompts  
   - “Who has a CCNP Security certification?”  
   - Follow-up: “What projects did they deliver recently?” (tests history-aware retrieval)  
   - Ambiguous: “Need someone for Azure security hardening next week—recommend 2 names.”

5) Exit  
   - Type `exit` / `quit` or press `Ctrl+C`.

Expected: Startup is instant (no vector rebuild). Answers cite skills/certs/projects from stored golden records; follow-ups resolve pronouns using conversation history.

## 8) ETL changes for Qdrant
- File: `ai-service/app/rag/etl_ingest.py`
- Now writes embeddings to Qdrant (local path `./qdrant_local`, collection `employees`) via `qdrant-client` + `langchain_qdrant`.
- Recreates the collection with cosine distance and the configured embedding dimension, then bulk-adds documents built from metadata/golden records.

## 9) Dependency notes
Install (aligned versions):
```powershell
pip install qdrant-client langchain-qdrant langchain-ollama langchain langchain-core langchain-community langchain-text-splitters
```
Keep all LangChain packages on matching 0.3.x versions to avoid resolver conflicts.

Docker Updates

Added ollama service (ollama/ollama:latest) on port 11434 with named volume ollama_data at /root/.ollama in docker-compose.yml.
Added qdrant service (qdrant/qdrant:latest) on port 6333 with named volume qdrant_data at /qdrant/storage in docker-compose.yml.
Declared volumes ollama_data and qdrant_data under volumes: so they persist outside container lifecycles.
How persistence works

Named volumes live in Docker’s volume store, not the container filesystem, so model files and vector data remain intact across container restarts, rebuilds, or image updates; containers mount the same volume path on each start.
Images in use

Ollama: ollama/ollama:latest
Qdrant: qdrant/qdrant:latest
How to test

Start services in background: docker-compose up -d ollama qdrant
Pull the model inside Ollama: docker exec -it cv-ollama ollama pull qwen2.5:1.5b-instruct

Updated Qdrant connections to the Docker endpoint in etl_ingest.py and chat_agent.py (QdrantClient(url="http://localhost:6333")).
Added AISearchQuery ORM model to models.py mapped exactly to the existing ai_search_queries table (UUID PK, FK to users, text/int/jsonb/timestamp columns).
How to test quickly:

Bring up Qdrant (and Ollama if needed): docker-compose up -d qdrant ollama
Verify the new ORM mapping and DB connectivity:
cd ai-service
venv\Scripts\python - <<'PY'
from sqlalchemy import create_engine, inspect, text
from app.config import settings
from app.rag.models import AISearchQuery  # ensures model imports fine

engine = create_engine(settings.DATABASE_URL)
with engine.connect() as conn:
    print("table present:", "ai_search_queries" in inspect(conn).get_table_names())
    conn.execute(text("SELECT 1 FROM ai_search_queries LIMIT 1")).fetchone()
print("OK")
PY
Sanity-check Qdrant client URL is reachable:
cd ai-service
venv\Scripts\python - <<'PY'
from qdrant_client import QdrantClient
client = QdrantClient(url="http://localhost:6333")
print("collections:", client.get_collections())
PY

ETL pipeline can be triggered dynamically while logging every user query, its retrieved results, and the LLM’s execution time in the database without interrupting the user’s chat experience.:
test:
Do this next, step by step:

Test commands (PowerShell):

Recreate containers (pull GPU-aware Ollama):
docker-compose up -d --force-recreate --build ollama qdrant
Pull the embedding + chat model if not present:
docker exec -it cv-ollama ollama pull nomic-embed-text
docker exec -it cv-ollama ollama pull qwen2.5:1.5b-instruct
Re-run ETL to fill Qdrant:
cd C:\Users\Rania\Desktop\PFE\NextRH\ai-service
python -m app.rag.etl_ingest
Run chat agent (logs queries, prints retrieved docs):
cd C:\Users\Rania\Desktop\PFE\NextRH\ai-service
python -m app.rag.chat_agent
To verify the log row via Docker (no local psql needed):
docker exec -it cv-postgres psql -U postgres -d cv_management -c "SELECT query_text, result_count, execution_time_ms, created_at FROM ai_search_queries ORDER BY created_at DESC LIMIT 5;"


Added FastAPI background endpoint in main.py: imports BackgroundTasks and trigger_embedding_pipeline, defines POST /api/embeddings/update that schedules trigger_embedding_pipeline as a background task and immediately returns {"status": "Processing started in the background"}. Imports updated accordingly.
HOW it avoids timeouts:

BackgroundTasks queues the ingestion function to run after the response is sent, so the HTTP request returns immediately instead of waiting for long-running embedding generation.
TOOLS used:

FastAPI BackgroundTasks, FastAPI app instance, and the existing trigger_embedding_pipeline from app.rag.etl_ingest.
How to test:

Start the API server (from ai-service):
uvicorn app.main:app --host 0.0.0.0 --port 8000
Trigger the background ingestion (from any shell):
curl -X POST http://localhost:8000/api/embeddings/update
Expect JSON: {"status": "Processing started in the background"} while the embedding pipeline runs asynchronously.

Hybrid search added and wired up.

What changed

chat_agent.py now builds an EnsembleRetriever combining:
Dense retriever from pgvector (PGVector using employee_rag_vectors with your Ollama embeddings).
Keyword retriever (BM25Retriever) built from all CV texts pulled from EmployeeRagVector.content.
Combined with equal weights [0.5, 0.5].
New imports for BM25Retriever, EnsembleRetriever, PGVector, Document, and SQLAlchemy select. Qdrant imports were removed.
Why this helps

BM25 requires exact term matches, so a query like “Python” will boost candidates whose CVs actually contain the word, reducing fuzzy “similar but wrong” matches from pure dense search. The ensemble balances semantic recall with literal keyword precision.
How to use / test

Install the BM25 dependency once: pip install rank_bm25.
Start the AI service (use the current port you’re using for the app, e.g., 8005):
cd C:\Users\Rania\Desktop\PFE\NextRH\ai-service
python -m uvicorn app.main:app --host 0.0.0.0 --port 8005 --reload
Ask a keyword-sensitive question via your chat agent; you should see more exact matches for terms like “Python”.
Notes

This relies on vectors and text stored in the employee_rag_vectors table. Ensure it’s populated (run your ingestion if needed) and that Postgres is reachable on your configured port.


emory-ready RAG agent is in place.

Key changes in chat_agent.py

Kept InMemoryChatMessageHistory with RunnableWithMessageHistory; history lives only in RAM and is keyed by session_id.
Updated the contextualization prompt to the strict, concise format:
Combine the Chat History and the User Question into one standalone search query.
History: {chat_history}
Question: {input}
Standalone Query:
Still uses create_history_aware_retriever to rewrite follow-ups before hitting the retrievers.
Technical breakdown 

TOOLS USED: InMemoryChatMessageHistory stores turns in RAM; RunnableWithMessageHistory injects/retrieves that history; create_history_aware_retriever generates context-aware queries.
DATA FLOW: User input + past messages → history-aware LLM builds the “Standalone Query” → that query is sent to the hybrid retriever (BM25 + pgvector) → results go to the QA chain.
STORAGE LOCATION: Only in-memory dict (store in chat_agent.py). No Postgres or disk writes. Restarting the process clears all history.
HOW TO TEST: Run python -m app.rag.chat_agent, ask:
“Find a Java dev”
then “Do they know React?”
The second turn is rewritten to a standalone query that includes the first turn’s intent (Java dev) plus “React,” so it should search Java profiles and check for React without you restating context.
You can start the agent with:

cd C:\Users\Rania\Desktop\PFE\NextRH\ai-service
python -m app.rag.chat_agent
