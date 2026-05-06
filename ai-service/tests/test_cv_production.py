"""
Production-Hardening Tests for CV Generation System
=====================================================
Tests for:
  - Error hierarchy (cv_errors.py)
  - Hardened I/O utilities (cv_io.py)
  - _build_section_content edge cases
  - ReDoS regression guard
  - Shape dimension overflow cap
  - Table cell counting (direct children)
  - API error mapping
  - Atomic DOCX write
  - XML safe parsing

Run with:
    cd ai-service
    python -m pytest tests/test_cv_production.py -v
"""

import copy
import os
import re
import shutil
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Dict, Any
from unittest.mock import patch, MagicMock

import pytest
from lxml import etree

# ── Path setup ────────────────────────────────────────────────────────────
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.cv_errors import (
    CVGenerationError,
    CVValidationError,
    CVTemplateError,
    CVIOError,
    CVRenderError,
    CVExportError,
    CVExternalError,
)
from app.services.cv_io import (
    validate_zip_members,
    validate_docx_structure,
    atomic_docx_write,
    safe_parse_xml,
    xml_safe_text,
    xml_files_in_docx,
    MAX_DOCX_BYTES,
    MAX_ZIP_ENTRIES,
    MAX_SINGLE_XML_BYTES,
)
from app.services.cv_generator import (
    _build_section_content,
    _fill_table_section,
    _xml_safe_text,
    _get_paragraph_texts,
    NS_W,
)


# ═══════════════════════════════════════════════════════════════════════════
#  Fixtures
# ═══════════════════════════════════════════════════════════════════════════

@pytest.fixture
def temp_dir():
    d = tempfile.mkdtemp(prefix="cv_prod_test_")
    yield d
    shutil.rmtree(d, ignore_errors=True)


def _make_minimal_docx(path: str, content_xml: str = None):
    """Create a minimal valid DOCX file for testing."""
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


# ═══════════════════════════════════════════════════════════════════════════
#  1. Error Hierarchy Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestErrorHierarchy:
    """All CV exception types carry category, detail, and cause."""

    def test_base_error(self):
        err = CVGenerationError("something broke")
        assert err.detail == "something broke"
        assert err.cause is None
        assert err.category == "unknown"
        assert str(err) == "something broke"

    def test_base_with_cause(self):
        orig = ValueError("bad value")
        err = CVGenerationError("wrapper", cause=orig)
        assert err.cause is orig

    def test_validation_error_category(self):
        err = CVValidationError("bad input")
        assert err.category == "validation"
        assert isinstance(err, CVGenerationError)

    def test_template_error_category(self):
        err = CVTemplateError("corrupt template")
        assert err.category == "template"
        assert isinstance(err, CVGenerationError)

    def test_io_error_category(self):
        err = CVIOError("write failed")
        assert err.category == "io"
        assert isinstance(err, CVGenerationError)

    def test_render_error_category(self):
        err = CVRenderError("replace failed")
        assert err.category == "render"
        assert isinstance(err, CVGenerationError)

    def test_export_error_category(self):
        err = CVExportError("PDF conversion failed")
        assert err.category == "export"
        assert isinstance(err, CVGenerationError)

    def test_external_error_category(self):
        err = CVExternalError("Groq timeout")
        assert err.category == "external"
        assert isinstance(err, CVGenerationError)

    def test_all_are_catchable_as_base(self):
        """All specific errors can be caught as CVGenerationError."""
        for cls in (CVValidationError, CVTemplateError, CVIOError,
                    CVRenderError, CVExportError, CVExternalError):
            with pytest.raises(CVGenerationError):
                raise cls("test")

    def test_specific_catch_does_not_cross(self):
        """CVValidationError should not be caught by CVIOError handler."""
        with pytest.raises(CVValidationError):
            try:
                raise CVValidationError("bad")
            except CVIOError:
                pytest.fail("Wrong exception type caught")


# ═══════════════════════════════════════════════════════════════════════════
#  2. Zip Path Traversal Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestValidateZipMembers:
    """Ensure path traversal and entry bombs are rejected."""

    def test_valid_docx_accepted(self, temp_dir):
        path = os.path.join(temp_dir, "ok.docx")
        _make_minimal_docx(path)
        with zipfile.ZipFile(path, 'r') as zf:
            validate_zip_members(zf)  # should not raise

    def test_path_traversal_dotdot_rejected(self, temp_dir):
        path = os.path.join(temp_dir, "evil.zip")
        with zipfile.ZipFile(path, 'w') as zf:
            zf.writestr('../../etc/passwd', 'root:x:0:0')
        with zipfile.ZipFile(path, 'r') as zf:
            with pytest.raises(CVTemplateError, match="traversal"):
                validate_zip_members(zf)

    def test_absolute_path_rejected(self, temp_dir):
        path = os.path.join(temp_dir, "abs.zip")
        with zipfile.ZipFile(path, 'w') as zf:
            zf.writestr('/etc/passwd', 'root:x:0:0')
        with zipfile.ZipFile(path, 'r') as zf:
            with pytest.raises(CVTemplateError, match="Absolute"):
                validate_zip_members(zf)

    def test_backslash_traversal_rejected(self, temp_dir):
        path = os.path.join(temp_dir, "bslash.zip")
        with zipfile.ZipFile(path, 'w') as zf:
            zf.writestr('word\\..\\..\\passwd', 'data')
        with zipfile.ZipFile(path, 'r') as zf:
            with pytest.raises(CVTemplateError, match="traversal"):
                validate_zip_members(zf)

    def test_too_many_entries_rejected(self, temp_dir):
        path = os.path.join(temp_dir, "bomb.zip")
        with zipfile.ZipFile(path, 'w') as zf:
            for i in range(MAX_ZIP_ENTRIES + 1):
                zf.writestr(f'file_{i}.txt', 'x')
        with zipfile.ZipFile(path, 'r') as zf:
            with pytest.raises(CVTemplateError, match="entries"):
                validate_zip_members(zf)


# ═══════════════════════════════════════════════════════════════════════════
#  3. DOCX Structure Validation Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestValidateDocxStructure:
    """Full DOCX validity checks."""

    def test_valid_docx_passes(self, temp_dir):
        path = os.path.join(temp_dir, "ok.docx")
        _make_minimal_docx(path)
        validate_docx_structure(path)  # should not raise

    def test_missing_file(self, temp_dir):
        with pytest.raises(CVTemplateError, match="not found"):
            validate_docx_structure(os.path.join(temp_dir, "nope.docx"))

    def test_not_a_zip(self, temp_dir):
        path = os.path.join(temp_dir, "fake.docx")
        with open(path, 'w') as f:
            f.write("not a zip")
        with pytest.raises(CVTemplateError, match="not a valid DOCX"):
            validate_docx_structure(path)

    def test_zip_without_document_xml(self, temp_dir):
        path = os.path.join(temp_dir, "no_doc.docx")
        with zipfile.ZipFile(path, 'w') as zf:
            zf.writestr('word/other.xml', '<data/>')
        with pytest.raises(CVTemplateError, match="document.xml"):
            validate_docx_structure(path)

    def test_oversized_file(self, temp_dir):
        """File larger than MAX_DOCX_BYTES should be rejected."""
        path = os.path.join(temp_dir, "huge.docx")
        # Just create a file that reports correct size
        # (We can't actually write 50MB in a test — mock instead)
        _make_minimal_docx(path)
        with patch('app.services.cv_io.os.path.getsize', return_value=MAX_DOCX_BYTES + 1):
            with pytest.raises(CVTemplateError, match="too large"):
                validate_docx_structure(path)


# ═══════════════════════════════════════════════════════════════════════════
#  4. Safe XML Parsing Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestSafeParseXml:
    """XML parsing with size guard and error reporting."""

    def test_valid_xml(self):
        root = safe_parse_xml(b'<root><child/></root>')
        assert root.tag == 'root'

    def test_malformed_xml_raises_template_error(self):
        with pytest.raises(CVTemplateError, match="Malformed"):
            safe_parse_xml(b'<root><unclosed>')

    def test_oversized_xml(self):
        huge = b'<root>' + b'x' * (MAX_SINGLE_XML_BYTES + 1) + b'</root>'
        with pytest.raises(CVTemplateError, match="too large"):
            safe_parse_xml(huge)

    def test_empty_xml_raises(self):
        with pytest.raises(CVTemplateError, match="Malformed"):
            safe_parse_xml(b'')

    def test_custom_label(self):
        with pytest.raises(CVTemplateError, match="document.xml"):
            safe_parse_xml(b'<broken', label="document.xml")


# ═══════════════════════════════════════════════════════════════════════════
#  5. XML Safe Text Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestXmlSafeText:
    """Control character stripping for OOXML elements."""

    def test_strips_control_chars(self):
        assert xml_safe_text("He\x00llo\x01") == "Hello"

    def test_preserves_tab_and_newline(self):
        assert xml_safe_text("Tab\there\nNewline") == "Tab\there\nNewline"

    def test_empty_passthrough(self):
        assert xml_safe_text("") == ""
        assert xml_safe_text(None) is None

    def test_unicode_preserved(self):
        assert xml_safe_text("Ça va très bien 日本語") == "Ça va très bien 日本語"

    def test_emoji_preserved(self):
        assert xml_safe_text("Hello 🎉") == "Hello 🎉"


# ═══════════════════════════════════════════════════════════════════════════
#  6. Atomic DOCX Write Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestAtomicDocxWrite:
    """atomic_docx_write guarantees original untouched on failure."""

    def test_successful_write(self, temp_dir):
        path = os.path.join(temp_dir, "test.docx")
        _make_minimal_docx(path)
        original_size = os.path.getsize(path)

        with atomic_docx_write(path) as extract_dir:
            # Modify a file inside
            doc_path = os.path.join(extract_dir, 'word', 'document.xml')
            assert os.path.exists(doc_path)
            with open(doc_path, 'r') as f:
                content = f.read()
            with open(doc_path, 'w') as f:
                f.write(content.replace("Hello World", "Modified"))

        # File should still be a valid zip
        assert zipfile.is_zipfile(path)
        with zipfile.ZipFile(path, 'r') as zf:
            doc_xml = zf.read('word/document.xml').decode()
            assert "Modified" in doc_xml

    def test_failure_preserves_original(self, temp_dir):
        path = os.path.join(temp_dir, "safe.docx")
        _make_minimal_docx(path)
        # Read original content
        with zipfile.ZipFile(path, 'r') as zf:
            original_content = zf.read('word/document.xml')

        with pytest.raises(CVIOError):
            with atomic_docx_write(path) as extract_dir:
                raise RuntimeError("Simulated failure")

        # Original should be untouched
        with zipfile.ZipFile(path, 'r') as zf:
            assert zf.read('word/document.xml') == original_content

    def test_temp_file_cleaned_on_failure(self, temp_dir):
        path = os.path.join(temp_dir, "clean.docx")
        _make_minimal_docx(path)

        with pytest.raises(CVIOError):
            with atomic_docx_write(path) as extract_dir:
                raise RuntimeError("fail")

        # No .tmp file should remain
        assert not os.path.exists(path + '.tmp')


# ═══════════════════════════════════════════════════════════════════════════
#  7. xml_files_in_docx Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestXmlFilesInDocx:
    """Test listing XML parts."""

    def test_standard_docx(self, temp_dir):
        path = os.path.join(temp_dir, "std.docx")
        _make_minimal_docx(path)
        xml_files = xml_files_in_docx(path)
        assert 'word/document.xml' in xml_files

    def test_extra_xml_parts(self, temp_dir):
        path = os.path.join(temp_dir, "multi.docx")
        _make_minimal_docx(path)
        # Add extra XML parts
        with zipfile.ZipFile(path, 'a') as zf:
            zf.writestr('word/header1.xml', '<hdr/>')
            zf.writestr('word/footer1.xml', '<ftr/>')
        xml_files = xml_files_in_docx(path)
        assert 'word/header1.xml' in xml_files
        assert 'word/footer1.xml' in xml_files

    def test_non_word_xml_excluded(self, temp_dir):
        path = os.path.join(temp_dir, "other.docx")
        _make_minimal_docx(path)
        with zipfile.ZipFile(path, 'a') as zf:
            zf.writestr('customXml/item1.xml', '<root/>')
        xml_files = xml_files_in_docx(path)
        assert 'customXml/item1.xml' not in xml_files


# ═══════════════════════════════════════════════════════════════════════════
#  8. ReDoS Regression Guard
# ═══════════════════════════════════════════════════════════════════════════

class TestReDoSGuard:
    """Pathological phone regex inputs must not hang."""

    def test_long_whitespace_digits_no_hang(self):
        """A string with alternating spaces and digits should complete fast."""
        # This pattern would cause catastrophic backtracking with {7,}
        pathological = '+' + ' 1' * 50  # 100-char phone-like string
        pattern = re.compile(r'\+?\d[\d\s\-\.\(\)]{7,20}')
        start = time.monotonic()
        result = pattern.search(pathological)
        elapsed = time.monotonic() - start
        # Must complete instantly (< 1 second), not hang
        assert elapsed < 1.0

    def test_normal_phone_still_matches(self):
        pattern = re.compile(r'\+?\d[\d\s\-\.\(\)]{7,20}')
        assert pattern.search('+216 98 772 817') is not None
        assert pattern.search('+33 6 12 34 56 78') is not None
        assert pattern.search('(555) 123-4567') is not None

    def test_short_string_no_match(self):
        """Strings shorter than 8 digits/spaces should not match."""
        pattern = re.compile(r'\+?\d[\d\s\-\.\(\)]{7,20}')
        assert pattern.search('+12345') is None

    def test_extremely_long_no_hang(self):
        """Even very long strings should not cause exponential backtracking."""
        pathological = '1' + ' ' * 200 + '1'
        pattern = re.compile(r'\+?\d[\d\s\-\.\(\)]{7,20}')
        start = time.monotonic()
        pattern.search(pathological)
        elapsed = time.monotonic() - start
        assert elapsed < 1.0


# ═══════════════════════════════════════════════════════════════════════════
#  9. _build_section_content Edge Cases
# ═══════════════════════════════════════════════════════════════════════════

class TestBuildSectionContent:
    """Edge cases for _build_section_content with production data."""

    @patch('app.services.cv_generator.settings')
    def test_summary_none_returns_none(self, mock_settings):
        mock_settings.GROQ_API_KEY = None
        result = _build_section_content('summary', {})
        assert result is None

    @patch('app.services.cv_generator.settings')
    def test_summary_empty_string_returns_none(self, mock_settings):
        mock_settings.GROQ_API_KEY = None
        result = _build_section_content('summary', {'summary': ''})
        assert result is None

    @patch('app.services.cv_generator.settings')
    def test_summary_whitespace_returns_none(self, mock_settings):
        mock_settings.GROQ_API_KEY = None
        result = _build_section_content('summary', {'summary': '   '})
        assert result is None

    def test_summary_valid(self):
        result = _build_section_content('summary', {'summary': 'Expert engineer.'})
        assert result is not None
        assert len(result) == 1
        assert result[0]['text'] == 'Expert engineer.'
        assert result[0]['bold'] is False

    def test_experience_none_returns_none(self):
        assert _build_section_content('experience', {}) is None
        assert _build_section_content('experience', {'experience': None}) is None
        assert _build_section_content('experience', {'experience': []}) is None

    def test_experience_non_list_returns_none(self):
        assert _build_section_content('experience', {'experience': 'not a list'}) is None

    def test_experience_non_dict_entries_skipped(self):
        """Non-dict entries in experience list should be silently skipped."""
        result = _build_section_content('experience', {
            'experience': [
                "string entry",
                42,
                None,
                {'title': 'Dev', 'company': 'Corp'},
            ]
        })
        assert result is not None
        # Only the dict entry should produce output
        texts = [r['text'] for r in result]
        assert any('Dev' in t for t in texts)

    def test_experience_empty_title_company_skipped(self):
        """Entries with no title AND no company should be skipped."""
        result = _build_section_content('experience', {
            'experience': [
                {'title': '', 'company': ''},
                {'title': 'Dev', 'company': 'Corp'},
            ]
        })
        assert result is not None
        # Title lines are non-compact, non-bullet entries
        titles = [r['text'] for r in result if not r.get('bullet') and not r.get('compact')]
        assert len(titles) == 1
        assert titles[0] == 'Dev'

    def test_experience_long_description_capped(self):
        """Descriptions over 1500 chars must be truncated."""
        result = _build_section_content('experience', {
            'experience': [{
                'title': 'Dev',
                'company': 'Corp',
                'description': 'word ' * 500,  # ~2500 chars
            }]
        })
        assert result is not None
        all_text = ' '.join(r['text'] for r in result)
        # The description part should be truncated
        # Individual lines from desc.split('\n') could be long
        for r in result:
            assert len(r['text']) <= 1600  # 1500 + word boundary + ellipsis overhead

    def test_experience_none_values_handled(self):
        """None values in experience fields should not crash."""
        result = _build_section_content('experience', {
            'experience': [{
                'title': None,
                'company': 'Corp',
                'dates': None,
                'description': None,
            }]
        })
        # Should work — company present, title None → treated as empty
        assert result is not None

    def test_education_dedup_dates(self):
        """ISO dates should be shortened to year only."""
        result = _build_section_content('education', {
            'education': [{
                'degree': 'BSc',
                'institution': 'MIT',
                'dates': '2022-06-15',
            }]
        })
        assert result is not None
        text = result[0]['text']
        assert '2022' in text
        assert '06' not in text

    def test_education_non_dict_skipped(self):
        result = _build_section_content('education', {
            'education': ["string", {'degree': 'BSc', 'institution': 'MIT'}]
        })
        assert result is not None
        assert len(result) == 1

    def test_education_empty_skipped(self):
        result = _build_section_content('education', {
            'education': [{'degree': '', 'institution': ''}]
        })
        assert result is None

    def test_skills_empty_returns_none(self):
        assert _build_section_content('skills', {}) is None
        assert _build_section_content('skills', {'skills': []}) is None

    def test_skills_basic(self):
        result = _build_section_content('skills', {'skills': ['Python', 'Java']})
        assert result is not None
        assert 'Python' in result[0]['text']

    def test_certifications_list_of_strings(self):
        result = _build_section_content('certifications', {
            'certifications': ['AWS', 'Azure']
        })
        assert result is not None
        assert len(result) == 2

    def test_certifications_list_of_dicts(self):
        result = _build_section_content('certifications', {
            'certifications': [{'name': 'AWS'}, {'name': 'Azure'}]
        })
        assert result is not None
        names = [r['text'] for r in result]
        assert 'AWS' in names

    def test_certifications_empty_names_dropped(self):
        result = _build_section_content('certifications', {
            'certifications': ['', 'AWS']
        })
        # '' is filtered out
        assert result is not None
        assert len(result) == 1

    def test_certifications_none_entry_handled(self):
        """None entry in certifications should not crash."""
        result = _build_section_content('certifications', {
            'certifications': [None, 'AWS']
        })
        assert result is not None
        assert any(r['text'] == 'AWS' for r in result)

    def test_languages_list(self):
        result = _build_section_content('languages', {
            'languages': ['French', 'English']
        })
        assert result is not None
        assert 'French' in result[0]['text']

    def test_languages_dicts(self):
        result = _build_section_content('languages', {
            'languages': [{'name': 'French'}, {'name': 'English'}]
        })
        assert result is not None
        assert 'French' in result[0]['text']

    def test_interests_list(self):
        result = _build_section_content('interests', {
            'interests': ['Reading', 'Gaming']
        })
        assert result is not None
        assert len(result) == 2

    def test_unknown_section_returns_none(self):
        assert _build_section_content('unknown_section', {'name': 'Test'}) is None

    def test_projects_basic(self):
        result = _build_section_content('projects', {
            'projects': [{'name': 'MyApp', 'description': 'A cool app'}]
        })
        assert result is not None
        assert any('MyApp' in r['text'] for r in result)

    def test_projects_null_entries_and_null_skill_lists_do_not_crash(self):
        result = _build_section_content('projects', {
            'projects': [
                None,
                {'name': 'MyApp', 'skills': None, 'description': 'A cool app'},
            ]
        })
        assert result is not None
        assert any('MyApp' in r['text'] for r in result)

    def test_skills_null_and_dict_entries_are_filtered(self):
        result = _build_section_content('skills', {
            'skills': [None, 'Python', {'name': 'Java'}],
            'certifications': [None, {'name': 'AWS'}],
        })
        assert result is not None
        assert 'Python' in result[0]['text']
        assert 'Java' in result[0]['text']

    def test_languages_null_entries_are_filtered(self):
        result = _build_section_content('languages', {
            'languages': [None, {'name': 'French'}],
        })
        assert result is not None
        assert result[0]['text'] == 'French'

    def test_interests_null_entries_are_filtered(self):
        result = _build_section_content('interests', {
            'interests': [None, {'name': 'Reading'}],
        })
        assert result is not None
        assert len(result) == 1
        assert result[0]['text'] == 'Reading'


# ═══════════════════════════════════════════════════════════════════════════
#  10. Table Cell Counting (Direct Children)
# ═══════════════════════════════════════════════════════════════════════════

class TestFillTableSection:
    """_fill_table_section uses direct children for cell counting."""

    def _make_table(self, num_cols=3, with_nested_merge=False):
        """Build a minimal <w:tbl> element."""
        W = NS_W
        tbl = etree.Element(f'{{{W}}}tbl')

        # Header row
        tr_h = etree.SubElement(tbl, f'{{{W}}}tr')
        for i in range(num_cols):
            tc = etree.SubElement(tr_h, f'{{{W}}}tc')
            p = etree.SubElement(tc, f'{{{W}}}p')
            r = etree.SubElement(p, f'{{{W}}}r')
            t = etree.SubElement(r, f'{{{W}}}t')
            t.text = f'Header {i}'

        # Data template row
        tr_d = etree.SubElement(tbl, f'{{{W}}}tr')
        for i in range(num_cols):
            tc = etree.SubElement(tr_d, f'{{{W}}}tc')
            if with_nested_merge and i == 0:
                # Add a nested tc (simulating merged cells in complex tables)
                inner_tc = etree.SubElement(tc, f'{{{W}}}tc')
                p = etree.SubElement(inner_tc, f'{{{W}}}p')
            p = etree.SubElement(tc, f'{{{W}}}p')
            r = etree.SubElement(p, f'{{{W}}}r')
            t = etree.SubElement(r, f'{{{W}}}t')
            t.text = f'Data {i}'

        return tbl

    def test_basic_fill(self):
        tbl = self._make_table(num_cols=3)
        rows = [['A', 'B', 'C'], ['D', 'E', 'F']]
        count = _fill_table_section(tbl, rows)
        assert count == 2
        # Should have header + 2 data rows = 3 total
        W = NS_W
        all_trs = tbl.findall(f'{{{W}}}tr')
        assert len(all_trs) == 3

    def test_preserves_header(self):
        tbl = self._make_table(num_cols=2)
        rows = [['X', 'Y']]
        _fill_table_section(tbl, rows)
        W = NS_W
        header_tr = tbl.findall(f'{{{W}}}tr')[0]
        cells = header_tr.findall(f'./{{{W}}}tc')
        text = cells[0].find(f'.//{{{W}}}t').text
        assert text == 'Header 0'

    def test_padding_short_rows(self):
        """Rows with fewer columns than header should be padded."""
        tbl = self._make_table(num_cols=3)
        rows = [['Only one']]
        count = _fill_table_section(tbl, rows)
        assert count == 1

    def test_truncating_long_rows(self):
        """Rows with more columns than header should be truncated."""
        tbl = self._make_table(num_cols=2)
        rows = [['A', 'B', 'C', 'D']]
        count = _fill_table_section(tbl, rows)
        assert count == 1

    def test_empty_rows(self):
        tbl = self._make_table(num_cols=2)
        count = _fill_table_section(tbl, [])
        assert count == 0

    def test_nested_cells_not_double_counted(self):
        """With nested tc elements, only direct children should be counted."""
        tbl = self._make_table(num_cols=3, with_nested_merge=True)
        rows = [['A', 'B', 'C']]
        count = _fill_table_section(tbl, rows)
        assert count == 1
        # Verify correct number of direct child cells
        W = NS_W
        data_tr = tbl.findall(f'{{{W}}}tr')[1]
        direct_cells = data_tr.findall(f'./{{{W}}}tc')
        assert len(direct_cells) == 3


# ═══════════════════════════════════════════════════════════════════════════
#  11. Shape Dimension Overflow Cap
# ═══════════════════════════════════════════════════════════════════════════

class TestShapeDimensionCap:
    """Verify the _MAX_SHAPE_CY constant is present in the code."""

    def test_cap_value_in_source(self):
        """The cap constant should exist in cv_generator source code."""
        import inspect
        import app.services.cv_generator as gen_mod
        source = inspect.getsource(gen_mod)
        assert '_MAX_SHAPE_CY = 20_000_000' in source
        # Value should be < 2^31 (Word's signed int limit)
        assert 20_000_000 < 2**31


# ═══════════════════════════════════════════════════════════════════════════
#  12. Special Character Handling
# ═══════════════════════════════════════════════════════════════════════════

class TestSpecialCharacters:
    """Ensure special characters don't break XML or section building."""

    def test_ampersand_in_experience(self):
        result = _build_section_content('experience', {
            'experience': [{
                'title': 'R&D Engineer',
                'company': 'AT&T',
                'description': 'Led R&D initiatives.',
            }]
        })
        assert result is not None
        texts = [r['text'] for r in result]
        assert any('R&D' in t for t in texts)
        assert any('AT&T' in t for t in texts)

    def test_angle_brackets_in_summary(self):
        result = _build_section_content('summary', {
            'summary': 'Expert in <Python> and <Java> frameworks.'
        })
        assert result is not None
        assert '<Python>' in result[0]['text']

    def test_quotes_in_data(self):
        result = _build_section_content('experience', {
            'experience': [{
                'title': 'Lead "Innovation" Engineer',
                'company': "O'Reilly",
            }]
        })
        assert result is not None

    def test_unicode_accents(self):
        result = _build_section_content('experience', {
            'experience': [{
                'title': 'Ingénieur système',
                'company': 'Société Générale',
                'description': 'Développement d\'applications métier.',
            }]
        })
        assert result is not None
        texts = [r['text'] for r in result]
        assert any('Ingénieur' in t for t in texts)

    def test_empty_experience_with_description_only(self):
        """Experience with no title, no company, only description → skipped."""
        result = _build_section_content('experience', {
            'experience': [{'description': 'Did stuff'}]
        })
        assert result is None  # no title/company → skipped → empty list → None

    def test_newlines_in_description(self):
        """Multi-line descriptions split into bullet lines."""
        result = _build_section_content('experience', {
            'experience': [{
                'title': 'Dev',
                'company': 'Corp',
                'description': 'Line one\nLine two\nLine three',
            }]
        })
        assert result is not None
        bullet_lines = [r for r in result if r.get('bullet')]
        assert len(bullet_lines) == 3


# ═══════════════════════════════════════════════════════════════════════════
#  13. Paragraph Text Extraction Security
# ═══════════════════════════════════════════════════════════════════════════

class TestParagraphExtractionSecurity:
    """Ensure text extraction handles adversarial XML."""

    def test_deeply_nested_xml_no_crash(self):
        """Deeply nested paragraphs should not cause stack overflow."""
        # Build moderately deep nesting (50 levels)
        inner = '<w:p><w:r><w:t>Deep text</w:t></w:r></w:p>'
        xml = inner
        for _ in range(50):
            xml = f'<w:sdt><w:sdtContent>{xml}</w:sdtContent></w:sdt>'
        full_xml = (
            f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f'<w:body>{xml}</w:body></w:document>'
        ).encode('utf-8')
        paras = _get_paragraph_texts(full_xml)
        assert 'Deep text' in paras

    def test_huge_single_paragraph(self):
        """Very long text in a single paragraph should extract correctly."""
        long_text = 'A' * 10000
        xml = (
            f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f'<w:body><w:p><w:r><w:t>{long_text}</w:t></w:r></w:p></w:body></w:document>'
        ).encode('utf-8')
        paras = _get_paragraph_texts(xml)
        assert len(paras) == 1
        assert len(paras[0]) == 10000


# ═══════════════════════════════════════════════════════════════════════════
#  14. Experience ISO Date Normalization
# ═══════════════════════════════════════════════════════════════════════════

class TestExperienceDateNormalization:
    """ISO dates in experience should be shortened to year."""

    def test_iso_date_shortened(self):
        result = _build_section_content('experience', {
            'experience': [{
                'title': 'Dev',
                'company': 'Corp',
                'dates': '2018-02-01',
            }]
        })
        texts = [r['text'] for r in result]
        date_line = [t for t in texts if '2018' in t][0]
        assert '02' not in date_line
        assert '2018' in date_line

    def test_plain_year_preserved(self):
        result = _build_section_content('experience', {
            'experience': [{
                'title': 'Dev',
                'company': 'Corp',
                'dates': '2020 - Present',
            }]
        })
        texts = [r['text'] for r in result]
        assert any('2020 - Present' in t for t in texts)

    def test_experience_title_precedes_company_and_dates(self):
        result = _build_section_content('experience', {
            'experience': [{
                'title': 'Project Manager',
                'company': 'Next Step IT',
                'dates': '2016 - Present',
            }]
        })
        assert result is not None
        non_bullets = [item for item in result if not item.get('bullet')]
        assert non_bullets[0]['text'] == 'Project Manager'
        assert non_bullets[0]['bold'] is True
        assert non_bullets[1]['compact'] is True
        assert non_bullets[1]['text'] == 'Next Step IT  —  2016 - Present'

    def test_start_date_fallback(self):
        """start_date used when dates is absent."""
        result = _build_section_content('experience', {
            'experience': [{
                'title': 'Dev',
                'company': 'Corp',
                'start_date': '2019-06',
            }]
        })
        texts = [r['text'] for r in result]
        assert any('2019' in t for t in texts)


# ═══════════════════════════════════════════════════════════════════════════
#  15. Integration: Full Section Build Pipeline
# ═══════════════════════════════════════════════════════════════════════════

class TestFullSectionPipeline:
    """Integration tests combining multiple sections."""

    def test_all_sections_from_complete_employee(self):
        employee = {
            'name': 'Aya BEN JEMAA',
            'summary': 'Experienced full-stack developer.',
            'experience': [
                {'title': 'Senior Dev', 'company': 'TechCorp', 'dates': '2023-01-01',
                 'description': 'Led team of 5.\nImplemented CI/CD.'},
                {'title': 'Junior Dev', 'company': 'Startup', 'dates': '2021-03',
                 'description': 'Backend work.'},
            ],
            'education': [
                {'degree': 'BSc CS', 'institution': 'MIT', 'dates': '2020-06-15'},
            ],
            'skills': ['Python', 'React', 'Docker'],
            'certifications': ['AWS Solutions Architect'],
            'languages': ['French', 'English'],
            'interests': ['AI', 'Open Source'],
            'projects': [{'name': 'NextRH', 'description': 'HR platform'}],
        }
        sections = [
            'summary', 'experience', 'education', 'skills',
            'certifications', 'languages', 'interests', 'projects',
        ]
        for section in sections:
            result = _build_section_content(section, employee)
            assert result is not None, f"Section '{section}' returned None"
            assert len(result) > 0, f"Section '{section}' returned empty"
            for item in result:
                assert 'text' in item, f"Missing 'text' in {section} item"
                assert isinstance(item['text'], str), f"Non-string text in {section}"
                assert 'bold' in item, f"Missing 'bold' in {section} item"

    @patch('app.services.cv_generator.settings')
    def test_empty_employee_all_none(self, mock_settings):
        mock_settings.GROQ_API_KEY = None
        employee = {}
        for section in ['summary', 'experience', 'education', 'skills',
                        'certifications', 'languages', 'interests', 'projects']:
            result = _build_section_content(section, employee)
            assert result is None, f"Section '{section}' should be None for empty data"

    def test_mixed_valid_invalid(self):
        """Some sections have data, others don't."""
        employee = {
            'skills': ['Python'],
            'experience': [],  # empty → None
            'certifications': ['AWS'],
        }
        assert _build_section_content('skills', employee) is not None
        assert _build_section_content('experience', employee) is None
        assert _build_section_content('certifications', employee) is not None
        assert _build_section_content('education', employee) is None
