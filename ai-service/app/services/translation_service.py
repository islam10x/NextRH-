import json
import logging
from typing import Any, Dict, Optional

from app.config import settings
from app.utils.llm import parse_json_object
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage

logger = logging.getLogger(__name__)


def _build_translation_llm():
    return ChatGroq(
        model=settings.GROQ_CV_MODEL,
        api_key=settings.GROQ_API_KEY,
        temperature=0.0,
    )


def translate_json_payload(
    payload: Dict[str, Any],
    target_language: str,
    source_language: Optional[str] = None,
) -> Dict[str, Any]:
    """Translate all string values in a JSON payload, preserving structure."""
    if not payload or not target_language or not settings.TRANSLATION_ENABLED:
        return payload

    llm = _build_translation_llm()
    sys_prompt = (
        "You are a precise translation engine. You must translate ALL string values in the incoming JSON payload "
        "to the requested target language.\n\n"
        "CRITICAL RULES:\n"
        "1. DO NOT TRANSLATE THE JSON KEYS. Keys (like 'jobTitle', 'description', 'skills', etc.) MUST remain "
        "exactly as they appear in the source JSON. Only translate the VALUES.\n"
        "2. Do NOT translate technical proper nouns, emails, URLs, or dates.\n"
        "3. You must retain the exact JSON structure (lists, objects).\n"
        "4. Your response must be NOTHING BUT raw, parsable JSON."
    )
    lang_hint = f"Target language: {target_language}."
    if source_language:
        lang_hint += f" Source language: {source_language}."

    raw = json.dumps(payload, ensure_ascii=False)
    msg = f"{lang_hint}\nJSON:\n{raw}"
    try:
        response = llm.invoke([SystemMessage(content=sys_prompt), HumanMessage(content=msg)])
        content = str(getattr(response, "content", "") or "").strip()
        translated = parse_json_object(content)
        if isinstance(translated, dict):
            return translated
        logger.warning("Translation returned non-JSON output, using original payload.")
        return payload
    except Exception as exc:
        logger.error(f"Translation failed: {exc}")
        return payload
