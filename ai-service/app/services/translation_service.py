import json
import logging
from typing import Any, Dict, Optional

from app.config import settings
from app.services import cv_translation as _cv_translation
from app.utils.llm import parse_json_object, resolve_llm_model
from langchain_ollama import ChatOllama
from langchain_core.messages import SystemMessage, HumanMessage

logger = logging.getLogger(__name__)

_PROTECTED_IDENTITY_FIELDS = (
    "name",
    "firstName",
    "lastName",
    "email",
    "phone",
    "linkedin",
)

_groq_client = _cv_translation._groq_client
_translate_batch = _cv_translation._translate_batch


def _normalize_identity_value(field: str, value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if field == "email":
        return text.lower()
    if field == "phone":
        return "".join(ch for ch in text if ch.isdigit())
    if field == "linkedin":
        return text.rstrip("/").lower()
    return " ".join(text.split())


def _translation_mutates_protected_identity(source: Dict[str, Any], candidate: Dict[str, Any]) -> bool:
    for field in _PROTECTED_IDENTITY_FIELDS:
        before = _normalize_identity_value(field, source.get(field))
        after = _normalize_identity_value(field, candidate.get(field))
        if before and after and before != after:
            logger.warning(
                "Rejecting translated CV because protected identity field '%s' changed.",
                field,
            )
            return True
    return False


def _meaningful_translation_changed(source: Dict[str, Any], candidate: Dict[str, Any]) -> bool:
    if str(source.get("summary") or "").strip() != str(candidate.get("summary") or "").strip():
        return True
    if str(source.get("title") or "").strip() != str(candidate.get("title") or "").strip():
        return True

    for section_key in ("experience", "education", "projects"):
        before_items = source.get(section_key) if isinstance(source.get(section_key), list) else []
        after_items = candidate.get(section_key) if isinstance(candidate.get(section_key), list) else []
        for before_item, after_item in zip(before_items, after_items):
            if not isinstance(before_item, dict) or not isinstance(after_item, dict):
                continue
            for field in ("title", "description", "degree", "role", "name"):
                if str(before_item.get(field) or "").strip() != str(after_item.get(field) or "").strip():
                    return True

    for section_key in ("skills", "languages"):
        before_list = source.get(section_key)
        after_list = candidate.get(section_key)
        if isinstance(before_list, list) and isinstance(after_list, list) and before_list != after_list:
            return True

    return False


def _accept_translation_candidate(source: Dict[str, Any], candidate: Dict[str, Any], label: str) -> Optional[Dict[str, Any]]:
    if _translation_mutates_protected_identity(source, candidate):
        logger.warning("Ignoring %s translation result because protected identity changed.", label)
        return None
    merged = _cv_translation._merge_translated_cv_data(source, candidate)
    if merged == source:
        return None
    if not _meaningful_translation_changed(source, merged):
        logger.info("Ignoring %s translation result because no meaningful visible text changed.", label)
        return None
    return merged


def translate_cv_data(employee_data: Dict[str, Any], target_lang: str) -> Dict[str, Any]:
    original_client = _cv_translation._groq_client
    original_batch = _cv_translation._translate_batch
    _cv_translation._groq_client = _groq_client
    _cv_translation._translate_batch = _translate_batch
    try:
        return _cv_translation.translate_cv_data(employee_data, target_lang)
    finally:
        _cv_translation._groq_client = original_client
        _cv_translation._translate_batch = original_batch


def translate_cv_structured(payload: Dict[str, Any]) -> Dict[str, Any]:
    original = _cv_translation._groq_client
    _cv_translation._groq_client = _groq_client
    try:
        return _cv_translation.translate_cv_structured(payload)
    finally:
        _cv_translation._groq_client = original


def translate_cv_best_effort(cv_data: Dict[str, Any], target_lang: str) -> Dict[str, Any]:
    if not target_lang or target_lang not in _cv_translation.SUPPORTED_LANGUAGES:
        return cv_data

    source = _cv_translation.deepcopy(cv_data)
    semantic = translate_cv_structured({
        "target_language": target_lang,
        "cv_data": source,
    })
    accepted_semantic = _accept_translation_candidate(source, semantic, "semantic")

    if accepted_semantic is not None:
        return accepted_semantic

    if not _cv_translation._has_translatable_content(source):
        return source

    logger.info(
        "translate_cv_best_effort: semantic translation produced no changes for %s; trying field fallback.",
        target_lang,
    )
    fallback = translate_cv_data(_cv_translation.deepcopy(source), target_lang)
    accepted_fallback = _accept_translation_candidate(source, fallback, "field-fallback")
    return accepted_fallback if accepted_fallback is not None else source


def _build_translation_llm():
    model = (settings.TRANSLATION_MODEL or "").strip() or resolve_llm_model()
    return ChatOllama(
        model=model,
        base_url=settings.OLLAMA_URL,
        temperature=0.0,
        disable_streaming=True,
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
