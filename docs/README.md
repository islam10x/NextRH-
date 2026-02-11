# NextRH - CV/Certificate Parsing Setup

## Overview
This project uploads employee CVs/certificates, parses document content, and stores structured metadata in:

- `file-storage/CV_Database/<Employee_Name>/CV.<ext>`
- `file-storage/CV_Database/<Employee_Name>/Certificates/<file>`
- `file-storage/CV_Database/<Employee_Name>/metadata.json`

`metadata.json` format:

```json
{
  "name": "Houda Ben Ali",
  "skills": ["Python", "AWS", "AI"],
  "certifications": [
    {
      "name": "AWS Solutions Architect",
      "status": "active",
      "expiration": "2026-03-15"
    }
  ],
  "experience_years": 5,
  "last_update": "2026-01-20"
}
```

## Tools Used
- Backend: NestJS
- Frontend: React + Vite
- DB: PostgreSQL (`pgvector` image)
- Text extraction: PyMuPDF
- OCR: Tesseract (`eng`, `fra`, `osd`)
- Optional parser fallback: Apache Tika (via `TIKA_JAR_PATH`)
- LLM extraction: Ollama (`qwen2.5:3b-instruct` by default)

## Prerequisites
Install locally:
- Docker Desktop
- Ollama (Windows installer)

## 1) Ollama Setup (Host)
Start Ollama and pull model:

```powershell
& "C:\Users\Rania\AppData\Local\Programs\Ollama\ollama.exe" serve
```

In another terminal:

```powershell
& "C:\Users\Rania\AppData\Local\Programs\Ollama\ollama.exe" pull qwen2.5:3b-instruct
& "C:\Users\Rania\AppData\Local\Programs\Ollama\ollama.exe" list
```

Expected: model appears in list.

## 2) Backend Environment
`backend/.env` should include:

```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=change_me
DB_NAME=cv_management
JWT_SECRET=super-secret-key-change-me-in-production
FRONTEND_URL=http://localhost:5173

OLLAMA_ENABLED=true
OLLAMA_URL=http://host.docker.internal:11434
OLLAMA_MODEL=qwen2.5:3b-instruct

# Optional
# TIKA_JAR_PATH=/app/tools/tika-app.jar
# TESSERACT_LANG=eng+fra
```

## 3) Build and Run
From project root:

```powershell
docker compose up --build -d
```

## 4) Runtime Validation
### A. Backend can reach Ollama
```powershell
docker compose exec backend sh -lc "wget -qO- http://host.docker.internal:11434/api/tags"
```
Expected: includes `qwen2.5:3b-instruct`.

### B. OCR languages in backend container
```powershell
docker compose exec backend sh -lc "tesseract --list-langs"
```
Expected: `eng`, `fra`, `osd`.

### C. PyMuPDF available in backend container
```powershell
docker compose exec backend sh -lc "python3 -c 'import fitz; print(1)'"
```
Expected: prints `1`.

## 5) Upload Flow Rules
1. Upload CV first.
2. Employee folder name is derived from CV content parsing.
3. Certificates are uploaded into `Certificates/` under same employee folder.
4. `metadata.json` is updated after each upload.

## 6) Troubleshooting
### Upload returns 400
Check backend logs:

```powershell
docker compose logs --tail=200 backend
```

### Nothing written to `file-storage/CV_Database`
- Ensure upload request is authenticated.
- Verify backend container is running and receives request.
- Verify parsed name is available (or fallback kicks in).

### Wrong certificate expiration date
- Re-upload certificate after OCR/LLM checks above pass.
- Ensure certificate text contains expiry cue (`expires`, `valid until`, `date d'expiration`, etc.).

### Clear backend build cache and rebuild
```powershell
docker compose rm -sf backend
docker image rm nextrh-backend -f
docker builder prune -af
docker compose build --no-cache backend
docker compose up -d backend
```

## 7) Key Storage/Parsing Files
- `backend/src/file-storage/file-storage.service.ts`
- `backend/src/file-storage/file-storage.controller.ts`
- `backend/Dockerfile`
- `backend/.env`
- `docker-compose.yml`
