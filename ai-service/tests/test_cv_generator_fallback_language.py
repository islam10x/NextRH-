import os
import sys


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.cv_generator_fallback import (
    _AI_PROMPT,
    _language_instruction,
    _normalize_language_code,
)


def test_language_code_normalization():
    assert _normalize_language_code("fr") == "fr"
    assert _normalize_language_code("fr-FR") == "fr"
    assert _normalize_language_code("EN-us") == "en"
    assert _normalize_language_code("original") == "original"


def test_language_instruction_for_french_is_strict():
    rule = _language_instruction("fr")
    assert "French" in rule
    assert "Do not output English" in rule


def test_ai_prompt_accepts_language_hint_placeholder():
    prompt = _AI_PROMPT.format(
        template_text="CV template sample",
        employee_json='{"name":"Test"}',
        populated_sections="summary/profile/objective",
        language_hint="Write strictly in French. Do not output English.",
    )
    assert "Write strictly in French" in prompt
