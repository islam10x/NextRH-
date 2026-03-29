PRODUCTION_RUNBOOK
==================

Scope
-----
This file documents production-related configuration and changes made during this
conversation. It is a practical runbook for the current stack and its operational
gotchas.

Stack (containers)
------------------
- frontend: Vite build served by nginx
- backend: NestJS API
- ai-service: FastAPI (OCR + RAG)
- postgres: pgvector/pgvector:pg14
- ollama: local LLM/embeddings
- clamav: antivirus daemon
- n8n: workflow automation

Primary compose file
--------------------
`docker-compose.prod.yml` is the production stack definition.

Key changes made (summary)
--------------------------
- Added `docker-compose.prod.yml` (prod stack without dev mounts).
- Frontend build + nginx reverse proxy for `/api` with `client_max_body_size 25m`.
- Backend CMD fixed to `node dist/src/main.js`, Node base updated to 20.
- ai-service Dockerfile uses Python 3.11 and disables auto-reload.
- Added/updated `.dockerignore` for frontend/backend.
- Hardened env handling (require DB_PASSWORD/JWT_SECRET, removed default secrets).
- Ollama puller updated to pull `RAG_CHAT_MODEL` and `EMBEDDING_MODEL`.
- RAG ingest now upserts by `chunk_id` to avoid duplicate key errors.
- Added AI endpoint to delete RAG vectors for a user.
- User delete now triggers RAG vector cleanup (best effort).
- Certification parsing: gated LLM fallback + embedded text preference to avoid OCR errors.
- Certification uploads now overwrite existing file with same cert name
  (applies to both direct certification uploads and training proof uploads).
- N8N VM-local access recommended using SSH tunnel (no public exposure).

Environment variables (prod)
----------------------------
Root `.env` (compose variables):
- `DB_PASSWORD`, `JWT_SECRET`
- `RAG_CHAT_MODEL`, `EMBEDDING_MODEL`
- `N8N_HOST`, `N8N_PROTOCOL`, `WEBHOOK_URL`, `N8N_TIMEZONE`
- Optional: `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`

Backend `.env` (mounted via `env_file`):
- DB: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- Auth: `JWT_SECRET`
- Frontend: `FRONTEND_URL`
- AI: `AI_SERVICE_URL` (must be set to `http://ai-service:8000`)
- ClamAV: `CLAMAV_ENABLED`, `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT`
- SMTP: `SMTP_*` for real email providers

AI service `.env` (optional):
- `DATABASE_URL` or DB_* fields
- `OLLAMA_URL`, `RAG_CHAT_MODEL`, `EMBEDDING_MODEL`
- `OCR_ENGINE` ("tesseract", "easyocr", "both")

Frontend build arg (in compose):
- `VITE_API_URL` defaults to `/api`

Deployment / update steps
-------------------------
1) Build and start (first time):
   - `docker-compose -f docker-compose.prod.yml up -d --build`

2) Rebuild a specific service:
   - `docker-compose -f docker-compose.prod.yml build backend`
   - `docker-compose -f docker-compose.prod.yml up -d --force-recreate backend`

3) When `.env` changes:
   - Always recreate affected container (env is loaded on create).

Known issues and fixes
----------------------
1) `docker compose` vs `docker-compose`:
   - The VM uses docker-compose v1.29.2. Some errors (ContainerConfig)
     require `docker-compose rm -sf <service>` then `up -d`.

2) RAG `fetch failed` from backend:
   - Verify `AI_SERVICE_URL` is set inside backend container.
   - Recreate backend after `.env` changes.

3) RAG ingest duplicate chunk_id errors:
   - Fixed via upsert in `ai-service/app/rag/etl_ingest.py`.

4) Missing DB columns:
   - Re-run init scripts manually with `psql` if the Postgres volume
     existed before scripts were added.

5) Ollama GPU error:
   - Remove GPU reservations if VM has no NVIDIA drivers.

6) N8N access:
   - Use localhost binding and SSH tunnel for VM-only access.

N8N configuration (VM-only)
---------------------------
Compose port binding:
- `127.0.0.1:5678:5678`

Recommended `.env` values:
- `N8N_HOST=localhost`
- `N8N_PROTOCOL=http`
- `WEBHOOK_URL=http://localhost:5678/`

Access from laptop:
- `ssh -L 5679:127.0.0.1:5678 sysadmin@<VM_IP>`
- Open `http://localhost:5679`

Certification parsing notes
---------------------------
Main factors:
- Embedded PDF text is preferred to avoid OCR misspellings.
- LLM now runs only when rule-based parsing looks incomplete.
- LLM cannot override a good parsed name unless it is missing/generic.

Certification upload overwrite
------------------------------
Uploads now overwrite existing cert files based on parsed certification name.
This applies to:
- `POST /certifications` uploads
- Training proof uploads

Behavior:
- New upload with same cert name replaces the existing file (no timestamped duplicates).

User deletion and RAG sync
--------------------------
Deletion via backend API now triggers:
- AI service endpoint `DELETE /api/v1/rag/vectors/{user_id}`
- Directory chunk refresh

Notes:
- Deleting directly from Postgres does NOT trigger this.
- If deletion happens in DB, manual cleanup is still required:
  `DELETE FROM employee_rag_vectors WHERE user_id = '<uuid>'`.

Operational checks
------------------
- Check AI service reachability:
  `docker-compose -f docker-compose.prod.yml exec backend node -e "fetch('http://ai-service:8000/').then(r=>console.log(r.status))"`
- Check Ollama models:
  `docker-compose -f docker-compose.prod.yml exec ollama ollama list`
- Check n8n:
  `docker-compose -f docker-compose.prod.yml ps n8n`

File system vs DB
-----------------
Manual file changes do not sync to DB. Only the app/API updates DB records.
Use backend endpoints for adds/removes, or build a dedicated watcher service
if automatic sync is required.

Observability (metrics + logs + traces)
---------------------------------------
Compose file:
- `docker-compose.observability.yml`

Services:
- Grafana, Prometheus, Loki, Tempo, OpenTelemetry Collector
- Promtail (Docker logs), node-exporter (host metrics), cAdvisor (container metrics)

Start:
- `docker-compose -f docker-compose.prod.yml -f docker-compose.observability.yml up -d`

Access (VM-only):
- Grafana is bound to `127.0.0.1:3001`
- Use SSH tunnel: `ssh -L 3001:127.0.0.1:3001 sysadmin@<VM_IP>`
- Open `http://localhost:3001`

Retention (7 days):
- Prometheus: `--storage.tsdb.retention.time=7d`
- Loki: `limits_config.retention_period=168h` + compactor retention enabled
- Tempo: `compactor.compaction.block_retention=168h`

OTLP endpoints (internal):
- Collector listens on `otel-collector:4317` (gRPC) and `otel-collector:4318` (HTTP)
- Apps must be instrumented to emit traces/logs/metrics

Backup strategy (baseline)
--------------------------
Primary data:
- Postgres data volume
- `file-storage/` (employee files + metadata)

Suggested schedule:
- Nightly Postgres backup:
  `docker-compose -f docker-compose.prod.yml exec -T postgres pg_dump -U postgres cv_management > /var/backups/cv_management_$(date +%F).sql`
- Nightly file storage archive:
  `tar -czf /var/backups/file-storage_$(date +%F).tgz file-storage`

Retention:
- Keep 7 days locally; optionally sync to off-VM storage.

Observability data:
- Loki/Tempo/Prometheus are 7-day retention by design. Backups are optional.
