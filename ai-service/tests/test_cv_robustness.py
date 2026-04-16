"""
Robustness test suite for cv_generator across all template types.
Tests both original and adversarial templates in a single run.

Usage:
    python tests/test_cv_robustness.py

Exit code: 0 = all passed, 1 = failures.
"""
import os
import sys
import tempfile
import shutil
import logging
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Keep logs clean in CI — only show WARNING+
logging.basicConfig(level=logging.WARNING)

from app.services.cv_generator import (
    _extract_all_text,
    _detect_personal_info,
    _identify_section_lxml,
    process_cv,
)
from lxml import etree

# ── Target employee data ─────────────────────────────────────────────────────

EMPLOYEE = {
    "name":  "Aya BEN JEMAA",
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
                "Supported the Web-Master IT department.\n"
                "Contributed to web development tasks."
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
            "description": "Cross-platform booking app with role-based access.",
        },
        {
            "name": "Churn Prediction Pipeline",
            "skills": ["Python", "Scikit-learn", "FastAPI", "Docker"],
            "description": "End-to-end ML system with automated feature engineering.",
        },
    ],
    "languages": ["French (Fluent)", "Arabic (Fluent)", "English (Fluent)"],
}

# ── Expected contact info in output ──────────────────────────────────────────

EXPECTED = {
    "email": EMPLOYEE["email"],
    "first_name": EMPLOYEE["name"].split()[0],
    "phone": EMPLOYEE["phone"],
}

# ── Template registry ─────────────────────────────────────────────────────────

TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), '..', 'test_templates')

TEMPLATES = [
    {
        "name": "Canadian (WPS sidebar)",
        "file": "124-modele-cv-canadien-1-2.docx",
        "expect_sections": {"summary", "experience", "education", "skills"},
        "must_not_delete": [],
    },
    {
        "name": "Jane Doe (standard)",
        "file": "Resume-JaneDoe.docx",
        "expect_sections": {"summary", "experience", "education", "skills", "projects"},
        "must_not_delete": ["Certifications & Hackathons"],
    },
    {
        "name": "Adversarial: table contact",
        "file": "adversarial_table_contact.docx",
        "expect_sections": {"summary", "experience", "education", "skills"},
        "must_not_delete": [],
    },
    {
        "name": "Adversarial: font-size headings",
        "file": "adversarial_fontsize_heading.docx",
        "expect_sections": {"summary", "experience", "education", "skills", "certifications"},
        "must_not_delete": [],
    },
    {
        "name": "Adversarial: Spanish",
        "file": "adversarial_spanish.docx",
        "expect_sections": {"summary", "experience", "education", "skills"},
        "must_not_delete": [],
    },
    {
        "name": "Adversarial: long preamble (contact after 6000 chars)",
        "file": "adversarial_long_preamble.docx",
        "expect_sections": {"summary", "experience", "education", "skills"},
        "must_not_delete": [],
    },
    {
        "name": "Adversarial: textbox sections (infographic/2-col)",
        "file": "adversarial_textbox_sections.docx",
        "expect_sections": {"summary", "experience", "education", "skills", "certifications"},
        "must_not_delete": [],
    },
]

# ── Test runner ───────────────────────────────────────────────────────────────

def run_template_test(template_info: dict) -> dict:
    """Test one template. Returns {name, passed, failures}."""
    name = template_info["name"]
    template_path = os.path.join(TEMPLATES_DIR, template_info["file"])
    must_not_delete = template_info.get("must_not_delete", [])

    if not os.path.exists(template_path):
        return {
            "name": name,
            "passed": False,
            "failures": [f"Template file not found: {template_info['file']}"],
        }

    failures = []
    tmpdir = tempfile.mkdtemp()
    try:
        t0 = time.time()
        result_path = process_cv(
            template_path=template_path,
            employee_data=EMPLOYEE,
            output_dir=tmpdir,
            output_pdf=False,
        )
        elapsed = time.time() - t0

        if not result_path or not os.path.exists(result_path):
            failures.append("process_cv returned no output file")
            return {"name": name, "passed": False, "failures": failures}

        # ── Check 1: contact info in output ──────────────────────────────
        output_text, output_paras = _extract_all_text(result_path)

        for key, val in EXPECTED.items():
            if val.lower() not in output_text.lower():
                failures.append(f"MISSING {key}: '{val}' not found in output")

        # ── Check 2: old contact info not still in output ─────────────────
        # (not applicable for generic check — differs per template)

        # ── Check 3: must_not_delete sections still present ───────────────
        for section_heading in must_not_delete:
            if section_heading.lower() not in output_text.lower():
                failures.append(f"Section '{section_heading}' was wrongly removed")

        print(
            f"  {'✓' if not failures else '✗'} {name:<45}  "
            f"{len(output_paras)} paragraphs  {elapsed:.1f}s"
            + (f"  FAILURES: {failures}" if failures else "")
        )

    except Exception as exc:
        failures.append(f"Exception during generation: {exc}")
        print(f"  ✗ {name:<45}  EXCEPTION: {exc}")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    return {"name": name, "passed": len(failures) == 0, "failures": failures}


# ── Section detection unit tests ─────────────────────────────────────────────

def test_section_detection():
    """Unit-test _identify_section_lxml for font-size-only headings."""
    from app.services.cv_generator import NS_W
    W = NS_W
    failures = []

    def _make_para(text, bold=False, heading_style=None, sz_half_pts=None):
        """Build a minimal <w:p> element."""
        p = etree.Element(f'{{{W}}}p')
        ppr = etree.SubElement(p, f'{{{W}}}pPr')
        if heading_style:
            pstyle = etree.SubElement(ppr, f'{{{W}}}pStyle')
            pstyle.set(f'{{{W}}}val', heading_style)
        r = etree.SubElement(p, f'{{{W}}}r')
        rpr = etree.SubElement(r, f'{{{W}}}rPr')
        if bold:
            etree.SubElement(rpr, f'{{{W}}}b')
        if sz_half_pts:
            sz = etree.SubElement(rpr, f'{{{W}}}sz')
            sz.set(f'{{{W}}}val', str(sz_half_pts))
        t = etree.SubElement(r, f'{{{W}}}t')
        t.text = text
        return p

    cases = [
        # (description, text, bold, heading_style, sz, expected_section)
        ("Bold 'Experience'",       "Experience",          True,  None,         None, "experience"),
        ("Heading style 'Skills'",  "Skills",              False, "Heading 2",  None, "skills"),
        ("ALL-CAPS 'EDUCATION'",    "EDUCATION",           False, None,         None, "education"),
        ("14pt 'Projects'",         "Projects",            False, None,         28,   "projects"),
        ("13pt 'Certifications'",   "Certifications",      False, None,         26,   "certifications"),
        ("12pt body text (None)",   "See attached",        False, None,         24,   None),
        ("Spanish 'Experiencia'",   "Experiencia",         True,  None,         None, "experience"),
        ("Spanish 'Educación'",     "Educación",           True,  None,         None, "education"),
        ("Spanish 'Habilidades'",   "Habilidades",         True,  None,         None, "skills"),
        ("DE 'Berufserfahrung'",    "Berufserfahrung",     True,  None,         None, "experience"),
        ("Sub-heading (colon)",     "Technologies:",       True,  None,         None, None),
        ("Long text (skipped)",     "A " * 35,             True,  None,         None, None),
    ]

    print("\n=== Section Detection Unit Tests ===")
    for desc, text, bold, hstyle, sz, expected in cases:
        p = _make_para(text.strip(), bold=bold, heading_style=hstyle, sz_half_pts=sz)
        result = _identify_section_lxml(p)
        ok = result == expected
        if not ok:
            failures.append(f"  FAIL [{desc}]: expected={expected!r} got={result!r}")
        print(f"  {'✓' if ok else '✗'} {desc:<38} -> {result!r}")

    return failures


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print("=" * 70)
    print("CV Generator Robustness Test Suite")
    print("=" * 70)

    # Section detection unit tests (fast, no API calls)
    unit_failures = test_section_detection()

    # Integration tests (hit Groq API)
    print("\n=== Integration Tests (Groq API) ===")
    all_results = []
    for tmpl in TEMPLATES:
        r = run_template_test(tmpl)
        all_results.append(r)

    # Summary
    passed = sum(1 for r in all_results if r["passed"])
    total = len(all_results)
    print("\n" + "=" * 70)
    print(f"Integration: {passed}/{total} templates passed")
    print(f"Unit tests: {len(unit_failures)} failures")
    print("=" * 70)

    for r in all_results:
        if not r["passed"]:
            print(f"\n  FAILED: {r['name']}")
            for f in r["failures"]:
                print(f"    - {f}")

    for f in unit_failures:
        print(f)

    overall_ok = passed == total and len(unit_failures) == 0
    sys.exit(0 if overall_ok else 1)
