# RAG Accuracy Improvements

This document describes the RAG accuracy improvements made to the `ai-service` module and the commands to test them.

---

## Overview of What Changed

The RAG system has been significantly improved to eliminate hallucination, cross-employee confusion, and missing project data. The changes span three files:

| File | What Changed |
|------|-------------|
| `ai-service/app/rag/models.py` | Removed `UNIQUE` constraint on `user_id`; added `chunk_id` column |
| `ai-service/app/rag/etl_ingest.py` | Per-section chunking, fragment-merge for certs, global directory chunk |
| `ai-service/app/rag/chat_agent.py` | Name-aware retriever, same-name disambiguation, stricter prompts |

---

## 1. Per-Section Chunking (etl_ingest.py)

**Problem:** One giant text blob per employee caused the model to miss details buried in large sections.

**Fix:** Each employee's data is now split into focused separate chunks stored as individual rows:

| Chunk ID suffix | Content |
|-----------------|---------|
| `_profile` | Name, position, experience summary, email |
| `_skills` | All technical skills |
| `_certifications` | All certifications (with cert-name cleanup) |
| `_experience` | Work history with company, title, dates |
| `_education` | Degrees, institutions, years |
| `_projects` | Client projects delivered |
| `__directory__` | Global roster of all employees (special chunk) |

Every bullet in every chunk is **prefixed with the employee's full name** (e.g. `- Anouar ABDALLAH: CCNP Security`) to prevent the model from misattributing facts.

---

## 2. Cert Name Fragment Merging (etl_ingest.py)

**Problem:** The PDF parser splits multi-line cert names across separate lines, producing junk entries like:

```
"Cisco CCNP Routing & Switching (300-135)"
"Troubleshooting"   ← dangling fragment
"Routing"           ← dangling fragment
```

**Fix:** The `_is_cert_fragment()` function detects and merges single-word/no-digit entries back into the preceding cert:

```
"Cisco CCNP Routing & Switching (300-135) Troubleshooting"  ← merged ✓
```

This applies to both the payload from `metadata.json` **and** cert entries loaded from the PostgreSQL `certifications` table.

> **Note:** The root cause (inside `template_parser.py`) is not yet fixed — new CV uploads will still produce fragmented entries, but they will be cleaned at the RAG ingestion stage.

---

## 3. Global Directory Chunk (etl_ingest.py)

**Problem:** Cosine similarity cannot answer "how many employees do we have?" because it never sees all employees at once.

**Fix:** A special `__directory__` chunk is always kept up to date. It lists every employee:

```
Employee Directory — 3 employee(s) total:
- Anouar ABDALLAH (Security Consultant, ~0 years experience, email: ...)
- Aya BEN JEMAA (Network Engineer, ~0 years experience, email: ...)
- Jazil Gafsi (IT Manager, ~0 years experience, email: ...)
```

This chunk is automatically refreshed:
- After every individual `ingest_employee()` call (triggered by CV upload/cert upload)
- After every bulk `python -m app.rag.etl_ingest` run

---

## 4. Name-Aware Smart Retriever (chat_agent.py)

**Problem:** Pure cosine similarity retrieves the top-K most similar chunks globally. Asking "what projects did Anouar work on?" could return Jazil's experience chunk (which mentions "Chef de projet") instead of Anouar's projects chunk.

**Fix:** The `PostgresRetriever` now runs in two phases:

**Phase 1 — Name detection:**
- Loads all employee profile chunks and extracts their names
- If the query mentions a name (e.g. "Anouar", "Aya"), **all** of that employee's chunks (profile, skills, certs, experience, education, projects) are force-included
- Phase 2 is **skipped entirely** when a specific employee is found — eliminating cross-employee contamination

**Phase 2 — Cosine similarity fill (general queries only):**
- Used only when no specific employee is mentioned (e.g. "who has a Fortinet cert?")
- Fetches top-K most relevant chunks from all employees

---

## 5. Same-Name Disambiguation (chat_agent.py)

**Problem:** Two employees named "Mohamed" would be confused by the retriever and the model.

**Fix:** When the name-detection phase finds multiple employees matching the same name word, it:
1. Includes **all** matching employees' chunks
2. Prepends a `[DISAMBIGUATION REQUIRED]` notice to the context listing all matches with their emails
3. The model's system prompt (Rule 8) forces it to ask the user to clarify which person they mean

Example context notice:
```
[DISAMBIGUATION REQUIRED] Multiple employees share a similar name.
You MUST ask the user to clarify which person they mean by email or full name.
The matching employees are:
  - Mohamed Ali (email: m.ali@company.com)
  - Mohamed Karim (email: m.karim@company.com)
```

---

## 6. Automatic RAG Sync on CV/Cert Upload

The RAG index is automatically re-synced whenever employee data changes:

- `CvService.saveEmployeeCv` → calls `ragService.triggerUserSync(userId)`
- `CertificationsService.saveEmployeeFile` → calls `ragService.triggerUserSync(employeeId)`

The backend calls `POST /api/v1/rag/sync/{user_id}` on the AI service, which runs `ingest_employee()` as a background task.

---

## Testing Commands

All commands assume you are in `NextRH/ai-service/` with the virtualenv activated:

```powershell
cd ai-service
venv\Scripts\activate
```

### Step 1 — Verify DB has employees with profiles

```powershell
docker exec -it cv-postgres psql -U postgres -d cv_management -At -c `
  "SELECT u.first_name, u.last_name, u.user_id FROM users u JOIN employee_profiles ep ON ep.user_id = u.user_id;"
```

Expected: at least one row per uploaded CV.

### Step 2 — Run ingestion (rebuilds all chunks + directory)

```powershell
python -m app.rag.etl_ingest
```

Expected output:
```
[OK] Re-indexed <uuid> (First Last) — 5 chunks
[OK] Directory chunk updated — N employees listed
Done. processed=N, skipped=0, total=N
```

### Step 3 — Verify chunks in the DB

```powershell
# Check chunk types for a specific employee
docker exec -it cv-postgres psql -U postgres -d cv_management -At -c `
  "SELECT chunk_id FROM employee_rag_vectors WHERE chunk_id NOT LIKE '%__directory__%' LIMIT 20;"

# Check directory chunk exists
docker exec -it cv-postgres psql -U postgres -d cv_management -At -c `
  "SELECT LEFT(content, 300) FROM employee_rag_vectors WHERE chunk_id = '__directory__';"

# Check certs are clean (no standalone 'Troubleshooting' etc.)
docker exec -it cv-postgres psql -U postgres -d cv_management -At -c `
  "SELECT content FROM employee_rag_vectors WHERE chunk_id LIKE '%_certifications' LIMIT 1;"
```

### Step 4 — Start the chat agent

```powershell
python -m app.rag.chat_agent
```

Expected startup output:
```
[chat_agent] Using LLM: qwen2.5:1.5b-instruct
Bid Manager ready. Type 'exit' to quit.
```

### Step 5 — Test queries

| Query | Expected behaviour |
|-------|--------------------|
| `how many employees do we have?` | Lists all employees from directory chunk |
| `what certifications does Anouar have?` | Shows only Anouar's certs, no other employees' data |
| `what projects did Aya work on?` | Shows Aya's full project list |
| `who has a Fortinet certification?` | Returns the correct employee with Fortinet cert |
| `give me all employees` | Lists all employees from directory chunk |
| `what certifications does Mohamed have?` | If 2 employees named Mohamed exist, asks for clarification |

### Step 6 — Test automatic sync (after uploading a CV or cert via the UI)

After upload, check the AI service logs for:
```
[OK] Re-indexed <uuid> (First Last) — 5 chunks
[OK] Directory chunk updated — N employees listed
```

This confirms the RAG was updated automatically without manual re-ingestion.

---

## Schema Reference

### `employee_rag_vectors` table

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'employee_rag_vectors'
ORDER BY ordinal_position;
```

| Column | Type | Notes |
|--------|------|-------|
| `id` | integer | auto-increment PK |
| `user_id` | uuid | Employee UUID (not unique — multiple chunks per user) |
| `chunk_id` | text | Unique per chunk e.g. `<uuid>_certifications` |
| `content` | text | Human-readable text sent to the model |
| `metadata_json` | jsonb | `chunk_type`, `user_id`, `name`, etc. |
| `embedding` | vector | 768-dim embedding from `nomic-embed-text` |
