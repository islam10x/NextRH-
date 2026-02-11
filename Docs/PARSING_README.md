# CV Parsing System Documentation

## 1. Overview
The CV Parsing System is a high-performance, deterministic parsing solution designed to extract structured data from CVs that follow a specific template (PDF or DOCX).

It replaces traditional LLM-based extraction with a faster, lower-resource approach using:
- **PyMuPDF (fitz)**: For precise text and layout extraction from PDFs.
- **Regex Mapping**: For identifying fields like Email, Phone, and Dates.
- **Section Heuristics**: For reliably identifying sections (Experience, Education usually follow specific headers).

## 2. Architecture Flow

1.  **User Upload**: Client sends a `POST` request to AI Service with the CV file and `user_id`.
2.  **AI Service (FastAPI)**:
    *   receives file.
    *   `TemplateCVParser` extracts text.
    *   Parses Contact, Experience, Education, Certifications using regex/keywords.
    *   Saves a local snapshot: `uploads/{filename}_metadata.json`.
3.  **Backend Integration**:
    *   AI Service sends JSON payload to Backend (`POST /cv/process`).
4.  **Backend (NestJS)**:
    *   `CvService` receives data.
    *   Updates `User` table (First/Last Name).
    *   Finds/Creates `EmployeeProfile`.
    *   Saves `MetadataSnapshot`.
    *   Populates `WorkExperience`, `Education`, `Certification` tables.

## 3. How Parsing Works
The parser (`TemplateCVParser`) looks for specific bilingual headers (English/French):

*   **Contact**: Extracted via Regex from the top section.
*   **Experience**: Look for headers `Expérience`, `Experience Professional`, etc.
    *   *Logic*: Iterates line-by-line using spacing/boldness to identify distinct roles.
*   **Education**: Look for headers `Formation`, `Education`.
*   **Certifications**: Look for headers `Certification`, `Certificates`.
    *   *Logic*: Uses date regex to separate certification name from the date.

## 4. How to Run & Test

### Prerequisites
*   **AI Service** running on port `8000`.
*   **Backend** running on port `3000`.
*   **Postgres DB** running.

### Step 1: Start Services
**AI Service**:
```bash
cd ai-service
./run_local.bat
```

**Backend**:
```bash
cd backend
npm run start:dev
```

### Step 2: Test via Swagger UI
1.  Open the AI Service Docs: [http://localhost:8000/docs](http://localhost:8000/docs)
2.  Find `POST /api/v1/parsing/cv`.
3.  Click **Try it out**.
4.  **Form Fields**:
    *   `file`: select your `CV.pdf`.
    *   `user_id`: Enter a valid UUID from your database (e.g., `5777a724-e6be-4a21-a497-d5ff8d799901`).
5.  Click **Execute**.

### Step 3: Verify Results
**Check Response**:
The API should return a JSON object with:
```json
{
  "structured_data": { ... },
  "metadata": { ... },
  "filename": "..."
}
```

**Check Database**:
Run the following SQL to see if the data persisted:
```sql
-- Check User Name Update
SELECT first_name, last_name FROM users WHERE user_id = 'YOUR_UUID';

-- Check Profile Creation
SELECT * FROM employee_profiles WHERE user_id = 'YOUR_UUID';

-- Check Experience Data
SELECT * FROM work_experience WHERE profile_id = (SELECT profile_id FROM employee_profiles WHERE user_id = 'YOUR_UUID');
```
