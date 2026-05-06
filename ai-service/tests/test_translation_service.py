"""
Regression tests for CV translation quality and schema preservation.
"""

import copy
import json
import sys
from pathlib import Path
from typing import Any, Dict
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api.generation import _TranslateRequest
from app.services.translation_service import (
    translate_cv_data,
    translate_cv_best_effort,
    translate_cv_structured,
)


def _fake_groq_client(payload: Dict[str, Any]) -> MagicMock:
    response = MagicMock()
    response.choices = [
        MagicMock(message=MagicMock(content=json.dumps(payload, ensure_ascii=False)))
    ]
    client = MagicMock()
    client.chat.completions.create.return_value = response
    return client


@pytest.fixture
def sample_cv() -> Dict[str, Any]:
    return {
        "name": "Aya BEN JEMAA",
        "firstName": "Aya",
        "lastName": "BEN JEMAA",
        "email": "aya.benjemaa@example.com",
        "phone": "+216 98 772 817",
        "linkedin": "linkedin.com/in/ayabenjemaa",
        "address": "Tunis, Tunisia",
        "title": "Software Engineer",
        "summary": "Experienced full-stack engineer focused on HR platforms.",
        "skills": ["Communication", "Python"],
        "languages": ["French", "English"],
        "certifications": ["AWS Solutions Architect"],
        "experience": [
            {
                "title": "Software Engineer",
                "company": "TechCorp",
                "dates": "2023 - Present",
                "description": "Built HR workflows and internal tooling.",
            },
            {
                "title": "Junior Developer",
                "company": "StartupXYZ",
                "dates": "2021 - 2023",
                "description": "Maintained backend services in Python.",
            },
        ],
        "education": [
            {
                "degree": "Engineering Degree in Software Engineering",
                "institution": "University of Tunis",
                "description": "Software engineering curriculum.",
            }
        ],
        "projects": [
            {
                "name": "Talent Portal",
                "role": "Lead Developer",
                "description": "Built an internal employee portal.",
                "client": "Internal HR",
            }
        ],
    }


def test_translate_request_preserves_full_cv_payload():
    request = _TranslateRequest.model_validate(
        {
            "target_language": "fr",
            "cv_data": {
                "name": "Aya BEN JEMAA",
                "address": "Tunis, Tunisia",
                "languages": ["French", "English"],
                "certifications": ["AWS Solutions Architect"],
                "projects": [{"name": "Talent Portal", "description": "Built portal"}],
                "customSection": ["Mentoring"],
            },
        }
    )

    assert request.cv_data["address"] == "Tunis, Tunisia"
    assert request.cv_data["languages"] == ["French", "English"]
    assert request.cv_data["certifications"] == ["AWS Solutions Architect"]
    assert request.cv_data["projects"][0]["name"] == "Talent Portal"
    assert request.cv_data["customSection"] == ["Mentoring"]


def test_translate_cv_structured_preserves_shape_and_protected_fields(sample_cv):
    llm_payload = {
        "name": "Aya traduite",
        "title": "Ingenieure logicielle",
        "summary": "Ingenieure full-stack experimentee.",
        "address": "Tunis, Tunisie",
        "skills": ["Communication"],
        "languages": ["Arabe"],
        "experience": [
            {
                "title": "Ingenieure logicielle",
                "company": "Entreprise modifiee",
                "description": "Developpement d'outils RH.",
            }
        ],
        "education": [
            {
                "degree": "Diplome d'ingenieur"
            }
        ],
        "projects": [],
        "certifications": [],
    }

    with patch(
        "app.services.translation_service._groq_client",
        return_value=_fake_groq_client(llm_payload),
    ):
        translated = translate_cv_structured(
            {"target_language": "fr", "cv_data": copy.deepcopy(sample_cv)}
        )

    assert translated["name"] == sample_cv["name"]
    assert translated["email"] == sample_cv["email"]
    assert translated["phone"] == sample_cv["phone"]
    assert translated["address"] == "Tunis, Tunisie"
    assert translated["title"] == "Ingenieure logicielle"
    assert translated["summary"] == "Ingenieure full-stack experimentee."
    assert translated["skills"] == ["Communication", "Python"]
    assert translated["languages"] == ["Arabe", "English"]
    assert len(translated["experience"]) == 2
    assert translated["experience"][0]["company"] == "TechCorp"
    assert translated["experience"][0]["dates"] == "2023 - Present"
    assert translated["experience"][0]["description"] == "Developpement d'outils RH."
    assert translated["experience"][1] == sample_cv["experience"][1]
    assert translated["education"][0]["institution"] == "University of Tunis"
    assert translated["certifications"] == sample_cv["certifications"]
    assert translated["projects"] == sample_cv["projects"]


def test_translate_cv_best_effort_uses_field_fallback_when_semantic_is_unchanged():
    source = {
        "name": "Aya BEN JEMAA",
        "title": "Ingenieure logicielle",
        "summary": "Resume source",
        "experience": [],
        "education": [],
        "skills": [],
    }
    fallback = {
        "name": "Aya BEN JEMAA",
        "title": "Software Engineer",
        "summary": "Professional summary",
        "experience": [],
        "education": [],
        "skills": [],
    }

    with patch(
        "app.services.translation_service.translate_cv_structured",
        return_value=copy.deepcopy(source),
    ), patch(
        "app.services.translation_service.translate_cv_data",
        return_value=copy.deepcopy(fallback),
    ):
        translated = translate_cv_best_effort(copy.deepcopy(source), "en")

    assert translated["name"] == source["name"]
    assert translated["title"] == "Software Engineer"
    assert translated["summary"] == "Professional summary"


def test_translate_cv_data_translates_address_field():
    source = {
        "name": "Aya BEN JEMAA",
        "address": "Tunis, Tunisia",
        "title": "Software Engineer",
        "summary": "Experienced engineer.",
        "experience": [],
        "education": [],
        "skills": [],
    }

    with patch(
        "app.services.translation_service._translate_batch",
        return_value=["Ingenieure logicielle", "Ingenieure experimentee.", "Tunis, Tunisie"],
    ):
        translated = translate_cv_data(copy.deepcopy(source), "fr")

    assert translated["address"] == "Tunis, Tunisie"
    assert translated["title"] == "Ingenieure logicielle"
    assert translated["summary"] == "Ingenieure experimentee."


def test_translate_cv_best_effort_rejects_candidates_that_change_identity():
    source = {
        "name": "Aya BEN JEMAA",
        "email": "aya.benjemaa@example.com",
        "phone": "+216 98 772 817",
        "title": "Ingenieure logicielle",
        "summary": "Resume source",
        "experience": [],
        "education": [],
        "skills": [],
    }
    unsafe = {
        "name": "Aya Traduite",
        "email": "aya.benjemaa@example.com",
        "phone": "+216 98 772 817",
        "title": "Software Engineer",
        "summary": "Professional summary",
        "experience": [],
        "education": [],
        "skills": [],
    }

    with patch(
        "app.services.translation_service.translate_cv_structured",
        return_value=copy.deepcopy(unsafe),
    ), patch(
        "app.services.translation_service.translate_cv_data",
        return_value=copy.deepcopy(unsafe),
    ):
        translated = translate_cv_best_effort(copy.deepcopy(source), "en")

    assert translated == source