# File Upload Safety Guide
Plain-English notes on how we protect uploads (type, size, virus scan) and how to try it yourself.

## What we check
- **File type allow-list:** PDFs, Word `.docx`, PNG, JPEG. Exact MIME values: `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `image/png`, `image/jpeg`.
- **Size cap:** 10 MB by default. Change with `MAX_UPLOAD_BYTES` in `backend/.env` (value is in bytes).
- **Virus scan:** When `CLAMAV_ENABLED=true`, every file is scanned via ClamAV before we accept it.

## Where the logic lives
- Validator: `backend/src/file-validation/file-validation.service.ts` (handles type, size, and virus scan).
- Constants: `backend/src/file-validation/file-validation.constants.ts`.
- Endpoint: `POST /cv/upload` (Multer field name `file`). Needs a JWT with the `EMPLOYEE` role.

## Run ClamAV locally
1) Start it: `docker compose up -d clamav`
2) Check health: `docker compose ps clamav` → should show `healthy`
3) Optional ping: `echo PING | nc 127.0.0.1 3310` → expect `PONG`

> We use `clamav/clamav:stable`, store signatures in `clamav-db`, and cap RAM at 1 GB.

## Backend env for local dev
```
CLAMAV_ENABLED=true
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310
CLAMAV_TIMEOUT=60000
MAX_UPLOAD_BYTES=10485760   # 10 MB
```
Start API: `cd backend && npm run start:dev`

## Quick test plan (Postman)
- Method: `POST`
- URL: `http://localhost:3000/cv/upload`
- Headers: `Authorization: Bearer <JWT>`
- Body: `form-data`, key `file` (type File). You can edit the file row’s **Content-Type** to force a MIME.

| Scenario | File | Content-Type | Expect |
| --- | --- | --- | --- |
| Happy path | `sample.pdf` | `application/pdf` | 200 OK |
| Blocked type | `note.txt` | `text/plain` | 400 "Unsupported file type" |
| Too big | `big.pdf` (~11 MB) | `application/pdf` | 400 "File exceeds 10 MB limit" |
| Malware (EICAR) | `eicar.txt` | `application/pdf` (allowed) | 400 "malware detected ..." |
| Control after EICAR | `sample.pdf` | `application/pdf` | 200 OK |

## Make the test files (PowerShell, repo root)
```
# Clean sample PDF
curl -o sample.pdf https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf

# Blocked type
Set-Content -Path note.txt -Value "hello text"

# Oversize (~11 MB)
python - <<'PY'
open('big.pdf','wb').write(b'0'*11000000)
PY

# EICAR signature
python - <<'PY'
open('eicar.txt','w').write("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")
PY
```

## If something feels off
- 404 on auth/login: check the URL (no trailing space) and that the backend runs on port 3000.
- Virus scan skipped: confirm `CLAMAV_ENABLED=true` and the ClamAV container is `healthy`.
- Connection errors: `Test-NetConnection localhost -Port 3310`; if needed, `docker restart cv-clamav`.
- First scans right after starting AV can be slow while signatures finish updating.
