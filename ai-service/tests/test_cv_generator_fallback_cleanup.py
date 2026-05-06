import os
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.services.cv_generator_fallback import (
    _detect_generic_placeholders,
    _final_quality_control_cleanup,
    _quality_check,
)


def _make_docx(path: str, document_text: str, glossary_text: str = '') -> None:
    document_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>{document_text}</w:t></w:r></w:p>
      </w:body>
    </w:document>'''
    glossary_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:glossaryDocument xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:docParts>
        <w:docPart><w:docPartBody><w:p><w:r><w:t>{glossary_text}</w:t></w:r></w:p></w:docPartBody></w:docPart>
      </w:docParts>
    </w:glossaryDocument>'''
    with zipfile.ZipFile(path, 'w') as zf:
        zf.writestr('word/document.xml', document_xml)
        zf.writestr('word/glossary/document.xml', glossary_xml)
        zf.writestr(
            '[Content_Types].xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '</Types>',
        )
        zf.writestr(
            '_rels/.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '</Relationships>',
        )


def test_generic_placeholder_detection_blanks_20xx_ranges():
    pairs = _detect_generic_placeholders(
        ['Universite de Glenwood Aout 20XX – mai 20XX'],
        {'summary': '', 'skills': [], 'experience': []},
    )

    assert pairs
    assert pairs[0][0] == 'Universite de Glenwood Aout 20XX – mai 20XX'
    assert '20XX' not in pairs[0][1]


def test_quality_check_ignores_glossary_placeholders():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'sample.docx')
        _make_docx(path, 'Visible content', 'Aout 20XX – mai 20XX')

        issues = _quality_check(path, {'name': 'Jazil Gafsi'})

        assert not any('20xx date placeholder' in issue.lower() for issue in issues)


def test_final_cleanup_removes_visible_20xx_placeholder():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'sample.docx')
        _make_docx(path, 'Aout 20XX – mai 20XX')

        _final_quality_control_cleanup(path)

        with zipfile.ZipFile(path) as zf:
            document_xml = zf.read('word/document.xml').decode('utf-8', errors='ignore')

        assert '20XX' not in document_xml