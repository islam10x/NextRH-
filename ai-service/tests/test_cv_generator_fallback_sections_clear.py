import os
import sys


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.cv_generator_fallback import _derive_deterministic_sections_to_clear


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
