import logging
import sys

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(levelname)s - %(message)s')

sys.path.insert(0, r"c:\Users\islam\Projects\NextRH-\ai-service")
from app.services.cv_generator_fallback import process_cv

TEMPLATE = r"c:\Users\islam\Projects\NextRH-\test\test-templates\Document 1.docx"

DUMMY_PROFILE = {
    "name": "EVAL_NAME_JOHN EVAL_NAME_DOE",
    "email": "eval_email@evaldomain.com",
    "phone": "999-EVAL-PHONE",
    "title": "EVAL_TITLE_ENGINEER",
    "address": "EVAL_ADDRESS_CITY",
    "linkedin": "linkedin.com/in/eval_linkedin",
    "summary": "EVAL_SUMMARY_PROFESSIONAL",
    "skills": ["EVAL_SKILL_PYTHON", "EVAL_SKILL_REACT"],
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
    "languages": ["EVAL_LANG_EN"],
    "certifications": ["EVAL_CERT_AWS"]
}

print("Running process_cv...")
out_path = process_cv(
    template_path=TEMPLATE,
    employee_data=DUMMY_PROFILE,
    output_dir=".",
    debug=True
)
print("Saved to", out_path)
