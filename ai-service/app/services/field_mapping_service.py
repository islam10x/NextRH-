"""
Field Mapping Service
======================
Takes the structured JSON returned by the APILayer Resume Parser (which
represents the TEMPLATE CV's current placeholder person) and maps each
detected field to the corresponding employee data field.

Produces a list of (old_text, new_value) replacement pairs ready to be
passed to the XML replacement engine in cv_generator.py.

Usage:
    from app.services.field_mapping_service import build_replacement_map

    pairs = build_replacement_map(parsed_template_json, employee_dict)
    # pairs → [("Lucas Leblanc", "Aya Ben Jemaa"), ("lucas@mail.com", "aya@corp.io"), ...]
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("ai_service.field_mapping")


def _clean(value: Any) -> str:
    """Coerce to string, strip whitespace; return empty string for falsy values."""
    if not value:
        return ""
    s = str(value).strip()
    # Remove common placeholder markers sometimes returned by the parser
    if s in ("-", "N/A", "n/a", "none", "None", "null"):
        return ""
    return s


def _extract_linkedin(parsed: Dict[str, Any]) -> str:
    """Extract a LinkedIn URL from various field locations APILayer may use."""
    direct = _clean(parsed.get("linkedin"))
    if direct:
        return direct

    # Sometimes under "social_links" as a list of strings or dicts
    for link in (parsed.get("social_links") or []):
        if isinstance(link, str) and "linkedin" in link.lower():
            return link.strip()
        if isinstance(link, dict):
            url = _clean(link.get("url") or link.get("link", ""))
            if "linkedin" in url.lower():
                return url

    return ""


def _extract_address(parsed: Dict[str, Any]) -> str:
    """Normalise the address field which can be a string or a structured dict."""
    raw = parsed.get("address") or parsed.get("location", "")
    if isinstance(raw, dict):
        parts = [
            _clean(raw.get("city")),
            _clean(raw.get("state")),
            _clean(raw.get("country")),
        ]
        return ", ".join(p for p in parts if p)
    return _clean(raw)


def _extract_title(parsed: Dict[str, Any]) -> str:
    """Extract job title from various field names APILayer may use."""
    return (
        _clean(parsed.get("profession"))
        or _clean(parsed.get("title"))
        or _clean(parsed.get("job_title"))
        or ""
    )


def get_template_summary(parsed: Dict[str, Any]) -> str:
    """
    Return the summary / objective text detected by APILayer in the template.
    Returns an empty string if none was detected.
    """
    return (
        _clean(parsed.get("objective"))
        or _clean(parsed.get("summary"))
        or _clean(parsed.get("professional_summary"))
        or ""
    )


def build_replacement_map(
    parsed_template: Dict[str, Any],
    employee: Dict[str, Any],
) -> List[Tuple[str, str]]:
    """
    Build (old_text, new_value) replacement pairs by matching each field
    detected by APILayer in the template CV to the corresponding employee field.

    Rules:
    - Skips any pair where the detected template value or employee value is empty.
    - Skips self-replacements where old == new (case-sensitive).
    - Returns pairs sorted longest-first to prevent partial substring conflicts.

    Covered fields:
      Personal  — name, email, phone, address, linkedin, job title
      Experience — title and company for each indexed entry
      Education  — degree and institution for each indexed entry
      (Summary is handled separately via get_template_summary + Groq/employee data)
    """
    pairs: List[Tuple[str, str]] = []

    def _add(template_val: Any, employee_val: Any) -> None:
        old = _clean(template_val)
        new = _clean(employee_val)
        if old and new and old != new:
            # Avoid duplicate entries for the same old value
            if not any(p[0] == old for p in pairs):
                pairs.append((old, new))

    # ── Personal info ─────────────────────────────────────────────────
    _add(parsed_template.get("name"), employee.get("name"))
    _add(parsed_template.get("email"), employee.get("email"))
    _add(parsed_template.get("phone"), employee.get("phone"))
    _add(_extract_address(parsed_template), employee.get("address"))
    _add(_extract_linkedin(parsed_template), employee.get("linkedin"))
    _add(_extract_title(parsed_template), employee.get("title"))

    # ── Experience entries (index-matched) ────────────────────────────
    template_exp: List[Dict] = parsed_template.get("experience") or []
    employee_exp: List[Dict] = employee.get("experience") or []

    for i, t_exp in enumerate(template_exp):
        if i >= len(employee_exp):
            break
        e_exp = employee_exp[i]

        t_title = _clean(
            t_exp.get("title") or t_exp.get("position") or t_exp.get("job_title", "")
        )
        t_company = _clean(
            t_exp.get("company") or t_exp.get("organization") or t_exp.get("employer", "")
        )
        e_title = _clean(e_exp.get("title", ""))
        e_company = _clean(e_exp.get("company", ""))

        _add(t_title, e_title)
        _add(t_company, e_company)

    # ── Education entries (index-matched) ─────────────────────────────
    template_edu: List[Dict] = parsed_template.get("education") or []
    employee_edu: List[Dict] = employee.get("education") or []

    for i, t_edu in enumerate(template_edu):
        if i >= len(employee_edu):
            break
        e_edu = employee_edu[i]

        t_degree = _clean(
            t_edu.get("degree") or t_edu.get("name") or t_edu.get("qualification", "")
        )
        t_institution = _clean(
            t_edu.get("institution")
            or t_edu.get("school")
            or t_edu.get("organization")
            or t_edu.get("university", "")
        )
        e_degree = _clean(e_edu.get("degree", ""))
        e_institution = _clean(e_edu.get("institution", ""))

        _add(t_degree, e_degree)
        _add(t_institution, e_institution)

    # Sort longest-first to prevent partial substring replacements
    pairs.sort(key=lambda x: len(x[0]), reverse=True)

    logger.info("Field mapping built %d replacement pairs:", len(pairs))
    for old, new in pairs:
        logger.info("  %r → %r", old, new)

    return pairs
