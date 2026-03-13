# NextRH Project Status and Workflow Architecture

Generated: 2026-03-12 (local repo state)

## Scope
- This document reflects the current code and configuration in `c:\Users\islam\Projects\NextRH`.
- It focuses on runtime workflows and pipelines, not file tree structure.
- Key sources reviewed include `docker-compose.yml`, backend controllers/services, AI service modules, and the Docs/*.md references.

## Current Runtime Architecture (Docker Dev Stack)
The current `docker-compose.yml` defines the following runtime services:
- Postgres with pgvector (database and vector store)
- pgAdmin (DB admin UI)
- NestJS backend (API + orchestration)
- FastAPI AI service (parsing + RAG)
- Ollama (LLM + embeddings runtime)
- Ollama model pull helper (preloads models)
- ClamAV (virus scanning for uploads)
- React frontend (UI)

These services run on a shared Docker bridge network and use volumes for DB, models, and AV signatures. See `docker-compose.yml`.

## Core Workflows and Pipelines

### 1) Authentication and Onboarding Pipeline
1. Manager invites a user via `POST /auth/invite`.
2. Backend creates a pending user, creates or reuses the team, and generates an invitation token.
3. Email is sent with a setup link; invitation token validation is available via `GET /auth/validate-token`.
4. User sets password via `POST /auth/setup-password` and becomes active.
5. Login via `POST /auth/login` returns an access token and sets a refresh token cookie.
6. Token refresh uses `POST /auth/refresh`; logout uses `POST /auth/logout`.

Relevant code: `backend/src/auth/auth.controller.ts`, `backend/src/auth/auth.service.ts`, `backend/src/auth/invitations.service.ts`, `backend/src/teams/teams.service.ts`, `backend/src/mail/mail.service.ts`.

### 2) CV Upload and Parsing Pipeline
1. Employee uploads a CV via `POST /cv/upload`.
2. Backend validates file type/size and runs ClamAV scan if enabled.
3. Backend sends the file to AI service `POST /api/v1/parsing/cv`.
4. AI service runs deterministic TemplateCVParser and returns structured data.
5. Backend updates user name, stores file under `file-storage/CV_Database/<Name>_<id>/CV.*` and writes `metadata.json`.
6. Backend persists structured data to DB tables (profile, experience, education, certifications, projects) and stores a metadata snapshot.
7. Backend triggers RAG re-indexing for this user.

Relevant code: `backend/src/cv/cv.controller.ts`, `backend/src/cv/cv.service.ts`, `backend/src/file-validation/file-validation.service.ts`, `backend/src/file-storage/file-storage.service.ts`, `ai-service/app/api/parsing.py`, `ai-service/app/services/cv_parser.py`, `ai-service/app/parsers/template_parser.py`.

Note: Docs describe an AI service push to `/cv/process`, but the current flow is backend-driven. The `/cv/process` endpoint exists but is not used by the AI service in the current implementation.

### 3) Certification Upload and OCR Pipeline
1. Employee uploads a certificate via `POST /certifications/upload`.
2. Backend validates file and runs ClamAV scan if enabled.
3. Backend calls AI service `POST /api/v1/parsing/certification` with user name for verification.
4. AI service extracts text using Tesseract and optional EasyOCR, then runs an LLM extractor.
5. Backend writes the file to `file-storage/CV_Database/<Name>_<id>/Certificates/` and updates `metadata.json`.
6. Backend inserts or upgrades the certification record and marks it as uploaded.
7. Backend triggers RAG re-indexing for this user.

Relevant code: `backend/src/certifications/certifications.controller.ts`, `backend/src/certifications/certifications.service.ts`, `ai-service/app/ocr/certification_ocr.py`.

Note: Training proof uploads enforce name matching in backend. Regular certification uploads currently rely on AI service validation only, which logs mismatches but does not block. See `backend/src/training/training.service.ts`.

### 4) Training Assignment and Completion Pipeline
1. Manager assigns training via `POST /training/assign`.
2. Backend creates training rows, creates notifications for assignees, and sends email invitations.
3. Employee starts a training via `PATCH /training/:id/status` (status = in_progress).
4. Employee completes training via `PATCH /training/:id/status` or uploads proof via `POST /training/:id/proof`.
5. Proof upload calls AI certification parsing, writes file, creates a certification record, updates metadata, and notifies managers.

Relevant code: `backend/src/training/training.controller.ts`, `backend/src/training/training.service.ts`, `backend/src/notifications/notifications.service.ts`, `backend/src/mail/mail.service.ts`.

### 5) RAG Ingestion and Chat Pipeline
1. AI service initializes pgvector schema on startup.
2. Ingestion reads employee DB data plus `metadata.json`, merges records, and builds chunked embeddings.
3. Embeddings are stored in `employee_rag_vectors` in PostgreSQL.
4. Backend triggers RAG sync on CV and certification updates.
5. Chat is available via backend `POST /rag/chat`, which proxies to AI service `POST /api/v1/rag/chat` (currently set to using Qwen2.5 7b-instruct api from huggingface for production simulation).

Relevant code: `ai-service/app/rag/models.py`, `ai-service/app/rag/etl_ingest.py`, `ai-service/app/rag/chat_agent.py`, `ai-service/app/api/rag.py`, `backend/src/rag/rag.service.ts`.

### 6) CV Preview and PDF Export
1. Frontend fetches CV profile via `GET /cv/profile/me` or `GET /cv/profile/:employeeId`.
2. UI renders profile and can generate a PDF client-side using jsPDF.

Relevant code: `frontend/src/pages/employee/CVPreviewPage.tsx`, `backend/src/cv/cv.controller.ts`.

### 7) Notifications Pipeline
1. Backend creates notifications for training assignment, training status changes, and team additions.
2. Users fetch notifications via `GET /notifications/me` and can mark read or delete.

Relevant code: `backend/src/notifications/notifications.service.ts`, `backend/src/notifications/notifications.controller.ts`.

## State of Advancement (As-Is)

### End-to-end implemented
- Auth and invitation flow, with refresh tokens and email dispatch.
- CV upload, parsing, storage, and DB persistence.
- Certification upload with OCR and DB persistence.
- Training assignment and completion with notifications and proof upload.
- RAG ingestion with pgvector and backend-triggered sync.
- CV preview UI with client-side PDF export.

### Partially implemented or UI-only
- AI chat UI uses mock data and does not call backend RAG endpoints. See `frontend/src/pages/bid/AIChatPage.tsx`.
- CV generation UI is a stub using mock data and does not call backend or AI services. See `frontend/src/pages/bid/CVGenerationPage.tsx`.
- Manager and BID dashboards use mock data. See `frontend/src/pages/manager/ManagerDashboard.tsx` and `frontend/src/pages/bid/BIDDashboard.tsx`.
- Manager certification tracking and member profile pages use mock data. See `frontend/src/pages/manager/CertificationTrackingPage.tsx` and `frontend/src/pages/manager/MemberProfilePage.tsx`.
- Projects can be created from CV parsing but there is no API for manual CRUD, and the employee Projects tab is UI-only. See `backend/src/cv/cv.service.ts` and `frontend/src/pages/employee/TrainingProjectsPage.tsx`.
- Employees, skills, and projects modules exist as entities only (no controllers/services for CRUD). See `backend/src/employees`, `backend/src/skills`, `backend/src/projects`.

### Documented but not present in current code or compose
- n8n workflow automation, Redis/Bull queues, file watcher auto-sync, NextOra integration, and Nginx reverse proxy appear in `Docs/Project_structure.md` but are not present in the repo or `docker-compose.yml`.

## Database and Schema Evolution Status
- Initial schema is created by `database/init-scripts/*.sql` only on first container initialization.
- Ongoing schema changes are intended to use TypeORM migrations, but only one migration exists so far.
- Recent schema updates (project dates, generated title, team notification type) are currently in init scripts, which means existing DB volumes will not pick them up without a migration or a DB reset.

Relevant files: `Docs/BACKEND_WORKFLOW.md`, `database/init-scripts/*.sql`, `backend/src/database/migrations/1770655036875-invitation_table_and_user_status.ts`.

## Testing Status
- AI service has parser and OCR tests in `ai-service/tests`.
- No backend or frontend test suites are present in this repo.
