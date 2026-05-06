"""
Tests that empty sections (heading + content) are completely removed from
the rendered DOCX when the corresponding data list is empty.

Strict mode is the default (CV_TEMPLATE_REMOVE_EMPTY_SECTIONS=1).  The legacy
"keep heading + show N/A" mode is still available behind the env flag.
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from docx import Document
from docxtpl import DocxTemplate

from app.services.template_tagger import auto_tag_template


def _make_template_docx(path: str) -> None:
    """Create a minimal CV template with three sections: Experience, Skills, Education."""
    doc = Document()
    # Header
    doc.add_paragraph("John Doe")
    doc.add_paragraph("john@example.com")
    # Experience
    doc.add_heading("Experience", level=1)
    doc.add_paragraph("2020 - 2023")
    doc.add_paragraph("ACME Corp")
    doc.add_paragraph("Senior Developer")
    doc.add_paragraph("Built lots of cool stuff.")
    # Skills
    doc.add_heading("Skills", level=1)
    doc.add_paragraph("Python, JavaScript, SQL")
    # Education
    doc.add_heading("Education", level=1)
    doc.add_paragraph("2015 - 2019")
    doc.add_paragraph("MIT")
    doc.add_paragraph("BSc Computer Science")
    doc.save(path)


_DEFAULTS = {
    "section_titles": {},
    "open_end_label": "Present",
    "skills": [],
    "work_experiences": [],
    "educations": [],
    "certifications": [],
    "projects": [],
    "languages": [],
    "awards": [],
    "interests": [],
    "volunteer": [],
    "references": [],
}


def _render(template_path: str, context: dict) -> Document:
    """Render the tagged template with *context*, return the resulting Document."""
    out_path = template_path.replace(".docx", "_out.docx")
    full_ctx = {**_DEFAULTS, **context}
    tpl = DocxTemplate(template_path)
    tpl.render(full_ctx)
    tpl.save(out_path)
    return Document(out_path), out_path


def _all_text(doc: Document) -> str:
    return "\n".join(p.text for p in doc.paragraphs)


@pytest.fixture
def template_path():
    d = tempfile.mkdtemp(prefix="cv_tag_test_")
    p = os.path.join(d, "template.docx")
    _make_template_docx(p)
    yield p


@pytest.fixture(autouse=True)
def _reset_env(monkeypatch):
    # Ensure we always start with the strict default unless a test overrides.
    monkeypatch.delenv("CV_TEMPLATE_REMOVE_EMPTY_SECTIONS", raising=False)
    monkeypatch.delenv("CV_TEMPLATE_TAGGER_CONDITIONALS", raising=False)
    yield


class TestHeadingInclusiveConditional:
    """Default behavior: heading + content disappear together when data is empty."""

    def test_full_data_renders_all_sections(self, template_path):
        tagged = auto_tag_template(template_path)
        ctx = {
            "full_name": "Aya",
            "email": "aya@example.com",
            "work_experiences": [{
                "jobTitle": "Developer", "companyName": "ACME",
                "startDate": "2020", "endDate": "2023",
                "description": "Did things",
            }],
            "skills": ["Python", "Java"],
            "educations": [{
                "degree": "BSc CS", "institution": "MIT",
                "startDate": "2015", "endDate": "2019",
            }],
        }
        doc, _ = _render(tagged, ctx)
        text = _all_text(doc)
        assert "Experience" in text
        assert "Skills" in text
        assert "Education" in text

    def test_empty_skills_removes_heading_and_content(self, template_path):
        tagged = auto_tag_template(template_path)
        ctx = {
            "full_name": "Aya",
            "work_experiences": [{
                "jobTitle": "Developer", "companyName": "ACME",
                "startDate": "2020", "endDate": "2023",
            }],
            "skills": [],  # empty → entire Skills section must vanish
            "educations": [{
                "degree": "BSc CS", "institution": "MIT",
                "startDate": "2015", "endDate": "2019",
            }],
        }
        doc, _ = _render(tagged, ctx)
        text = _all_text(doc)
        # The Skills heading must NOT appear since data is empty.
        assert "Skills" not in text, f"Empty Skills heading leaked through:\n{text}"
        # And no "N/A" placeholder either.
        assert "N/A" not in text
        # Other sections still present.
        assert "Experience" in text
        assert "Education" in text

    def test_empty_education_removes_heading_and_content(self, template_path):
        tagged = auto_tag_template(template_path)
        ctx = {
            "full_name": "Aya",
            "work_experiences": [{
                "jobTitle": "Developer", "companyName": "ACME",
                "startDate": "2020", "endDate": "2023",
            }],
            "skills": ["Python"],
            "educations": [],
        }
        doc, _ = _render(tagged, ctx)
        text = _all_text(doc)
        assert "Education" not in text, f"Empty Education heading leaked through:\n{text}"
        assert "N/A" not in text

    def test_all_lists_empty_removes_all_section_headings(self, template_path):
        tagged = auto_tag_template(template_path)
        ctx = {
            "full_name": "Aya",
            "work_experiences": [],
            "skills": [],
            "educations": [],
        }
        doc, _ = _render(tagged, ctx)
        text = _all_text(doc)
        for label in ("Experience", "Skills", "Education"):
            assert label not in text, (
                f"Section heading '{label}' was not removed for empty data:\n{text}"
            )
        assert "N/A" not in text


class TestLegacyMode:
    """When CV_TEMPLATE_REMOVE_EMPTY_SECTIONS=0, the heading stays + 'N/A' shows."""

    def test_legacy_keeps_heading_with_na(self, template_path, monkeypatch):
        monkeypatch.setenv("CV_TEMPLATE_REMOVE_EMPTY_SECTIONS", "0")
        tagged = auto_tag_template(template_path)
        ctx = {
            "full_name": "Aya",
            "work_experiences": [{
                "jobTitle": "Developer", "companyName": "ACME",
                "startDate": "2020", "endDate": "2023",
            }],
            "skills": [],  # empty in legacy mode → heading kept, body = "N/A"
            "educations": [{"degree": "BSc CS", "institution": "MIT"}],
        }
        doc, _ = _render(tagged, ctx)
        text = _all_text(doc)
        # Heading still visible
        assert "Skills" in text
        # Legacy fallback inserts "N/A" placeholder
        assert "N/A" in text


def test_borderline_heading_uses_legacy_fallback_in_strict_mode(monkeypatch):
    monkeypatch.delenv("CV_TEMPLATE_REMOVE_EMPTY_SECTIONS", raising=False)
    monkeypatch.delenv("CV_TEMPLATE_TAGGER_CONDITIONALS", raising=False)

    d = tempfile.mkdtemp(prefix="cv_tag_borderline_")
    p = os.path.join(d, "template.docx")
    doc = Document()
    doc.add_paragraph("John Doe")
    doc.add_paragraph("Skills Summary")
    doc.add_paragraph("Python, SQL")
    doc.save(p)

    tagged = auto_tag_template(p)
    rendered, _ = _render(tagged, {"full_name": "Aya", "skills": []})
    text = _all_text(rendered)

    assert "Skills Summary" in text
    assert "N/A" in text
