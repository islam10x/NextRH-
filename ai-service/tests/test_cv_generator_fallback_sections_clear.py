import os
import sys


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.cv_generator_fallback import (
    _canonicalize_section_label_for_clearing,
    _derive_deterministic_sections_to_clear,
)


def test_deterministic_clear_detects_communication_and_direction():
    paragraphs = [
        "CURRICULUM VITAE",
        "Communication",
        "Direction",
        "Expérience professionnelle",
    ]
    employee = {
        "name": "Jazil Gafsi",
        "skills": ["Python", "Docker"],
        "experience": [{"title": "Project Manager", "company": "NextStep"}],
    }

    to_clear = _derive_deterministic_sections_to_clear(paragraphs, employee)

    assert "Communication" in to_clear
    assert "Direction" in to_clear


def test_deterministic_clear_skips_when_dedicated_data_exists():
    paragraphs = ["Communication", "Direction"]
    employee = {
        "communication": "Clear and concise stakeholder updates.",
        "leadership": "Managed a team of 8 engineers.",
    }

    to_clear = _derive_deterministic_sections_to_clear(paragraphs, employee)

    assert to_clear == []


def test_deterministic_clear_clears_missing_canonical_sections_but_keeps_populated_ones():
    paragraphs = ["Projects:", "Experience", "Languages"]
    employee = {
        "experience": [{"title": "Project Manager", "company": "NextStep"}],
        "languages": ["French", "English"],
        "projects": [],
    }

    to_clear = _derive_deterministic_sections_to_clear(paragraphs, employee)

    assert "Projects:" in to_clear
    assert "Experience" not in to_clear
    assert "Languages" not in to_clear


def test_deterministic_clear_does_not_treat_short_content_sentences_as_titles():
    paragraphs = [
        "Sens de la communication",
        "Gérer la communication entre les différents acteurs du projet.",
        "Formation en gestion de projets :",
        "Principales missions :",
        "Leadership",
        "CENTRES D’INTÉRÊT",
    ]
    employee = {
        "interests": [],
        "leadership": "",
    }

    to_clear = _derive_deterministic_sections_to_clear(paragraphs, employee)

    assert "Leadership" in to_clear
    assert "CENTRES D’INTÉRÊT" in to_clear
    assert "Sens de la communication" not in to_clear
    assert "Gérer la communication entre les différents acteurs du projet." not in to_clear
    assert "Formation en gestion de projets :" not in to_clear
    assert "Principales missions :" not in to_clear


def test_conservative_clearing_rejects_ambiguous_heading_sentences():
    assert _canonicalize_section_label_for_clearing("Languages used in Java projects") is None
    assert _canonicalize_section_label_for_clearing("Description of a project I worked on") is None
    assert _canonicalize_section_label_for_clearing("Languages") == "languages"
