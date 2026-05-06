"""
Field Mapping Service
======================
Takes the structured JSON returned by the APILayer Resume Parser (which
represents the TEMPLATE CV's current placeholder person) and maps each
detected field to the corresponding employee data field.

Produces a list of (old_text, new_value) replacement pairs ready to be
passed to the XML replacement engine in the Advanced (fallback) generator.

Used exclusively by the Advanced AI Intelligent Field Mapping System
(``cv_generator_fallback``); the standard engine has its own mapping path.

Usage:
    from app.services.field_mapping_service import build_replacement_map

    pairs = build_replacement_map(parsed_template_json, employee_dict)
    # pairs → [("Lucas Leblanc", "Aya Ben Jemaa"), ("lucas@mail.com", "aya@corp.io"), ...]
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Optional, Tuple

from app.services.cv_section_taxonomy import (
    SECTION_SUMMARY,
    classify_heading,
    normalize_text,
)

logger = logging.getLogger("ai_service.field_mapping")


# ─── Field-name synonym table ─────────────────────────────────────────────
# Each canonical field lists the keys we accept on either the parsed-template
# side or the employee side. Order matters: earlier keys win when several are
# present.
_FIELD_SYNONYMS: Dict[str, Tuple[str, ...]] = {
    "name": (
        "name", "fullName", "full_name", "displayName",
        "candidateName", "candidate_name",
    ),
    "first_name": ("firstName", "first_name", "givenName", "given_name"),
    "last_name": ("lastName", "last_name", "surname", "familyName", "family_name"),
    "title": (
        "title", "jobTitle", "job_title", "profession", "currentPosition",
        "current_position", "position", "role", "headline", "objectiveTitle",
    ),
    "email": ("email", "emailAddress", "email_address", "mail", "e_mail"),
    "phone": (
        "phone", "phoneNumber", "phone_number", "mobile", "mobileNumber",
        "mobile_number", "telephone", "tel", "cell",
    ),
    "linkedin": (
        "linkedin", "linkedinUrl", "linkedin_url", "linkedIn",
        "linkedinProfile", "linkedin_profile",
    ),
    "summary": (
        "summary", "professionalSummary", "professional_summary",
        "profile", "objective", "about", "aboutMe", "about_me",
        "personalStatement", "personal_statement", "overview", "bio",
    ),
}


def _clean(value: Any) -> str:
    """Coerce to string, strip whitespace; return empty string for falsy values."""
    if not value:
        return ""
    s = str(value).strip()
    # Remove common placeholder markers sometimes returned by the parser
    if s in ("-", "N/A", "n/a", "none", "None", "null"):
        return ""
    return s


def _first_value(source: Dict[str, Any], canonical_field: str) -> str:
    """Return the first non-empty value among the synonyms for *canonical_field*."""
    for key in _FIELD_SYNONYMS.get(canonical_field, (canonical_field,)):
        value = _clean(source.get(key))
        if value:
            return value
    return ""


def _extract_linkedin(parsed: Dict[str, Any]) -> str:
    """Extract a LinkedIn URL from various field locations APILayer may use."""
    direct = _first_value(parsed, "linkedin")
    if direct:
        return direct

    # Sometimes under "social_links" as a list of strings or dicts
    for link in (parsed.get("social_links") or parsed.get("socialLinks") or []):
        if isinstance(link, str) and "linkedin" in link.lower():
            return link.strip()
        if isinstance(link, dict):
            url = _clean(link.get("url") or link.get("link") or link.get("href", ""))
            if "linkedin" in url.lower():
                return url

    return ""


def _extract_address(parsed: Dict[str, Any]) -> str:
    """Normalise the address field which can be a string or a structured dict."""
    raw = parsed.get("address") or parsed.get("location") or parsed.get("city", "")
    if isinstance(raw, dict):
        parts = [
            _clean(raw.get("city") or raw.get("town")),
            _clean(raw.get("state") or raw.get("region") or raw.get("province")),
            _clean(raw.get("country")),
        ]
        return ", ".join(p for p in parts if p)
    return _clean(raw)


def _extract_title(parsed: Dict[str, Any]) -> str:
    """Extract job title from various field names APILayer may use."""
    return _first_value(parsed, "title")


def _extract_summary(parsed: Dict[str, Any]) -> str:
    """Best-effort summary detection across naming conventions.

    Falls back to ``cv_section_taxonomy.classify_heading`` for any other
    string-valued top-level key whose name classifies as the summary section
    (e.g. ``"about_me"``, ``"profil_pro"``, ``"resumen"``). This makes the
    mapping template-agnostic instead of relying on a fixed key list.
    """
    direct = _first_value(parsed, "summary")
    if direct:
        return direct

    for key, value in parsed.items():
        if not isinstance(value, str):
            continue
        text = _clean(value)
        if not text:
            continue
        # Skip keys that are too generic to be a summary field name
        if normalize_text(key) in ("text", "content", "value"):
            continue
        if classify_heading(key.replace("_", " ")) == SECTION_SUMMARY:
            return text
    return ""


def get_template_summary(parsed: Dict[str, Any]) -> str:
    """Return the summary / objective text detected by APILayer in the template.

    Returns an empty string if none was detected.
    """
    return _extract_summary(parsed)


def _exp_field(entry: Dict[str, Any], canonical: str) -> str:
    """Pull ``canonical`` from an experience entry, accepting common aliases."""
    aliases: Tuple[str, ...]
    if canonical == "title":
        aliases = ("title", "jobTitle", "job_title", "position", "role", "occupation")
    elif canonical == "company":
        aliases = (
            "company", "companyName", "company_name", "organization",
            "employer", "client",
        )
    else:
        aliases = (canonical,)
    for key in aliases:
        value = _clean(entry.get(key))
        if value:
            return value
    return ""


def _edu_field(entry: Dict[str, Any], canonical: str) -> str:
    """Pull ``canonical`` from an education entry, accepting common aliases."""
    aliases: Tuple[str, ...]
    if canonical == "degree":
        aliases = (
            "degree", "name", "qualification", "diploma",
            "fieldOfStudy", "field_of_study", "title",
        )
    elif canonical == "institution":
        aliases = (
            "institution", "school", "university", "college",
            "organization", "establishment",
        )
    else:
        aliases = (canonical,)
    for key in aliases:
        value = _clean(entry.get(key))
        if value:
            return value
    return ""


def _iter_entries(parsed: Dict[str, Any], section_keys: Iterable[str]) -> List[Dict[str, Any]]:
    """Return the first non-empty list found under *section_keys*, sanitized."""
    for key in section_keys:
        value = parsed.get(key)
        if isinstance(value, list) and value:
            return [v for v in value if isinstance(v, dict)]
    return []


def _iter_list_values(parsed: Dict[str, Any], section_keys: Iterable[str]) -> List[Any]:
    """Return the first non-empty list found under *section_keys* without dict-only filtering."""
    for key in section_keys:
        value = parsed.get(key)
        if isinstance(value, list) and value:
            return list(value)
    return []


def _exp_dates(entry: Dict[str, Any]) -> str:
    """Build a readable experience date string from common date fields."""
    direct = _clean(entry.get("dates") or entry.get("date") or entry.get("period"))
    if direct:
        return direct

    start = _clean(entry.get("start_date") or entry.get("startDate") or entry.get("from"))
    end = _clean(
        entry.get("end_date")
        or entry.get("endDate")
        or entry.get("to")
        or entry.get("end")
    )
    current = bool(entry.get("is_current") or entry.get("current") or entry.get("present"))

    if start and (end or current):
        return f"{start} - {end or 'Present'}"
    return start or end


def _edu_dates(entry: Dict[str, Any]) -> str:
    """Build a readable education date string from common date fields."""
    direct = _clean(entry.get("dates") or entry.get("date") or entry.get("period"))
    if direct:
        return direct

    start = _clean(entry.get("start_date") or entry.get("startDate") or entry.get("from"))
    end = _clean(
        entry.get("end_date")
        or entry.get("endDate")
        or entry.get("graduationDate")
        or entry.get("graduation_date")
        or entry.get("year")
        or entry.get("to")
    )
    if start and end:
        return f"{start} - {end}"
    return end or start


def _list_item_text(item: Any, kind: str) -> str:
    """Extract a stable display string from list-style section items."""
    if isinstance(item, str):
        return _clean(item)
    if not isinstance(item, dict):
        return _clean(item)

    aliases: Tuple[str, ...]
    if kind == "skills":
        aliases = ("name", "label", "skill", "skillName", "title")
    elif kind == "languages":
        aliases = ("name", "language", "label", "title")
    elif kind == "certifications":
        aliases = ("name", "title", "label", "certificate")
    elif kind == "projects":
        aliases = ("name", "title", "role", "client", "description")
    else:
        aliases = ("name", "title", "label", "value")

    for key in aliases:
        value = _clean(item.get(key))
        if value:
            return value
    return ""


def _is_safe_global_replacement(old: str) -> bool:
    """Reject overly broad old-text fragments that would corrupt unrelated content."""
    text = _clean(old)
    if not text:
        return False
    if '@' in text or 'linkedin.com' in text.lower():
        return True
    if any(ch.isdigit() for ch in text):
        return True
    if any(ch in text for ch in (' ', ',', '.', '/', '-', '|', ':', '(', ')')):
        return len(text) >= 3
    return len(text) >= 5


def build_replacement_map(
    parsed_template: Dict[str, Any],
    employee: Dict[str, Any],
) -> List[Tuple[str, str]]:
    """Build (old_text, new_value) replacement pairs.

    Matches each field detected by APILayer in the template CV to the
    corresponding employee field, regardless of the exact key names used by
    either side. Synonyms are resolved via the ``_FIELD_SYNONYMS`` table and
    section-style keys via ``cv_section_taxonomy.classify_heading``.

        Rules:
            - Keeps template-detected values even when employee data is missing by
                mapping them to an empty string, so stale template content is removed.
      - Skips self-replacements where old == new (case-sensitive).
      - Returns pairs sorted longest-first to prevent partial substring conflicts.

    Covered fields:
      Personal  — name, email, phone, address, linkedin, job title
      Experience — title, company, and dates for each indexed entry
      Education  — degree, institution, and dates for each indexed entry
      Lists      — skills, languages, certifications, and projects by index
      (Summary is handled separately via ``get_template_summary`` + Groq/employee data.)
    """
    pairs: List[Tuple[str, str]] = []
    seen_old: set = set()

    def _add(template_val: Any, employee_val: Any, *, clear_missing: bool = True) -> None:
        old = _clean(template_val)
        new = _clean(employee_val)
        if not old or old in seen_old:
            return
        if not _is_safe_global_replacement(old):
            return
        if not new and not clear_missing:
            return
        if old == new:
            return
        if old:
            pairs.append((old, new))
            seen_old.add(old)

    # ── Personal info ─────────────────────────────────────────────────
    _add(_first_value(parsed_template, "name"), _first_value(employee, "name"))
    _add(_first_value(parsed_template, "email"), _first_value(employee, "email"))
    _add(_first_value(parsed_template, "phone"), _first_value(employee, "phone"))
    _add(_extract_address(parsed_template), _first_value(employee, "address") or _extract_address(employee))
    _add(_extract_linkedin(parsed_template), _extract_linkedin(employee))
    _add(_extract_title(parsed_template), _extract_title(employee))

    # ── Experience entries (index-matched) ────────────────────────────
    template_exp = _iter_entries(parsed_template, (
        "experience", "work_experiences", "workExperiences", "employment",
        "employmentHistory", "experiences",
    ))
    employee_exp = _iter_entries(employee, (
        "experience", "work_experiences", "workExperiences", "employment",
        "employmentHistory", "experiences",
    ))

    for i, t_exp in enumerate(template_exp):
        e_exp = employee_exp[i] if i < len(employee_exp) else {}

        _add(_exp_field(t_exp, "title"), _exp_field(e_exp, "title"))
        _add(_exp_field(t_exp, "company"), _exp_field(e_exp, "company"))
        _add(_exp_dates(t_exp), _exp_dates(e_exp))

    # ── Education entries (index-matched) ─────────────────────────────
    template_edu = _iter_entries(parsed_template, (
        "education", "educations", "academic_history", "academicHistory",
    ))
    employee_edu = _iter_entries(employee, (
        "education", "educations", "academic_history", "academicHistory",
    ))

    for i, t_edu in enumerate(template_edu):
        e_edu = employee_edu[i] if i < len(employee_edu) else {}

        _add(_edu_field(t_edu, "degree"), _edu_field(e_edu, "degree"))
        _add(_edu_field(t_edu, "institution"), _edu_field(e_edu, "institution"))
        _add(_edu_dates(t_edu), _edu_dates(e_edu))

    list_sections = (
        ("skills", ("skills", "competencies", "competences")),
        ("languages", ("languages", "langues")),
        ("certifications", ("certifications", "licenses", "licences")),
        ("projects", ("projects", "key_projects", "keyProjects")),
    )

    for kind, keys in list_sections:
        template_items = _iter_list_values(parsed_template, keys)
        employee_items = _iter_list_values(employee, keys)
        for i, template_item in enumerate(template_items):
            employee_item = employee_items[i] if i < len(employee_items) else ""
            old_text = _list_item_text(template_item, kind)
            new_text = _list_item_text(employee_item, kind)
            if not old_text:
                continue
            if not new_text:
                _add(old_text, "")

    # Sort longest-first to prevent partial substring replacements
    pairs.sort(key=lambda x: len(x[0]), reverse=True)

    logger.info("Field mapping built %d replacement pairs:", len(pairs))
    for old, new in pairs:
        logger.info("  %r → %r", old, new)

    return pairs
