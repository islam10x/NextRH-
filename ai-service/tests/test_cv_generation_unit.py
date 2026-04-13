"""
Comprehensive Unit Tests for CV Generation System
===================================================
Tests validation, placeholder detection, text extraction, replacement logic,
edge cases, and end-to-end generation.

Run with:
    cd ai-service
    python -m pytest tests/test_cv_generation_unit.py -v
"""

import copy
import json
import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Dict, Any, List
from unittest.mock import patch, MagicMock

import pytest
from lxml import etree

# ── Path setup ────────────────────────────────────────────────────────────
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.cv_validation import (
    validate_employee_data,
    EmployeeDataValidator,
    ExperienceEntry,
    EducationEntry,
    _safe_str,
)
from app.services.cv_generation_context import GenerationContext, PhaseResult
from app.services.cv_generator import (
    _xml_safe_text,
    _get_paragraph_texts,
    _detect_template_mode,
    _build_context_from_employee,
    _compute_input_hash,
    cleanEmployeeData,
)


# ═══════════════════════════════════════════════════════════════════════════
#  Fixtures
# ═══════════════════════════════════════════════════════════════════════════

@pytest.fixture
def sample_employee() -> Dict[str, Any]:
    """Complete and valid employee data."""
    return {
        "name": "Aya BEN JEMAA",
        "firstName": "Aya",
        "lastName": "BEN JEMAA",
        "email": "aya.benjemaa@example.com",
        "phone": "+216 98 772 817",
        "title": "Software Engineer",
        "linkedin": "linkedin.com/in/ayabenjemaa",
        "address": "Tunis, Tunisia",
        "summary": "Experienced software engineer specializing in full-stack development.",
        "skills": ["Python", "Java", "JavaScript", "React", "Node.js"],
        "experience": [
            {
                "title": "Software Engineer",
                "company": "TechCorp",
                "dates": "2023 - Present",
                "description": "Full-stack development with React and Node.js.",
            },
            {
                "title": "Junior Developer",
                "company": "StartupXYZ",
                "dates": "2021 - 2023",
                "description": "Backend development with Python.",
            },
        ],
        "education": [
            {
                "degree": "BSc in Software Engineering",
                "institution": "University of Tunis",
                "dates": "2018 - 2022",
            },
        ],
        "certifications": ["AWS Solutions Architect", "Python Advanced"],
        "languages": ["French", "English", "Arabic"],
    }


@pytest.fixture
def minimal_employee() -> Dict[str, Any]:
    """Bare minimum employee data."""
    return {"name": "John Doe"}


@pytest.fixture
def empty_employee() -> Dict[str, Any]:
    """Empty employee data — should get safe defaults."""
    return {}


@pytest.fixture
def temp_dir():
    """Provide a temporary directory that is cleaned up after the test."""
    d = tempfile.mkdtemp(prefix="cv_test_")
    yield d
    shutil.rmtree(d, ignore_errors=True)


def _make_minimal_docx(path: str, content_xml: str = None):
    """Create a minimal valid DOCX file."""
    if content_xml is None:
        content_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:body>'
            '<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>'
            '</w:body>'
            '</w:document>'
        )
    with zipfile.ZipFile(path, 'w') as zf:
        zf.writestr('word/document.xml', content_xml)
        zf.writestr('[Content_Types].xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '</Types>'
        )
        zf.writestr('_rels/.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '</Relationships>'
        )
        zf.writestr('word/_rels/document.xml.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '</Relationships>'
        )


def _make_placeholder_docx(path: str):
    """Create a DOCX with Jinja2 placeholders."""
    content_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:body>'
        '<w:p><w:r><w:t>{{ name }}</w:t></w:r></w:p>'
        '<w:p><w:r><w:t>{{ email }}</w:t></w:r></w:p>'
        '<w:p><w:r><w:t>{{ phone }}</w:t></w:r></w:p>'
        '<w:p><w:r><w:t>{{ title }}</w:t></w:r></w:p>'
        '</w:body>'
        '</w:document>'
    )
    _make_minimal_docx(path, content_xml)


# ═══════════════════════════════════════════════════════════════════════════
#  1. Input Validation Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestInputValidation:
    """Test the EmployeeDataValidator and validate_employee_data."""

    def test_valid_complete_data(self, sample_employee):
        data, report = validate_employee_data(sample_employee)
        assert data["name"] == "Aya BEN JEMAA"
        assert data["email"] == "aya.benjemaa@example.com"
        assert data["phone"] == "+216 98 772 817"
        assert len(data["skills"]) == 5
        assert len(data["experience"]) == 2
        assert len(data["education"]) == 1
        assert not report.has_warnings

    def test_empty_data_gets_defaults(self, empty_employee):
        data, report = validate_employee_data(empty_employee)
        assert data["name"] == "Employee"
        assert data["email"] == ""
        assert data["phone"] == ""
        assert data["skills"] == []
        assert data["experience"] == []
        assert report.has_warnings
        assert "name" in report.fields_defaulted

    def test_none_raises(self):
        with pytest.raises(ValueError, match="cannot be None"):
            validate_employee_data(None)

    def test_name_from_first_last(self):
        data, _ = validate_employee_data({"firstName": "Aya", "lastName": "BEN JEMAA"})
        assert data["name"] == "Aya BEN JEMAA"

    def test_invalid_email_discarded(self):
        data, report = validate_employee_data({"name": "Test", "email": "not-an-email"})
        assert data["email"] == ""
        assert any("email" in w.lower() for w in report.warnings)

    def test_valid_email_kept(self):
        data, _ = validate_employee_data({"name": "Test", "email": "test@example.com"})
        assert data["email"] == "test@example.com"

    def test_invalid_phone_discarded(self):
        data, report = validate_employee_data({"name": "Test", "phone": "abc-def"})
        assert data["phone"] == ""

    def test_valid_phone_kept(self):
        data, _ = validate_employee_data({"name": "Test", "phone": "+33 6 12 34 56 78"})
        assert data["phone"] == "+33 6 12 34 56 78"

    def test_address_strip_section_headers(self):
        data, report = validate_employee_data({
            "name": "Test",
            "address": "Paris, France Expérience professionnelle Senior Dev"
        })
        assert data["address"] == "Paris, France"

    def test_skills_from_string(self):
        data, _ = validate_employee_data({"name": "T", "skills": "Python, Java, C++"})
        assert data["skills"] == ["Python", "Java", "C++"]

    def test_skills_filter_none(self):
        data, _ = validate_employee_data({"name": "T", "skills": [None, "", "Python", None, "Java"]})
        assert data["skills"] == ["Python", "Java"]

    def test_experience_drops_invalid(self):
        data, report = validate_employee_data({
            "name": "T",
            "experience": [
                {"title": "Dev", "company": "Corp"},         # valid
                {"title": "", "company": "Corp"},              # invalid — no title
                {"title": "Dev", "company": ""},               # invalid — no company
                {"jobTitle": "Lead", "companyName": "Inc"},    # valid — alternate keys
                "not a dict",                                   # skipped (not a dict)
            ]
        })
        assert len(data["experience"]) == 2
        assert report.dropped_experiences == 2  # 2 invalid dicts; non-dict skipped silently

    def test_education_deduplication(self):
        data, _ = validate_employee_data({
            "name": "T",
            "education": [{"degree": "BSc Computer Science BSc Computer Science", "institution": "MIT"}]
        })
        assert data["education"][0]["degree"] == "BSc Computer Science"

    def test_title_derived_from_experience(self):
        data, report = validate_employee_data({
            "name": "T",
            "experience": [{"title": "Senior Developer", "company": "ACME"}]
        })
        assert data["title"] == "Senior Developer"

    def test_long_name_truncated(self):
        long_name = "A" * 200
        data, _ = validate_employee_data({"name": long_name})
        assert len(data["name"]) <= 81  # 80 + possible "…"

    def test_long_summary_truncated(self):
        long_summary = "Word " * 500
        data, _ = validate_employee_data({"name": "T", "summary": long_summary})
        assert len(data["summary"]) <= 2001

    def test_certifications_truncated(self):
        certs = [f"Cert {i}" for i in range(20)]
        data, _ = validate_employee_data({"name": "T", "certifications": certs})
        assert len(data["certifications"]) <= 10

    def test_projects_truncated(self):
        projects = [{"name": f"Project {i}", "description": "desc"} for i in range(15)]
        data, _ = validate_employee_data({"name": "T", "projects": projects})
        assert len(data["projects"]) <= 10

    def test_extra_keys_preserved(self):
        """Forward-compatibility: unknown keys pass through."""
        data, _ = validate_employee_data({"name": "T", "custom_field": "value"})
        assert data["custom_field"] == "value"


# ═══════════════════════════════════════════════════════════════════════════
#  2. XML Safety Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestXmlSafety:
    """Test that text inserted into OOXML is safe."""

    def test_control_chars_stripped(self):
        assert _xml_safe_text("Hello\x00World") == "HelloWorld"
        assert _xml_safe_text("Tab\there") == "Tab\there"  # tab preserved
        assert _xml_safe_text("New\nline") == "New\nline"  # newline preserved
        assert _xml_safe_text("\x01\x02\x03text\x04\x05") == "text"

    def test_empty_string(self):
        assert _xml_safe_text("") == ""
        assert _xml_safe_text(None) is None  # None passthrough

    def test_normal_text_unchanged(self):
        assert _xml_safe_text("Aya BEN JEMAA") == "Aya BEN JEMAA"
        assert _xml_safe_text("aya@example.com") == "aya@example.com"
        assert _xml_safe_text("+216 98 772 817") == "+216 98 772 817"

    def test_special_chars_preserved(self):
        """Ampersand, angle brackets — lxml handles escaping, we just strip controls."""
        text = "R&D <Team> A/B"
        assert _xml_safe_text(text) == text

    def test_unicode_preserved(self):
        assert _xml_safe_text("Ç'est très bien") == "Ç'est très bien"
        assert _xml_safe_text("日本語テスト") == "日本語テスト"


# ═══════════════════════════════════════════════════════════════════════════
#  3. Safe String Utility Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestSafeStr:
    """Test the _safe_str helper."""

    def test_none_returns_empty(self):
        assert _safe_str(None) == ""

    def test_string_stripped(self):
        assert _safe_str("  hello  ") == "hello"

    def test_number_coerced(self):
        assert _safe_str(42) == "42"

    def test_long_string_truncated(self):
        result = _safe_str("a " * 200, max_len=50)
        assert len(result) <= 51  # max_len + "…"
        assert result.endswith("…")

    def test_control_chars_stripped(self):
        result = _safe_str("he\x00llo\x01\x02")
        assert "\x00" not in result
        assert "\x01" not in result


# ═══════════════════════════════════════════════════════════════════════════
#  4. Generation Context Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestGenerationContext:
    """Test the debug tracing context."""

    def test_phase_tracking(self):
        ctx = GenerationContext()
        with ctx.phase("test_phase") as p:
            p.message = "done"
        assert len(ctx.phases) == 1
        assert ctx.phases[0].status == "success"
        assert ctx.phases[0].message == "done"

    def test_failed_phase(self):
        ctx = GenerationContext()
        with pytest.raises(ValueError):
            with ctx.phase("bad_phase") as p:
                raise ValueError("oops")
        assert ctx.phases[0].status == "failed"
        assert "oops" in ctx.phases[0].error

    def test_skip_phase(self):
        ctx = GenerationContext()
        ctx.skip_phase("optional", "not needed")
        assert ctx.phases[0].status == "skipped"

    def test_success_property(self):
        ctx = GenerationContext()
        with ctx.phase("text_extraction") as p:
            pass
        assert ctx.success is True

    def test_critical_failure(self):
        ctx = GenerationContext()
        try:
            with ctx.phase("text_extraction") as p:
                raise RuntimeError("fail")
        except RuntimeError:
            pass
        assert ctx.success is False

    def test_to_dict(self):
        ctx = GenerationContext(mode="placeholder", employee_name="Test")
        with ctx.phase("p1") as p:
            p.message = "ok"
        d = ctx.to_dict()
        assert d["mode"] == "placeholder"
        assert d["employee_name"] == "Test"
        assert len(d["phases"]) == 1

    def test_save_trace_debug_mode(self, temp_dir):
        ctx = GenerationContext(debug=True)
        ctx.output_path = os.path.join(temp_dir, "test.docx")
        with ctx.phase("p1"):
            pass
        trace_path = ctx.save_trace()
        assert trace_path is not None
        assert os.path.exists(trace_path)
        with open(trace_path) as f:
            data = json.load(f)
        assert "phases" in data

    def test_summary_string(self):
        ctx = GenerationContext(mode="direct")
        with ctx.phase("p1"):
            pass
        summary = ctx.get_summary()
        assert "direct" in summary
        assert "OK" in summary


# ═══════════════════════════════════════════════════════════════════════════
#  5. Template Mode Detection Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestTemplateMode:
    """Test placeholder vs direct mode detection."""

    def test_placeholder_mode(self, temp_dir):
        template_path = os.path.join(temp_dir, "template.docx")
        _make_placeholder_docx(template_path)
        assert _detect_template_mode(template_path) == "placeholder"

    def test_direct_mode(self, temp_dir):
        template_path = os.path.join(temp_dir, "template.docx")
        _make_minimal_docx(template_path)
        assert _detect_template_mode(template_path) == "direct"

    def test_braces_but_no_known_tokens(self, temp_dir):
        """Has {{ }} but not known field names — should be direct."""
        template_path = os.path.join(temp_dir, "template.docx")
        content = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:body>'
            '<w:p><w:r><w:t>{{ unknown_var }}</w:t></w:r></w:p>'
            '</w:body>'
            '</w:document>'
        )
        _make_minimal_docx(template_path, content)
        assert _detect_template_mode(template_path) == "direct"

    def test_corrupt_file(self, temp_dir):
        """Non-zip file should default to direct without crashing."""
        template_path = os.path.join(temp_dir, "bad.docx")
        with open(template_path, 'w') as f:
            f.write("not a zip file")
        assert _detect_template_mode(template_path) == "direct"


# ═══════════════════════════════════════════════════════════════════════════
#  6. Paragraph Text Extraction Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestParagraphExtraction:
    """Test _get_paragraph_texts."""

    def test_simple_paragraphs(self):
        xml = (
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:body>'
            '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>'
            '<w:p><w:r><w:t>World</w:t></w:r></w:p>'
            '</w:body>'
            '</w:document>'
        ).encode('utf-8')
        paras = _get_paragraph_texts(xml)
        assert paras == ["Hello", "World"]

    def test_split_runs_joined(self):
        """Runs split by Word should be joined."""
        xml = (
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:body>'
            '<w:p>'
            '<w:r><w:t>Hel</w:t></w:r>'
            '<w:r><w:t>lo Wo</w:t></w:r>'
            '<w:r><w:t>rld</w:t></w:r>'
            '</w:p>'
            '</w:body>'
            '</w:document>'
        ).encode('utf-8')
        paras = _get_paragraph_texts(xml)
        assert paras == ["Hello World"]

    def test_empty_paragraphs_excluded(self):
        xml = (
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:body>'
            '<w:p><w:r><w:t>Text</w:t></w:r></w:p>'
            '<w:p><w:pPr/></w:p>'
            '<w:p><w:r><w:t>More</w:t></w:r></w:p>'
            '</w:body>'
            '</w:document>'
        ).encode('utf-8')
        paras = _get_paragraph_texts(xml)
        assert paras == ["Text", "More"]

    def test_vml_fallback_skipped(self):
        """paragraphs inside mc:Fallback should be skipped."""
        xml = (
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
            ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
            '<w:body>'
            '<w:p><w:r><w:t>Real text</w:t></w:r></w:p>'
            '<mc:Fallback>'
            '<w:p><w:r><w:t>VML duplicate</w:t></w:r></w:p>'
            '</mc:Fallback>'
            '</w:body>'
            '</w:document>'
        ).encode('utf-8')
        paras = _get_paragraph_texts(xml)
        assert "VML duplicate" not in paras
        assert "Real text" in paras


# ═══════════════════════════════════════════════════════════════════════════
#  7. Context Builder Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestContextBuilder:
    """Test _build_context_from_employee."""

    def test_full_context(self, sample_employee):
        ctx = _build_context_from_employee(sample_employee)
        assert ctx["name"] == "Aya BEN JEMAA"
        assert ctx["full_name"] == "Aya BEN JEMAA"
        assert ctx["email"] == "aya.benjemaa@example.com"
        assert ctx["phone"] == "+216 98 772 817"
        assert ctx["prenom"] == "Aya"
        assert ctx["nom"] == "JEMAA"
        assert "Python" in ctx["skills_text"]

    def test_none_values_become_empty_strings(self):
        ctx = _build_context_from_employee({})
        assert ctx["name"] == ""
        assert ctx["email"] == ""
        assert ctx["phone"] == ""
        assert ctx["title"] == ""
        # summary may be generated by Groq if API key is configured,
        # so just verify it's a string (not None)
        assert isinstance(ctx["summary"], str)
        assert ctx["skills"] == []

    def test_no_none_in_string_values(self, sample_employee):
        """Verify no context value is None (would print 'None' in template)."""
        ctx = _build_context_from_employee(sample_employee)
        for key, value in ctx.items():
            if isinstance(value, str):
                assert value is not None
                assert "None" not in value, f"ctx['{key}'] contains 'None': {value!r}"


# ═══════════════════════════════════════════════════════════════════════════
#  8. Edge Case Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestEdgeCases:
    """Test edge cases that could break the pipeline."""

    def test_special_chars_in_name(self):
        data, _ = validate_employee_data({"name": "Jean-Pierre O'Brien III"})
        assert data["name"] == "Jean-Pierre O'Brien III"

    def test_unicode_name(self):
        data, _ = validate_employee_data({"name": "田中太郎"})
        assert data["name"] == "田中太郎"

    def test_html_in_fields(self):
        """HTML/XML in field values should not corrupt the document."""
        data, _ = validate_employee_data({
            "name": "Test <script>alert('xss')</script>",
            "summary": "R&D department <b>bold</b>",
        })
        # Values pass through — XML escaping is handled by lxml during serialization
        assert "<script>" in data["name"]  # not stripped, but safe because lxml escapes
        assert "R&D" in data["summary"]

    def test_very_long_text_fields(self):
        data, _ = validate_employee_data({
            "name": "T",
            "summary": "x" * 10000,
            "experience": [{
                "title": "Dev",
                "company": "Corp",
                "description": "y" * 5000,
            }]
        })
        assert len(data["summary"]) <= 2001

    def test_empty_strings_everywhere(self):
        data, report = validate_employee_data({
            "name": "",
            "email": "",
            "phone": "",
            "title": "",
            "summary": "",
            "skills": [],
            "experience": [],
            "education": [],
        })
        assert data["name"] == "Employee"  # fallback

    def test_whitespace_only_name(self):
        data, _ = validate_employee_data({"name": "   "})
        assert data["name"] == "Employee"

    def test_non_dict_experience(self):
        data, report = validate_employee_data({
            "name": "T",
            "experience": ["string entry", 42, None, {"title": "Dev", "company": "Corp"}]
        })
        assert len(data["experience"]) == 1

    def test_experience_with_alt_keys(self):
        data, _ = validate_employee_data({
            "name": "T",
            "experience": [{"jobTitle": "Dev Lead", "companyName": "BigCo"}]
        })
        assert len(data["experience"]) == 1


# ═══════════════════════════════════════════════════════════════════════════
#  9. Input Hash (Idempotency) Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestInputHash:
    """Test that same inputs produce same hash."""

    def test_same_inputs_same_hash(self, temp_dir, sample_employee):
        template_path = os.path.join(temp_dir, "template.docx")
        _make_minimal_docx(template_path)
        h1 = _compute_input_hash(template_path, sample_employee)
        h2 = _compute_input_hash(template_path, sample_employee)
        assert h1 == h2

    def test_different_data_different_hash(self, temp_dir, sample_employee):
        template_path = os.path.join(temp_dir, "template.docx")
        _make_minimal_docx(template_path)
        h1 = _compute_input_hash(template_path, sample_employee)
        modified = dict(sample_employee, name="Different Person")
        h2 = _compute_input_hash(template_path, modified)
        assert h1 != h2


# ═══════════════════════════════════════════════════════════════════════════
#  10. CleanEmployeeData Compatibility Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestCleanEmployeeData:
    """Test the legacy cleanEmployeeData still works."""

    def test_basic_cleaning(self, sample_employee):
        result = cleanEmployeeData(sample_employee)
        assert result["name"] == "Aya BEN JEMAA"
        assert isinstance(result["skills"], list)

    def test_empty_name_fallback(self):
        result = cleanEmployeeData({"firstName": "John", "lastName": "Doe"})
        assert result["name"] == "John Doe"

    def test_bad_email_removed(self):
        result = cleanEmployeeData({"name": "T", "email": "garbage"})
        assert result["email"] == ""


# ═══════════════════════════════════════════════════════════════════════════
#  11. Experience/Education Model Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestExperienceEntry:
    def test_valid(self):
        e = ExperienceEntry.model_validate({"title": "Dev", "company": "Corp"})
        assert e.is_valid

    def test_alt_keys(self):
        e = ExperienceEntry.model_validate({"jobTitle": "Dev", "companyName": "Corp"})
        assert e.title == "Dev"
        assert e.company == "Corp"
        assert e.is_valid

    def test_invalid_no_title(self):
        e = ExperienceEntry.model_validate({"title": "", "company": "Corp"})
        assert not e.is_valid

    def test_long_description_capped(self):
        e = ExperienceEntry.model_validate({
            "title": "Dev", "company": "Corp",
            "description": "x" * 5000
        })
        assert len(e.description) <= 1501


class TestEducationEntry:
    def test_valid(self):
        e = EducationEntry.model_validate({"degree": "BSc", "institution": "MIT"})
        assert e.is_valid

    def test_dedup(self):
        e = EducationEntry.model_validate({
            "degree": "BSc CS BSc CS",
            "institution": "MIT"
        })
        assert e.degree == "BSc CS"

    def test_invalid_empty(self):
        e = EducationEntry.model_validate({"degree": "", "institution": ""})
        assert not e.is_valid


# ═══════════════════════════════════════════════════════════════════════════
#  12. Validation Report Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestValidationReport:
    def test_no_warnings(self, sample_employee):
        _, report = validate_employee_data(sample_employee)
        assert not report.has_warnings
        assert report.dropped_experiences == 0

    def test_warnings_logged(self, empty_employee):
        _, report = validate_employee_data(empty_employee)
        assert report.has_warnings
        assert report.valid_field_count >= 0

    def test_field_counts(self, sample_employee):
        _, report = validate_employee_data(sample_employee)
        assert report.original_field_count > 0
        assert report.valid_field_count > 0
