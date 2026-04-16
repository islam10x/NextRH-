"""
Test CV Generator Direct Mode
=============================
Tests the direct text replacement mode for templates without placeholders.
"""
import os
import sys
import tempfile
import zipfile

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.cv_generator import (
    _extract_all_text,
    _detect_personal_info,
    _build_replacements,
    process_cv,
)


def test_text_extraction(docx_path: str):
    """Test that text extraction captures all content including textboxes."""
    print(f"\n=== Testing Text Extraction: {os.path.basename(docx_path)} ===")
    
    full_text, paragraphs = _extract_all_text(docx_path)
    print(f"Extracted {len(paragraphs)} paragraphs, {len(full_text)} chars")
    
    print("\n--- Paragraph-level text (first 40) ---")
    for i, p in enumerate(paragraphs[:40]):
        print(f"  [{i:2d}] {p!r}")
    
    return full_text, paragraphs


def test_personal_info_detection(full_text: str, paragraphs: list):
    """Test personal info detection patterns."""
    print("\n=== Testing Personal Info Detection ===")
    
    detected = _detect_personal_info(full_text, paragraphs)
    print(f"Detected {len(detected)} fields:")
    for field, value in detected.items():
        print(f"  {field}: {value}")
    
    return detected


def test_full_generation(template_path: str, employee_data: dict, output_dir: str):
    """Test full CV generation pipeline."""
    print(f"\n=== Testing Full Generation ===")
    print(f"Template: {template_path}")
    print(f"Employee: {employee_data.get('name')}")
    
    result = process_cv(
        template_path=template_path,
        employee_data=employee_data,
        output_dir=output_dir,
        output_pdf=False,
    )
    
    print(f"Output: {result}")
    
    # Verify output has replacements
    if os.path.exists(result):
        output_text, output_paras = _extract_all_text(result)
        print(f"\n--- Output paragraphs (first 40) ---")
        for i, p in enumerate(output_paras[:40]):
            print(f"  [{i:2d}] {p!r}")
        
        # Check if employee data appears
        checks = [
            ('email', employee_data.get('email')),
            ('name', employee_data.get('name', '').split()[0] if employee_data.get('name') else None),
            ('phone', employee_data.get('phone')),
        ]
        for label, val in checks:
            if val and val in output_text:
                print(f"\n  OK  {label}: '{val}' found in output")
            elif val:
                print(f"\n  FAIL  {label}: '{val}' NOT found in output")
    
    return result


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO)
    
    # Check for template argument
    if len(sys.argv) < 2:
        print("Usage: python test_cv_generator_direct.py <template.docx>")
        print("\nThis will test text extraction and personal info detection.")
        sys.exit(1)
    
    template_path = sys.argv[1]
    if not os.path.exists(template_path):
        print(f"Error: Template not found: {template_path}")
        sys.exit(1)
    
    # Test extraction
    full_text, paragraphs = test_text_extraction(template_path)
    
    # Test detection
    detected = test_personal_info_detection(full_text, paragraphs)
    
    # Test full generation with sample employee data
    # Use Aya BEN JEMAA's real data (from the PDF shown)
    employee_data = {
        "name": "Aya BEN JEMAA",
        "email": "aya.benjemaa@nextstep.tn",
        "phone": "+216 98 772 817",
        "title": "Software Engineer",
        "linkedin": "linkedin.com/in/ayabenjemaa",
        "address": "Tunis, Tunisia",
        "summary": (
            "Top-ranking Software Engineering student specializing in Intelligent "
            "Information Systems. Proven track record in building scalable Full-stack "
            "applications, Machine Learning pipelines, and Big Data architectures."
        ),
        "skills": ["Python", "Java", "JavaScript", "React", "Node.js", "Docker", "Git", "SQL", "MongoDB"],
        "experience": [
            {
                "title": "Webmaster Intern",
                "company": "Cap Bon Electronique (Numedia)",
                "dates": "June/2025 - July/2025",
                "description": (
                    "Supported the Web-Master IT department in maintaining internal information systems.\n"
                    "Contributed to web development tasks and system maintenance.\n"
                    "Provided technical assistance to staff."
                ),
            }
        ],
        "education": [
            {
                "degree": "BSc in Software Engineering",
                "institution": "Horizon School of Digital Tech",
                "dates": "2023 - 2026",
            }
        ],
        "certifications": [
            "NVIDIA Prompt Engineering",
            "Advanced Linux",
            "Python - University of Michigan",
        ],
        "projects": [
            {
                "name": "LuxuriousStays",
                "skills": ["React Native", "Node.js", "TypeScript"],
                "description": "Cross-platform booking app with role-based access and QR code integration.",
            },
            {
                "name": "Churn Prediction Pipeline",
                "skills": ["Python", "Scikit-learn", "FastAPI", "Docker"],
                "description": "End-to-end ML system with automated feature engineering.",
            },
        ],
        "languages": ["French (Fluent)", "Arabic (Fluent)", "English (Fluent)", "Spanish (Basic)"],
    }
    
    with tempfile.TemporaryDirectory() as tmpdir:
        result = test_full_generation(template_path, employee_data, tmpdir)
        
        if result:
            # Copy to current directory for inspection
            output_name = os.path.basename(result)
            import shutil
            final_path = os.path.join(os.path.dirname(template_path), f"TEST_{output_name}")
            shutil.copy2(result, final_path)
            print(f"\n=== Test output saved to: {final_path} ===")
