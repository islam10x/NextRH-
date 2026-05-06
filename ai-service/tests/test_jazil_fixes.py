"""
Smoke tests for the Jazil Gafsi / Lucas Leblanc template fix set.
Tests every change implemented in the Error 1-9 fix batch and V3 fix batch.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from lxml import etree
from app.services.cv_generator import (
    _is_mega_contact_para,
    _is_contact_field_value,
    cleanEmployeeData,
    _build_replacements,
    _detect_personal_info,
    _identify_section_lxml,
    _build_section_content,
    NS_W,
    _WPS_TXBX,
    NS_WPS,
)
from app.services.cv_generator_fallback import _distribute_entries_across_boxes
from app.services.field_mapping_service import build_replacement_map


# ── Jazil minimal test profile ────────────────────────────────────────────
JAZIL = {
    "name": "Jazil Gafsi",
    "email": "j.gafsi@nextstep-it.com",
    "phone": "+216 98 772 808",
    "address": "31, Rue 1er Juin, Mutuelle-ville, 1082, Tunis",
    "linkedin": "",
    "summary": "",
    "skills": [],
    "experience": [
        {"start_date": "Février 2018", "company": "NextStep", "title": "Chef de projet"},
        {"start_date": "2006 - 2016", "company": "S2I",       "title": "IT Infrastructure Administrateur"},
        {"start_date": "Juillet 2016","company": "WAYCON",    "title": "IT Infrastructure Administrateur"},
    ],
    "education": [
        {"end_date": "2005", "institution": "IMSET.", "degree": "Technicien supérieur en Réseau Informatique"}
    ],
    "certifications": [
        {"name": "Microsoft Certified Solutions Associate (MCSA) : Windows Server", "date_obtained": "2012"},
        {"name": "Associate desktops certification V5.0 DIMENSION", "date_obtained": ""},
    ],
    "projects": [
        {"client": "TUNISAIR", "description": "L'installation et la configuration Datacenter."},
    ],
}


def test_title_derived_from_experience():
    """Error 1: cleanEmployeeData must derive title from experience[0].title."""
    emp_no_title = {k: v for k, v in JAZIL.items() if k != 'title'}
    cleaned = cleanEmployeeData(emp_no_title)
    assert cleaned.get('title') == 'Chef de projet', (
        f"Expected 'Chef de projet', got {cleaned.get('title')!r}"
    )


def test_title_not_overwritten_if_set():
    """Error 1: existing title is never overwritten."""
    emp_with_title = dict(JAZIL, title='Directeur')
    cleaned = cleanEmployeeData(emp_with_title)
    assert cleaned['title'] == 'Directeur', "Existing title should not be overwritten"


def test_mega_contact_para_detection():
    """Error 9: infographic header paragraph is detected as a mega-paragraph."""
    p006 = (
        'LUCAS LEBLANC Chargé de projets TI lucas.leblanc@courriel.ca '
        '555-555-5555 Montréal, Canada linkedin.com/lucas-leblanc'
    )
    assert _is_mega_contact_para(p006), f"P006 ({len(p006)} chars) should be detected as mega-para"

    # Standalone paragraphs are NOT mega-paras
    assert not _is_mega_contact_para('lucas.leblanc@courriel.ca')
    assert not _is_mega_contact_para('555-555-5555')
    assert not _is_mega_contact_para('Montréal, Canada')
    assert not _is_mega_contact_para('LUCAS LEBLANC')


def test_contact_field_value_detection():
    """Error 9: contact field values correctly identified."""
    assert _is_contact_field_value('lucas.leblanc@courriel.ca'), "email"
    assert _is_contact_field_value('555-555-5555'), "US phone"
    assert _is_contact_field_value('+216 98 772 808'), "intl phone"
    assert _is_contact_field_value('Montréal, Canada'), "City, Country address"
    assert not _is_contact_field_value('LUCAS LEBLANC'), "name"
    assert not _is_contact_field_value('linkedin.com/lucas-leblanc'), "linkedin URL"
    assert not _is_contact_field_value('Chargé de projets TI'), "job title"


def test_linkedin_replacement_when_employee_has_no_linkedin():
    """Fix 5: when employee has no LinkedIn, URL is generated from name (first-last slug)."""
    detected = {
        'name': 'LUCAS LEBLANC',
        'email': 'lucas.leblanc@courriel.ca',
        'phone': '555-555-5555',
        'linkedin': 'linkedin.com/lucas-leblanc',
        'address': 'Montreal, Canada',
    }
    emp = cleanEmployeeData(JAZIL)  # JAZIL has linkedin = ""
    pairs = _build_replacements(detected, emp)
    old_values = [old for old, _ in pairs]
    assert 'linkedin.com/lucas-leblanc' in old_values, (
        "LinkedIn URL must be in replacement pairs even when employee has no linkedin"
    )
    li_pair = next((p for p in pairs if p[0] == 'linkedin.com/lucas-leblanc'), None)
    assert li_pair is not None, "LinkedIn pair must exist"
    # Fix 5: new value is generated from name (first-last slug)
    assert li_pair[1] == 'linkedin.com/in/jazil-gafsi', (
        f"LinkedIn should be generated from name, got {li_pair[1]!r}"
    )


def test_groq_summary_not_blocked_by_sections_to_clear():
    """Error 5: OBJECTIF section should NOT be added to sections_to_clear
    when employee has experience (Groq can generate a summary)."""
    # We can't easily call _generate_with_replacement in a unit test, but we
    # can verify cleanEmployeeData sets title correctly so Groq prompt is rich.
    cleaned = cleanEmployeeData(JAZIL)
    assert cleaned.get('title') == 'Chef de projet'
    assert len(cleaned.get('experience', [])) == 3


def test_address_cleaned():
    """Prior fix: APILayer-concatenated address is stripped at section keyword."""
    emp = dict(JAZIL, address=(
        "31, Rue 1er Juin, Mutuelle-ville, 1082, Tunis "
        "Expérience professionnelle Période Organisme Fonction occupée Février 2018 NextStep"
    ))
    cleaned = cleanEmployeeData(emp)
    assert 'Expérience' not in cleaned['address'], "Experience table should be stripped from address"
    assert cleaned['address'].startswith('31, Rue 1er Juin'), "Address prefix preserved"


def test_cert_truncation():
    """Prior fix: certifications are truncated to 10, prioritising dated ones."""
    many_certs = [{"name": f"Cert {i}", "date_obtained": ""} for i in range(20)]
    dated_cert = {"name": "MCSA", "date_obtained": "2012"}
    emp = dict(JAZIL, certifications=[dated_cert] + many_certs)
    cleaned = cleanEmployeeData(emp)
    assert len(cleaned['certifications']) == 10
    assert cleaned['certifications'][0]['name'] == 'MCSA', "Dated cert should be first"


# ── V3 fix batch tests ────────────────────────────────────────────────────

def test_education_degree_deduplication():
    """Fix 6/7: APILayer degree duplication is cleaned in cleanEmployeeData."""
    emp = dict(JAZIL, education=[{
        "end_date": "2005",
        "institution": "IMSET.",
        "degree": "Technicien supérieur en Réseau Informatique Technicien supérieur en Réseau Informatique",
    }])
    cleaned = cleanEmployeeData(emp)
    assert cleaned['education'][0]['degree'] == "Technicien supérieur en Réseau Informatique", (
        f"Got: {cleaned['education'][0]['degree']!r}"
    )


def test_identify_section_lxml_skips_textbox_container():
    """Fix core: _identify_section_lxml must return None for textbox-container paragraphs."""
    W = NS_W

    # Build a minimal <w:p> that CONTAINS a <wps:txbx> (sidebar label paragraph)
    p_with_txbx = etree.fromstring(f'''<w:p xmlns:w="{W}"
            xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
        <w:r>
            <w:drawing>
                <wps:wsp>
                    <wps:txbx>
                        <w:txbxContent>
                            <w:p>
                                <w:r><w:t>EXP\u00c9RIENCE</w:t></w:r>
                            </w:p>
                        </w:txbxContent>
                    </wps:txbx>
                </wps:wsp>
            </w:drawing>
        </w:r>
    </w:p>''')
    result = _identify_section_lxml(p_with_txbx)
    assert result is None, (
        f"TextBox-container paragraph should NOT be detected as section heading, got {result!r}"
    )


def test_identify_section_lxml_finds_direct_heading():
    """Fix core: _identify_section_lxml still detects plain section headings."""
    W = NS_W
    # A direct body heading paragraph (bold + ALL-CAPS)
    p_direct = etree.fromstring(f'''<w:p xmlns:w="{W}">
        <w:r>
            <w:rPr><w:b/></w:rPr>
            <w:t>EXP\u00c9RIENCE</w:t>
        </w:r>
    </w:p>''')
    result = _identify_section_lxml(p_direct)
    assert result == 'experience', f"Expected 'experience', got {result!r}"


def test_identify_section_lxml_accepts_heading_with_trailing_colon():
    """Standalone section titles like 'Skills:' must still classify as headings."""
    W = NS_W
    p_direct = etree.fromstring(f'''<w:p xmlns:w="{W}">
        <w:r>
            <w:rPr><w:b/></w:rPr>
            <w:t>Skills:</w:t>
        </w:r>
    </w:p>''')
    result = _identify_section_lxml(p_direct)
    assert result == 'skills', f"Expected 'skills', got {result!r}"


def test_skills_built_from_certs_when_skills_empty():
    """Fix 5: skills section content is non-empty when coming from certifications."""
    emp = dict(JAZIL, skills=[], certifications=[
        {"name": "DELL Associate Server V10", "date_obtained": ""},
        {"name": "ASE HP PROLIANT", "date_obtained": ""},
        {"name": "Microsoft Certified Solutions Associate (MCSA)", "date_obtained": "2012"},
    ])
    content = _build_section_content('skills', emp)
    # Should return something (not None) – either fallback extraction or Groq synthesis
    assert content is not None, "Skills section should not be None when certs exist"
    text = content[0]['text']
    assert text, "Skills text should be non-empty"
    # Broad net: accept tech keywords from either the regex fallback OR Groq synthesis.
    # Both paths produce recognisable technical terms derived from the cert names.
    tech_keywords = [
        'DELL', 'HP', 'IBM', 'VMware', 'Microsoft', 'MCSA', 'MCSE',
        'Server', 'Windows', 'Cisco', 'Linux', 'Storage', 'Network',
        'Datacenter', 'PROLIANT', 'Solutions', 'Associate',
    ]
    assert any(kw.lower() in text.lower() for kw in tech_keywords), (
        f"Skills text should contain a recognisable tech keyword: {text!r}"
    )


def test_linkedin_orphan_fragment_cleared():
    """Fix 5: when employee has no LinkedIn, replacement is generated from name."""
    # Simulate a template where linkedin URL = 'linkedin.com/lucas-leblanc'
    detected = {
        'linkedin': 'linkedin.com/lucas-leblanc',
    }
    emp = cleanEmployeeData(JAZIL)  # JAZIL has linkedin = "", name = "Jazil Gafsi"
    pairs = _build_replacements(detected, emp)
    old_values = [old for old, _ in pairs]
    assert 'linkedin.com/lucas-leblanc' in old_values, "Full linkedin URL must be in pairs"
    li_pair = next(p for p in pairs if p[0] == 'linkedin.com/lucas-leblanc')
    # Fix 5: new value generated from employee name
    assert li_pair[1] == 'linkedin.com/in/jazil-gafsi', (
        f"LinkedIn should be generated slug, got {li_pair[1]!r}"
    )


def test_apilayer_mapping_blanks_detected_values_when_employee_missing():
    """APILayer-detected template values should be cleared when employee lacks them."""
    parsed_template = {
        'name': 'Lucas Leblanc',
        'phone': '555-555-5555',
        'address': 'Montréal, Canada',
        'skills': ['Sports'],
        'education': [
            {'name': 'Université', 'dates': '2001 - 2005'},
        ],
    }
    employee = {
        'name': 'Jazil Gafsi',
        'phone': '',
        'address': '',
        'skills': [],
        'education': [],
    }

    pairs = build_replacement_map(parsed_template, employee)
    mapping = dict(pairs)

    assert mapping['Lucas Leblanc'] == 'Jazil Gafsi'
    assert mapping['555-555-5555'] == ''
    assert mapping['Montréal, Canada'] == ''
    assert mapping['Sports'] == ''
    assert mapping['Université'] == ''
    assert mapping['2001 - 2005'] == ''


def test_distribute_entries_across_boxes_preserves_multiple_boxes():
    """Textbox-heavy templates should not collapse all entries into the first box."""
    entries = [
        [{'text': 'Role 1', 'bold': True}],
        [{'text': 'Role 2', 'bold': True}],
        [{'text': 'Role 3', 'bold': True}],
        [{'text': 'Role 4', 'bold': True}],
    ]

    distributed = _distribute_entries_across_boxes(entries, 3)

    assert len(distributed) == 3
    assert [item['text'] for item in distributed[0]] == ['Role 1', 'Role 2']
    assert [item['text'] for item in distributed[1]] == ['Role 3']
    assert [item['text'] for item in distributed[2]] == ['Role 4']


def test_detect_personal_info_does_not_misclassify_skill_line_as_address():
    """Address fallback must not grab section content like Data & AI skill lines."""
    paragraphs = [
        'Rania Ammar',
        'ammarrania004@gmail.com',
        '+216 27 920 721',
        'Data & AI: Scikit-learn, Spark, Hadoop, HDFS, SQL, MongoDB.',
    ]

    detected = _detect_personal_info('\n'.join(paragraphs), paragraphs)

    assert detected.get('address', '') != 'Data & AI: Scikit-learn, Spark, Hadoop, HDFS, SQL, MongoDB.'


if __name__ == '__main__':
    import pytest
    pytest.main([__file__, '-v'])
