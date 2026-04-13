"""
Tests for _get_paragraph_texts deduplication fix.

Validates that text extraction from DOCX XML does NOT produce duplicated
text from textbox/VML/DrawingML layers.
"""
import pytest
from lxml import etree

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.services.cv_generator import (
    _get_paragraph_texts,
    _detect_personal_info,
    NS_W, NS_A, NS_MC, NS_WPS,
)


# ── Helpers ───────────────────────────────────────────────────────────

def _minimal_docxml(*body_children: str) -> bytes:
    """Wrap body children XML in a minimal document.xml envelope."""
    children = '\n'.join(body_children)
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
            xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:v="urn:schemas-microsoft-com:vml"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    {children}
  </w:body>
</w:document>""".encode('utf-8')


# ── Test: body paragraph text only (no nesting) ──────────────────────

def test_simple_body_paragraph():
    xml = _minimal_docxml(
        '<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>'
    )
    paras = _get_paragraph_texts(xml)
    assert paras == ['Hello World']


def test_multiple_body_paragraphs():
    xml = _minimal_docxml(
        '<w:p><w:r><w:t>Line 1</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>Line 2</w:t></w:r></w:p>',
    )
    paras = _get_paragraph_texts(xml)
    assert paras == ['Line 1', 'Line 2']


# ── Test: textbox inside body paragraph ──────────────────────────────

def test_body_para_with_textbox_excludes_nested_text():
    """Body paragraph that embeds a textbox should NOT include textbox text."""
    xml = _minimal_docxml("""
    <w:p>
      <w:r><w:t>Body text</w:t></w:r>
      <w:r>
        <w:drawing>
          <wp:anchor>
            <a:graphic>
              <a:graphicData>
                <wps:wsp>
                  <wps:txbx>
                    <w:txbxContent>
                      <w:p><w:r><w:t>Textbox text</w:t></w:r></w:p>
                    </w:txbxContent>
                  </wps:txbx>
                </wps:wsp>
              </a:graphicData>
            </a:graphic>
          </wp:anchor>
        </w:drawing>
      </w:r>
    </w:p>
    """)
    paras = _get_paragraph_texts(xml)
    assert 'Body text' in paras
    assert 'Textbox text' in paras
    # The crucial check: "Body textTextbox text" must NOT appear
    for p in paras:
        assert 'Body textTextbox text' not in p


def test_textbox_only_paragraph():
    """Body paragraph with ONLY a textbox (no own text) should yield nothing
    for the body paragraph; the textbox paragraph should yield its text."""
    xml = _minimal_docxml("""
    <w:p>
      <w:r>
        <w:drawing>
          <wp:anchor>
            <a:graphic>
              <a:graphicData>
                <wps:wsp>
                  <wps:txbx>
                    <w:txbxContent>
                      <w:p><w:r><w:t>LUCAS LEBLANC</w:t></w:r></w:p>
                    </w:txbxContent>
                  </wps:txbx>
                </wps:wsp>
              </a:graphicData>
            </a:graphic>
          </wp:anchor>
        </w:drawing>
      </w:r>
    </w:p>
    """)
    paras = _get_paragraph_texts(xml)
    assert paras == ['LUCAS LEBLANC']


# ── Test: mc:AlternateContent with VML fallback ─────────────────────

def test_mc_alternate_content_no_duplication():
    """Text in mc:Choice textbox should appear once; mc:Fallback is skipped."""
    xml = _minimal_docxml("""
    <w:p>
      <mc:AlternateContent>
        <mc:Choice Requires="wps">
          <w:r>
            <w:drawing>
              <wp:anchor>
                <a:graphic>
                  <a:graphicData>
                    <wps:wsp>
                      <wps:txbx>
                        <w:txbxContent>
                          <w:p><w:r><w:t>lucas.leblanc@courriel.ca</w:t></w:r></w:p>
                        </w:txbxContent>
                      </wps:txbx>
                    </wps:wsp>
                  </a:graphicData>
                </a:graphic>
              </wp:anchor>
            </w:drawing>
          </w:r>
        </mc:Choice>
        <mc:Fallback>
          <w:r>
            <w:pict>
              <v:shape>
                <v:textbox>
                  <w:txbxContent>
                    <w:p><w:r><w:t>lucas.leblanc@courriel.ca</w:t></w:r></w:p>
                  </w:txbxContent>
                </v:textbox>
              </v:shape>
            </w:pict>
          </w:r>
        </mc:Fallback>
      </mc:AlternateContent>
    </w:p>
    """)
    paras = _get_paragraph_texts(xml)
    # Must appear exactly once
    assert paras.count('lucas.leblanc@courriel.ca') == 1


# ── Test: full infographic contact block ─────────────────────────────

def _make_txbx_para(text: str) -> str:
    """Generate mc:AlternateContent with WPS textbox + VML fallback."""
    return f"""
    <w:p>
      <mc:AlternateContent>
        <mc:Choice Requires="wps">
          <w:r><w:drawing><wp:anchor><a:graphic><a:graphicData>
            <wps:wsp><wps:txbx><w:txbxContent>
              <w:p><w:r><w:t>{text}</w:t></w:r></w:p>
            </w:txbxContent></wps:txbx></wps:wsp>
          </a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>
        </mc:Choice>
        <mc:Fallback>
          <w:r><w:pict><v:shape><v:textbox><w:txbxContent>
            <w:p><w:r><w:t>{text}</w:t></w:r></w:p>
          </w:txbxContent></v:textbox></v:shape></w:pict></w:r>
        </mc:Fallback>
      </mc:AlternateContent>
    </w:p>"""


def test_infographic_contact_block_no_duplication():
    """Simulate a Lucas Leblanc-style infographic template contact header.
    Each field should appear exactly once, with no concatenated garbage."""
    xml = _minimal_docxml(
        _make_txbx_para('CHARGÉ DE PROJETS TI'),
        _make_txbx_para('LUCAS LEBLANC'),
        _make_txbx_para('lucas.leblanc@courriel.ca'),
        _make_txbx_para('555-555-5555'),
        _make_txbx_para('linkedin.com/lucas-leblanc'),
        _make_txbx_para('Montréal, Canada'),
    )
    paras = _get_paragraph_texts(xml)

    assert 'CHARGÉ DE PROJETS TI' in paras
    assert 'LUCAS LEBLANC' in paras
    assert 'lucas.leblanc@courriel.ca' in paras
    assert '555-555-5555' in paras
    assert 'linkedin.com/lucas-leblanc' in paras
    assert 'Montréal, Canada' in paras

    # No duplicates
    for text in paras:
        assert paras.count(text) == 1, f"Duplicate paragraph: {text!r}"

    # No concatenated garbage
    for text in paras:
        assert 'CHARGÉ DE PROJETS TICHARGÉ' not in text
        assert 'LUCAS LEBLANCLUCAS' not in text
        assert 'Canadalucas' not in text


# ── Test: contact detection with clean extraction ────────────────────

def test_detect_personal_info_with_clean_paragraphs():
    """After extraction fix, _detect_personal_info should correctly
    identify name vs title vs email."""
    paragraphs = [
        'CHARGÉ DE PROJETS TI',
        'LUCAS LEBLANC',
        'lucas.leblanc@courriel.ca',
        '555-555-5555',
        'linkedin.com/lucas-leblanc',
        'Montréal, Canada',
        'EXPÉRIENCE',
        'Juil. 2018 – Aujourd\'hui',
    ]
    full_text = '\n'.join(paragraphs)
    detected = _detect_personal_info(full_text, paragraphs)

    # Name should be LUCAS LEBLANC (not the title)
    assert detected.get('name') == 'LUCAS LEBLANC', \
        f"Expected name='LUCAS LEBLANC', got {detected.get('name')!r}"

    # Email should be clean (no garbage)
    assert detected.get('email') == 'lucas.leblanc@courriel.ca'

    # Phone
    assert detected.get('phone') == '555-555-5555'

    # Title should be CHARGÉ DE PROJETS TI (detected via Step 6b)
    assert detected.get('title') == 'CHARGÉ DE PROJETS TI', \
        f"Expected title='CHARGÉ DE PROJETS TI', got {detected.get('title')!r}"


def test_detect_title_from_job_keywords():
    """Step 6b should detect title paragraphs containing job keywords."""
    paragraphs = [
        'DÉVELOPPEUR FULL STACK',
        'JEAN DUPONT',
        'jean.dupont@email.com',
        '06 12 34 56 78',
        'Paris, France',
        'EXPÉRIENCE',
    ]
    full_text = '\n'.join(paragraphs)
    detected = _detect_personal_info(full_text, paragraphs)

    assert detected.get('name') == 'JEAN DUPONT'
    assert detected.get('title') == 'DÉVELOPPEUR FULL STACK'


def test_detect_title_not_section_heading():
    """Section headings like FORMATION should not be mistaken for a title."""
    paragraphs = [
        'JEAN DUPONT',
        'jean.dupont@email.com',
        '06 12 34 56 78',
        'FORMATION',
        'Université de Paris',
    ]
    full_text = '\n'.join(paragraphs)
    detected = _detect_personal_info(full_text, paragraphs)

    assert detected.get('name') == 'JEAN DUPONT'
    # Title should NOT be 'FORMATION' (section heading)
    assert detected.get('title') != 'FORMATION'
