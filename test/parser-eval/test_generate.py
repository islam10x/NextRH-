import json
import requests

API_URL = "http://127.0.0.1:8000/api/v1/generation/cv"
TEMPLATE = "Document 1.docx"

DUMMY_PROFILE = {
    "name": "EVAL_NAME_JOHN EVAL_NAME_DOE",
    "email": "eval_email@evaldomain.com",
    "phone": "999-EVAL-PHONE",
    "title": "EVAL_TITLE_ENGINEER",
    "address": "EVAL_ADDRESS_CITY",
    "linkedin": "linkedin.com/in/eval_linkedin",
    "summary": "EVAL_SUMMARY_PROFESSIONAL",
    "skills": [{"name": "EVAL_SKILL_PYTHON"}, {"name": "EVAL_SKILL_REACT"}],
    "experience": [
        {
            "title": "EVAL_EXP_ROLE",
            "company": "EVAL_EXP_COMP",
            "dates": "2020 - 2023",
            "description": "EVAL_EXP_DESC"
        }
    ],
    "education": [
        {
            "degree": "EVAL_EDU_DEG",
            "institution": "EVAL_EDU_UNI",
            "dates": "2015 - 2019"
        }
    ],
    "languages": [{"name": "EVAL_LANG_EN"}],
    "certifications": [{"name": "EVAL_CERT_AWS"}]
}

with open(f"c:/Users/islam/Projects/NextRH-/test/test-templates/{TEMPLATE}", "rb") as f:
    files = {"template": (TEMPLATE, f, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}
    data = {
        "employee_data": json.dumps(DUMMY_PROFILE),
        "engine": "fallback",
        "output_format": "docx",
        "debug": "true"
    }
    resp = requests.post(API_URL, files=files, data=data)

with open("test_out.docx", "wb") as f:
    f.write(resp.content)
print(f"Generated test_out.docx with status {resp.status_code}")
print("Warnings:", resp.headers.get("X-CV-Warnings"))
