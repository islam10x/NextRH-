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
- Retrieval: **PostgreSQL pgvector** (`employee_rag_vectors` table). Uses `langchain-postgres` with cosine-distance similarity search, retrieving top-5 documents.
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

## 8) ETL changes for pgvector
- File: `ai-service/app/rag/etl_ingest.py`
- Writes embeddings to PostgreSQL `employee_rag_vectors` table via `pgvector` + SQLAlchemy.
- Deletes existing rows for a user then bulk-inserts new chunk vectors (cosine distance) built from metadata/golden records.

## 9) Dependency notes
Install (aligned versions):
```powershell
pip install pgvector psycopg2-binary sqlalchemy langchain-postgres langchain-ollama langchain langchain-core langchain-community langchain-text-splitters
```
Keep all LangChain packages on matching 0.3.x versions to avoid resolver conflicts.
## 10) Dockerized Workflow (Recommended)

The entire AI stack is now containerized and optimized for high-performance retrieval using `pgvector`.

### 10.1 Running the Stack
Ensure you have the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed for GPU support.
```powershell
docker compose up -d
```
This starts:
- `ollama`: LLM and Embedding server with NVIDIA GPU acceleration.
- `postgres`: Relational DB + Vector storage.
- `ollama-pull-models`: Automatically provisions `qwen2.5:0.5b-instruct` and `nomic-embed-text`.
- `ai-service`: The FastAPI AI service.

### 10.2 Optimized RAG Flow
The RAG system no longer uses Qdrant. It uses **PostgreSQL pgvector** exclusively to save RAM and simplify the architecture.

**Key Optimization**: The ingestion process now builds "Golden Records" by joining data from `skills`, `projects`, `experience`, `education`, and `certifications` tables, ensuring the AI has a 360-degree view of every employee.

**Initialize RAG Schema:**
```powershell
docker compose exec ai-service python -m app.rag.init_db
```

**Run Comprehensive Ingestion:**
```powershell
docker compose exec ai-service python -m app.rag.etl_ingest
```

**Start Chat Agent:**
```powershell
docker compose exec ai-service python -m app.rag.chat_agent
```
