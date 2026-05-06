"""Tests for the empty-section pruning sweep in the Advanced (fallback) engine."""
from __future__ import annotations

import os
import sys
import tempfile
import zipfile

import pytest
from lxml import etree

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.services.cv_generator_fallback import _prune_empty_sections


W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def _wrap_doc(body_xml: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W_NS}">'
        f'<w:body>{body_xml}<w:sectPr/></w:body>'
        '</w:document>'
    )


def _make_docx(path: str, body_xml: str) -> None:
    with zipfile.ZipFile(path, 'w') as zf:
        zf.writestr('word/document.xml', _wrap_doc(body_xml))
        zf.writestr(
            '[Content_Types].xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '</Types>',
        )
        zf.writestr(
            '_rels/.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/>'
            '</Relationships>',
        )


def _heading_p(text: str) -> str:
    """Bold short heading paragraph that _identify_section_lxml will accept."""
    return (
        '<w:p>'
        '<w:pPr><w:rPr><w:b/></w:rPr></w:pPr>'
        f'<w:r><w:rPr><w:b/></w:rPr><w:t>{text}</w:t></w:r>'
        '</w:p>'
    )


def _content_p(text: str) -> str:
    return f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>'


def _empty_p() -> str:
    return '<w:p><w:r><w:t></w:t></w:r></w:p>'


def _document_xml_of(path: str) -> str:
    with zipfile.ZipFile(path, 'r') as zf:
        return zf.read('word/document.xml').decode('utf-8')


def test_prunes_heading_with_only_blank_paragraphs():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'sample.docx')
        body = (
            _heading_p('Experience')
            + _content_p('Software engineer at Acme')
            + _heading_p('Awards')
            + _empty_p()
            + _empty_p()
            + _heading_p('Education')
            + _content_p('B.Sc. Computer Science')
        )
        _make_docx(path, body)

        pruned = _prune_empty_sections(path)
        assert pruned == 1, f'expected 1 pruned section, got {pruned}'

        xml = _document_xml_of(path)
        assert 'Awards' not in xml
        assert 'Experience' in xml
        assert 'Software engineer at Acme' in xml
        assert 'Education' in xml
        assert 'B.Sc. Computer Science' in xml


def test_keeps_section_with_real_content():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'sample.docx')
        body = (
            _heading_p('Experience')
            + _content_p('Lead engineer at Acme Inc.')
            + _heading_p('Education')
            + _content_p('M.Sc. AI, MIT')
        )
        _make_docx(path, body)

        pruned = _prune_empty_sections(path)
        assert pruned == 0

        xml = _document_xml_of(path)
        assert 'Experience' in xml
        assert 'Education' in xml
        assert 'Lead engineer at Acme Inc.' in xml
        assert 'M.Sc. AI, MIT' in xml


def test_prunes_last_empty_section_at_end_of_body():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'sample.docx')
        body = (
            _heading_p('Experience')
            + _content_p('Backend engineer')
            + _heading_p('References')
            + _empty_p()
        )
        _make_docx(path, body)

        pruned = _prune_empty_sections(path)
        assert pruned == 1

        xml = _document_xml_of(path)
        assert 'References' not in xml
        assert 'Experience' in xml


def test_prunes_multiple_consecutive_empty_sections():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'sample.docx')
        body = (
            _heading_p('Experience')
            + _content_p('Senior dev')
            + _heading_p('Awards')
            + _empty_p()
            + _heading_p('Volunteer')
            + _empty_p()
            + _heading_p('Skills')
            + _content_p('Python, Go')
        )
        _make_docx(path, body)

        pruned = _prune_empty_sections(path)
        assert pruned == 2

        xml = _document_xml_of(path)
        assert 'Awards' not in xml
        assert 'Volunteer' not in xml
        assert 'Skills' in xml
        assert 'Python, Go' in xml
        assert 'Senior dev' in xml


def test_no_op_when_no_section_headings_present():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'sample.docx')
        body = _content_p('Some plain text without any section headings.')
        _make_docx(path, body)

        pruned = _prune_empty_sections(path)
        assert pruned == 0

        xml = _document_xml_of(path)
        assert 'Some plain text without any section headings.' in xml


def test_resulting_docx_is_well_formed():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'sample.docx')
        body = (
            _heading_p('Experience')
            + _content_p('Engineer')
            + _heading_p('References')
            + _empty_p()
        )
        _make_docx(path, body)
        _prune_empty_sections(path)

        xml = _document_xml_of(path)
        # Must still parse cleanly and still contain a body
        tree = etree.fromstring(xml.encode('utf-8'))
        body_el = tree.find(f'{{{W_NS}}}body')
        assert body_el is not None


def test_prunes_heading_with_trailing_colon_when_body_is_empty():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'sample.docx')
        body = (
            _heading_p('Skills:')
            + _empty_p()
            + _heading_p('Experience')
            + _content_p('Senior dev')
        )
        _make_docx(path, body)

        pruned = _prune_empty_sections(path)
        assert pruned == 1

        xml = _document_xml_of(path)
        assert 'Skills:' not in xml
        assert 'Experience' in xml
        assert 'Senior dev' in xml
