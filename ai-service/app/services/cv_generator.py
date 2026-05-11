import asyncio
import logging
import os
import re
import shutil
import subprocess
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from docx import Document as DocxDocument
from docxtpl import DocxTemplate
from jinja2 import TemplateSyntaxError
from pypdf import PdfReader, PdfWriter
from pypdf.generic import BooleanObject

from app.config import settings
from app.services.translation_service import translate_json_payload
from app.services.ocr_rebuilder import is_docx_scanned, is_pdf_scanned, rebuild_scanned_template
from app.services.pdf_overlay import apply_pdf_overlay, build_auto_overlay_mapping
from app.services.scanned_template_builder import build_docx_template_from_scanned_pdf
from app.services.template_retrieval import find_closest_template

logger = logging.getLogger(__name__)

_SOFFICE_SEMAPHORE = asyncio.Semaphore(1)
_MAX_SHAPE_CY = 20_000_000

# ---------------------------------------------------------------------------
# DOCX placeholder aliases – maps common alternative names to canonical keys
# so template authors don't need to memorize exact variable names.
# ---------------------------------------------------------------------------
DOCX_ALIASES: Dict[str, str] = {
    # Name
    "name": "full_name", "nom": "full_name", "nom_complet": "full_name",
    "prenom": "first_name", "first_name": "first_name",
    "nom_famille": "last_name", "last_name": "last_name",
    # Contact
    "mail": "email", "courriel": "email", "e_mail": "email",
    "telephone": "phone", "tel": "phone", "mobile": "phone", "portable": "phone",
    "adresse": "address", "lieu": "address", "location": "address",
    "linkedin": "linkedin", "linkedin_url": "linkedin",
    # Position
    "poste": "current_position", "titre": "current_position",
    "poste_actuel": "current_position", "titre_poste": "current_position",
    "fonction": "current_position", "role": "current_position",
    # Summary
    "resume": "professional_summary", "profil": "professional_summary",
    "synthese": "professional_summary", "presentation": "professional_summary",
    "objectif": "professional_summary", "summary": "professional_summary",
    "profile": "professional_summary", "about": "professional_summary",
    # Skills
    "competences": "skills", "savoir_faire": "skills",
    "technologies": "skills", "outils": "skills",
    # Sections
    "experiences": "work_experiences", "parcours": "work_experiences",
    "emplois": "work_experiences",
    "formations": "educations", "etudes": "educations",
    "diplomes": "educations",
    "certificats": "certifications", "attestations": "certifications",
    "projets": "projects",
    # Experience years
    "annees_experience": "total_experience_years",
    "experience_years": "total_experience_years",
    "years_experience": "total_experience_years",
}

# Available context keys for LLM mapping reference.
_CONTEXT_KEYS = [
    "full_name", "email", "phone", "address", "linkedin", "current_position",
    "professional_summary", "total_experience_years", "skills",
    "work_experiences", "educations", "certifications", "projects",
]


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"\s+", "_", value.strip())
    cleaned = re.sub(r"[^a-zA-Z0-9_\-]", "", cleaned)
    return cleaned or "cv"

def _normalize_lines(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        items: List[str] = []
        for entry in value:
            if entry is None:
                continue
            text = str(entry)
            if not text.strip():
                continue
            # If a single list item contains newlines, split it into separate bullets.
            for part in text.splitlines():
                part = part.strip()
                if part:
                    items.append(part)
        return items
    # If the model returned a single string with multiple lines, split it.
    text = str(value)
    return [line.strip() for line in text.splitlines() if line.strip()]


def _build_context(profile: Dict[str, Any]) -> Dict[str, Any]:
    # Normalize payload aliases so templates work regardless of backend shape.
    # We support both camelCase (API) and snake_case / legacy variants.
    profile = dict(profile or {})
    if not profile.get("name"):
        first = str(profile.get("firstName") or profile.get("first_name") or "").strip()
        last = str(profile.get("lastName") or profile.get("last_name") or "").strip()
        if first or last:
            profile["name"] = f"{first} {last}".strip()
    if not profile.get("currentPosition"):
        profile["currentPosition"] = (
            profile.get("title")
            or profile.get("current_position")
            or profile.get("jobTitle")
            or ""
        )
    if not profile.get("professionalSummary"):
        profile["professionalSummary"] = (
            profile.get("summary")
            or profile.get("professional_summary")
            or ""
        )
    if not profile.get("workExperiences") and isinstance(profile.get("experience"), list):
        profile["workExperiences"] = profile.get("experience")
    if not profile.get("educations") and isinstance(profile.get("education"), list):
        profile["educations"] = profile.get("education")

    logger.warning(f"[DEBUG] RAW DATA DISCOVERY - Profile Root Keys: {list(profile.keys())}")
    
    # Extract projects from the profile
    raw_projects = list(profile.get("projects") or [])
    projects: List[Dict[str, Any]] = []
    for p in raw_projects:
        # Prefer actual project names; avoid using role as a title to keep projects distinct from experiences.
        name = str(p.get("name") or "").strip()
        generated = str(p.get("generatedTitle") or "").strip()

        # Relax placeholder detection to ensure data flows through
        p["displayTitle"] = name or generated or "Project"
        projects.append(p)

    logger.warning(f"[DEBUG] Profile Data - Projects: {len(projects)} entries")
    if projects:
        logger.warning(f"[DEBUG]   prj[0]: name={projects[0].get('name')}, client={projects[0].get('client')}")

    work_experiences = list(profile.get("workExperiences") or profile.get("work_experiences") or [])
    if work_experiences and isinstance(work_experiences[0], dict):
        logger.warning(f"[DEBUG] RAW DATA DISCOVERY - First Experience Keys: {list(work_experiences[0].keys())}")
        logger.warning(f"[DEBUG] RAW DATA DISCOVERY - First Experience Sample: {work_experiences[0]}")

    normalized_work_experiences: List[Dict[str, Any]] = []
    for exp in work_experiences:
        if not isinstance(exp, dict):
            continue
        merged = dict(exp)
        title = _safe_text(exp.get("jobTitle") or exp.get("title") or exp.get("role"))
        company = _safe_text(exp.get("companyName") or exp.get("company") or exp.get("client"))
        start = _safe_text(exp.get("startDate") or exp.get("start_date"))
        end = _safe_text(exp.get("endDate") or exp.get("end_date"))
        dates_raw = _safe_text(exp.get("dates") or exp.get("date_range"))
        
        # Fallback: Parse dates from the 'dates' string if start/end are missing
        if not start and dates_raw:
            if " - " in dates_raw or " to " in dates_raw or " à " in dates_raw:
                parts = [p.strip() for p in re.split(r" \- | to | à ", dates_raw)]
                if len(parts) >= 1: start = parts[0]
                if len(parts) >= 2: end = parts[1]
            else:
                start = dates_raw

        dates = dates_raw or _format_date_range(start, end)
        merged["jobTitle"] = title
        merged["title"] = title or _safe_text(exp.get("title"))
        merged["companyName"] = company
        merged["company"] = company or _safe_text(exp.get("company"))
        merged["startDate"] = start
        merged["endDate"] = end
        merged["dates"] = dates
        merged["date_range"] = dates
        normalized_work_experiences.append(merged)
    work_experiences = normalized_work_experiences

    # Attach internal projects under the Next Step experience entry only.
    def _dedupe_preserve_order(items: List[str]) -> List[str]:
        seen = set()
        deduped: List[str] = []
        for item in items:
            key = item.strip()
            if not key or key in seen:
                continue
            seen.add(key)
            deduped.append(item)
        return deduped
    if projects:
        def _normalize_company(value: str) -> str:
            return re.sub(r"[^a-z0-9]", "", (value or "").lower())

        def _is_next_step_company(value: str) -> bool:
            normalized = _normalize_company(value)
            return "nextstep" in normalized

        def _format_project_entries(items: List[Dict[str, Any]]) -> tuple[str, List[str]]:
            lines: List[str] = []
            for proj in items:
                title = proj.get("displayTitle") or proj.get("name") or proj.get("role") or "Project"
                role = proj.get("role")
                client = proj.get("client")
                dates = _format_date_range(proj.get("startDate"), proj.get("endDate"))
                meta_parts = [p for p in [role, client, dates] if p]
                header = f"{title} — {' / '.join(meta_parts)}" if meta_parts else str(title)
                desc = proj.get("description") or ""
                line = f"{header}: {desc}" if desc else header
                lines.append(line)
            deduped_lines = _dedupe_preserve_order(lines)
            return "\n".join(deduped_lines), deduped_lines

        projects_block, project_lines = _format_project_entries(projects)
        target_exp = next(
            (exp for exp in work_experiences if _is_next_step_company(exp.get("companyName") or "")),
            None,
        )

        if target_exp:
            # No merging into experience - projects now have their own table
            pass
        elif not work_experiences:
            # Create synthetic experience only if profile is empty
            start_dates = [p.get("startDate") for p in projects if p.get("startDate")]
            min_start = min(start_dates) if start_dates else None
            end_dates = [p.get("endDate") for p in projects if p.get("endDate")]
            max_end = None if any(p.get("endDate") in (None, "", "null") for p in projects) else (max(end_dates) if end_dates else None)
            work_experiences = [{
                "jobTitle": profile.get("currentPosition") or "Consultant",
                "companyName": "Next Step IT",
                "startDate": min_start,
                "endDate": max_end,
                "isCurrent": max_end is None,
                "description": projects_block,
                "description_lines": project_lines,
            }]

    # Ensure each experience has a description_lines list for bullet-style templates.
    for exp in work_experiences:
        if isinstance(exp.get("description_lines"), list):
            continue
        desc_value = exp.get("description")
        if isinstance(desc_value, list):
            lines = [str(v).strip() for v in desc_value if str(v).strip()]
        else:
            lines = [line.strip() for line in str(desc_value or "").splitlines() if line.strip()]
        exp["description_lines"] = _normalize_lines(lines)

    raw_educations = list(profile.get("educations") or profile.get("education") or [])
    if raw_educations and isinstance(raw_educations[0], dict):
        logger.warning(f"[DEBUG] RAW DATA DISCOVERY - First Education Keys: {list(raw_educations[0].keys())}")

    educations: List[Dict[str, Any]] = []
    for edu in raw_educations:
        if not isinstance(edu, dict):
            continue
        merged = dict(edu)
        degree = _safe_text(edu.get("degree"))
        institution = _safe_text(edu.get("institution") or edu.get("school"))
        field = _safe_text(edu.get("fieldOfStudy") or edu.get("field") or edu.get("speciality"))
        start = _safe_text(edu.get("startDate") or edu.get("start_date"))
        end = _safe_text(edu.get("endDate") or edu.get("end_date") or edu.get("graduationDate"))
        dates = _safe_text(edu.get("dates") or edu.get("date_range") or _format_date_range(start, end))
        merged["degree"] = degree
        merged["institution"] = institution
        merged["school"] = institution or _safe_text(edu.get("school"))
        merged["fieldOfStudy"] = field
        merged["startDate"] = start
        merged["endDate"] = end
        merged["dates"] = dates
        merged["date_range"] = dates
        educations.append(merged)

    raw_certs = list(profile.get("certifications") or profile.get("certs") or [])
    if raw_certs and isinstance(raw_certs[0], dict):
        logger.warning(f"[DEBUG] RAW DATA DISCOVERY - First Certification Keys: {list(raw_certs[0].keys())}")
    
    certifications: List[Dict[str, Any]] = []
    for cert in raw_certs:
        if not isinstance(cert, dict): continue
        c = dict(cert)
        # Normalize keys for template
        c["name"] = _safe_text(cert.get("name") or cert.get("title") or cert.get("label"))
        c["issuingOrganization"] = _safe_text(cert.get("issuingOrganization") or cert.get("organization") or cert.get("issuer") or cert.get("authority"))
        certifications.append(c)

    context = {
        "full_name": profile.get("name") or "Employee",
        "email": _safe_text(profile.get("email")),
        "phone": _safe_text(profile.get("phone")),
        "address": _safe_text(profile.get("address")),
        "linkedin": _safe_text(
            profile.get("linkedin")
            or profile.get("linkedinUrl")
            or profile.get("linkedin_url")
            or profile.get("linkedIn")
        ),
        "birth_date": _safe_text(profile.get("birthDate") or profile.get("birth_date")),
        "marital_status": _safe_text(profile.get("maritalStatus") or profile.get("marital_status")),
        "hire_date": _safe_text(profile.get("hireDate") or profile.get("hire_date")),
        "current_position": _safe_text(profile.get("currentPosition")),
        "professional_summary": _safe_text(profile.get("professionalSummary")),
        "total_experience_years": _safe_text(profile.get("totalExperienceYears")),
        "skills": profile.get("skills") or [],
        "work_experiences": work_experiences,
        "educations": educations,
        "certifications": certifications,
        "projects": projects,
        "languages": profile.get("languages") or [],
        "awards": profile.get("awards") or profile.get("distinctions") or [],
        "last_update": _safe_text(profile.get("lastUpdate")),
        "last_degree": "",
        "last_degree_year": "",
        "open_end_label": "Present",
        "section_titles": {},
    }
    # for key in ["email", "phone", "address", "linkedin", "birth_date", "marital_status", "hire_date", "current_position", "professional_summary", "total_experience_years", "last_update"]:
    #     if not context[key]:
    #         context.pop(key)

    # --- HIGH VISIBILITY DEBUG LOGS ---
    logger.warning(f"[DEBUG] Profile Data - Work Experiences: {len(work_experiences)} entries")
    for i, exp in enumerate(work_experiences):
        logger.warning(f"[DEBUG]   exp[{i}]: company={exp.get('companyName')}, start={exp.get('startDate')}, end={exp.get('endDate')}")
    
    logger.warning(f"[DEBUG] Profile Data - Educations: {len(educations)} entries")
    for i, edu in enumerate(educations):
        logger.warning(f"[DEBUG]   edu[{i}]: inst={edu.get('institution')}, start={edu.get('startDate')}, end={edu.get('endDate')}")

    logger.warning(f"[DEBUG] Profile Data - Certifications: {len(certifications)} entries")
    for i, cert in enumerate(certifications):
        logger.warning(f"[DEBUG]   cert[{i}]: name={cert.get('name')}, org={cert.get('issuingOrganization')}")
    # -----------------------------------
    return context


def _build_context_from_employee(profile: Dict[str, Any]) -> Dict[str, Any]:
    """Backward-compatible alias for older tests and callers."""
    full_name = str(profile.get("name") or "").strip()
    if not full_name:
        first = str(profile.get("firstName") or "").strip()
        last = str(profile.get("lastName") or "").strip()
        full_name = f"{first} {last}".strip()

    parts = [part for part in full_name.split() if part]
    first_name = str(profile.get("firstName") or (parts[0] if parts else "")).strip()
    last_name = str(profile.get("lastName") or (parts[-1] if len(parts) > 1 else "")).strip()
    short_last_name = parts[-1] if len(parts) > 1 else last_name

    raw_skills = profile.get("skills") or []
    if not isinstance(raw_skills, list):
        raw_skills = [raw_skills]
    skills = [str(skill).strip() for skill in raw_skills if str(skill).strip()]

    summary = str(profile.get("summary") or "")

    return {
        "name": full_name,
        "full_name": full_name,
        "email": str(profile.get("email") or ""),
        "phone": str(profile.get("phone") or ""),
        "title": str(profile.get("title") or ""),
        "current_position": str(profile.get("title") or ""),
        "summary": summary,
        "skills": skills,
        "skills_text": ", ".join(skills),
        "prenom": first_name,
        "nom": short_last_name,
        "address": str(profile.get("address") or ""),
        "linkedin": str(profile.get("linkedin") or ""),
    }


def _build_section_content(
    section: str,
    employee: Dict[str, Any],
    preferred_language: Optional[str] = None,
):
    """Backward-compatible section builder used by legacy tests.

    The live fallback runtime uses the richer implementation in
    cv_generator_fallback. This wrapper preserves the older, flatter output
    shape expected by legacy unit tests that still import from cv_generator.
    """
    def _s(value: Any) -> str:
        return str(value or "").strip()

    def _year_only(value: Any) -> str:
        text = _s(value)
        if re.search(r'\b(?:present|current|ongoing|today|now)\b', text, re.I):
            return text
        match = re.search(r"\b(19|20)\d{2}\b", text)
        return match.group(0) if match else text

    def _meta_line(*parts: Any) -> str:
        values = [_s(part) for part in parts if _s(part)]
        return "  —  ".join(values)

    if section == "summary":
        text = _s(employee.get("summary"))
        return [{"text": text, "bold": False, "bullet": False}] if text else None

    if section == "experience":
        raw = employee.get("experience")
        if not isinstance(raw, list) or not raw:
            return None
        lines: List[Dict[str, Any]] = []
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            title = _s(entry.get("title") or entry.get("jobTitle"))
            company = _s(entry.get("company") or entry.get("companyName"))
            dates = _year_only(
                entry.get("dates")
                or entry.get("date_range")
                or entry.get("period")
                or entry.get("start_date")
                or entry.get("startDate")
            )
            desc = _s(entry.get("description") or entry.get("responsibilities") or entry.get("tasks"))
            if len(desc) > 1500:
                desc = desc[:1500].rsplit(" ", 1)[0] + "…"
            if not title and not company:
                continue
            if title:
                lines.append({"text": title, "bold": True, "bullet": False})
            meta = _meta_line(company, dates)
            if meta:
                lines.append({"text": meta, "bold": False, "bullet": False, "compact": True})
            for part in desc.splitlines():
                part = part.strip().lstrip("•●-– ").strip()
                if part:
                    lines.append({"text": part, "bold": False, "bullet": True, "compact": True})
        return lines or None

    if section == "education":
        raw = employee.get("education")
        if not isinstance(raw, list) or not raw:
            return None
        lines: List[Dict[str, Any]] = []
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            degree = _s(entry.get("degree"))
            institution = _s(entry.get("institution") or entry.get("school") or entry.get("university"))
            dates = _year_only(entry.get("dates") or entry.get("end_date") or entry.get("graduationDate"))
            if not degree and not institution:
                continue
            parts = [part for part in (degree, institution, dates) if part]
            if parts:
                lines.append({"text": " | ".join(parts), "bold": False, "bullet": False})
        return lines or None

    if section == "skills":
        raw = employee.get("skills")
        items = raw if isinstance(raw, list) else ([raw] if raw else [])
        values = [_s(item.get("name") if isinstance(item, dict) else item) for item in items]
        values = [value for value in values if value]
        if not values:
            certs = employee.get("certifications") or []
            cert_items = certs if isinstance(certs, list) else [certs]
            tech_values: List[str] = []
            seen: set[str] = set()
            tech_re = re.compile(
                r'\b(DELL|HP|IBM|VMware|Microsoft|Compellent|PowerVault|PowerEdge|'
                r'FluidFS|Hyper-V|StorageWorks|BladeCenter|MCSA|MCSE|Cisco|Linux|'
                r'Windows|Server|Storage|Blade|Cloud|NAS|SAN|vSphere|ESXi|'
                r'SQL|Exchange|SharePoint|Azure|AWS|Docker|Kubernetes|Python|Java|'
                r'React|Angular|Node)\b',
                re.I,
            )
            for cert in cert_items:
                cert_name = _s(cert.get("name") if isinstance(cert, dict) else cert)
                for match in tech_re.finditer(cert_name):
                    token = match.group()
                    key = token.lower()
                    if key not in seen:
                        seen.add(key)
                        tech_values.append(token)
            values = tech_values
        if not values:
            return None
        return [{"text": ", ".join(values), "bold": False, "bullet": False}] if values else None

    if section == "certifications":
        raw = employee.get("certifications")
        if not raw:
            return None
        items = raw if isinstance(raw, list) else [raw]
        values = [
            _s(item.get("name") if isinstance(item, dict) else item)
            for item in items
        ]
        values = [value for value in values if value]
        return [{"text": value, "bold": False, "bullet": True} for value in values] or None

    if section == "languages":
        raw = employee.get("languages")
        if not raw:
            return None
        items = raw if isinstance(raw, list) else [raw]
        values = [
            _s(item.get("name") if isinstance(item, dict) else item)
            for item in items
        ]
        values = [value for value in values if value]
        return [{"text": ", ".join(values), "bold": False, "bullet": False}] if values else None

    if section == "interests":
        raw = employee.get("interests")
        if not raw:
            return None
        items = raw if isinstance(raw, list) else [raw]
        values = [
            _s(item.get("name") if isinstance(item, dict) else item)
            for item in items
        ]
        values = [value for value in values if value]
        return [{"text": value, "bold": False, "bullet": True} for value in values] or None

    if section == "projects":
        raw = employee.get("projects")
        if not raw:
            return None
        items = raw if isinstance(raw, list) else [raw]
        lines: List[Dict[str, Any]] = []
        for item in items:
            if isinstance(item, dict):
                name = _s(item.get("name") or item.get("title"))
                desc = _s(item.get("description") or item.get("role"))
                if name:
                    lines.append({"text": name, "bold": False, "bullet": False})
                if desc:
                    lines.append({"text": desc, "bold": False, "bullet": True})
            else:
                text = _s(item)
                if text:
                    lines.append({"text": text, "bold": False, "bullet": False})
        return lines or None

    return None


def _build_translation_payload(context: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "current_position": context.get("current_position"),
        "professional_summary": context.get("professional_summary"),
        "skills": context.get("skills", []),
        "work_experiences": [
            {
                "jobTitle": exp.get("jobTitle"),
                "description": exp.get("description"),
                "descriptionLines": exp.get("description_lines"),
            }
            for exp in context.get("work_experiences", [])
        ],
        "educations": [
            {
                "degree": edu.get("degree"),
                "fieldOfStudy": edu.get("fieldOfStudy"),
            }
            for edu in context.get("educations", [])
        ],
        "projects": [
            {
                "displayTitle": proj.get("displayTitle"),
                "role": proj.get("role"),
                "description": proj.get("description"),
            }
            for proj in context.get("projects", [])
        ],
        "languages": context.get("languages", []),
        "awards": context.get("awards", []),
        "section_titles": {
            "experience": "Experience",
            "education": "Education",
            "projects": "Projects",
            "certifications": "Certifications",
            "skills": "Skills",
            "languages": "Languages",
            "awards": "Awards/Distinctions"
        }
    }


def _apply_translations(context: Dict[str, Any], translated: Dict[str, Any]) -> Dict[str, Any]:
    if not translated:
        return context

    if isinstance(translated.get("current_position"), str):
        context["current_position"] = translated["current_position"]
    if isinstance(translated.get("professional_summary"), str):
        context["professional_summary"] = translated["professional_summary"]

    # Skills, Languages, Awards
    translated_skills = translated.get("skills")
    if isinstance(translated_skills, list) and translated_skills:
        context["skills"] = translated_skills

    translated_langs = translated.get("languages")
    if isinstance(translated_langs, list) and translated_langs:
        context["languages"] = translated_langs

    translated_awards = translated.get("awards")
    if isinstance(translated_awards, list) and translated_awards:
        context["awards"] = translated_awards

    translated_section_titles = translated.get("section_titles")
    if isinstance(translated_section_titles, dict):
        context["section_titles"] = translated_section_titles

    for idx, exp in enumerate(context.get("work_experiences", [])):
        trans_exp = (translated.get("work_experiences") or [])
        if idx < len(trans_exp):
            if isinstance(trans_exp[idx].get("jobTitle"), str):
                exp["jobTitle"] = trans_exp[idx]["jobTitle"]
            if isinstance(trans_exp[idx].get("description"), str):
                exp["description"] = trans_exp[idx]["description"]
            if isinstance(trans_exp[idx].get("descriptionLines"), list):
                exp["description_lines"] = [
                    str(v) for v in trans_exp[idx]["descriptionLines"] if str(v).strip()
                ]

    for idx, edu in enumerate(context.get("educations", [])):
        trans_edu = (translated.get("educations") or [])
        if idx < len(trans_edu):
            if isinstance(trans_edu[idx].get("degree"), str):
                edu["degree"] = trans_edu[idx]["degree"]
            if isinstance(trans_edu[idx].get("fieldOfStudy"), str):
                edu["fieldOfStudy"] = trans_edu[idx]["fieldOfStudy"]

    for idx, proj in enumerate(context.get("projects", [])):
        trans_proj = (translated.get("projects") or [])
        if idx < len(trans_proj):
            if isinstance(trans_proj[idx].get("displayTitle"), str):
                proj["displayTitle"] = trans_proj[idx]["displayTitle"]
            if isinstance(trans_proj[idx].get("role"), str):
                proj["role"] = trans_proj[idx]["role"]
            if isinstance(trans_proj[idx].get("description"), str):
                proj["description"] = trans_proj[idx]["description"]

    return context


def _normalize_header_text(value: str) -> str:
    if not value:
        return ""
    normalized = unicodedata.normalize("NFD", value)
    normalized = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    normalized = normalized.lower()
    normalized = " ".join(normalized.split())
    return normalized


# Section keyword sets — sourced from the unified taxonomy so synonyms
# stay aligned with template_tagger and cv_generator_fallback.  We expose
# the *normalized* (accent-stripped, lowercased) form here because every
# call site below normalizes its own input via _normalize_header_text.
from app.services.cv_section_taxonomy import (
    SECTION_KEYWORDS_NORMALIZED as _CANON_NORMALIZED,
)

_SECTION_KEYWORDS = {
    section: set(_CANON_NORMALIZED[section])
    for section in (
        "experience", "education", "projects", "certifications",
        "skills", "summary", "contact", "languages", "awards",
    )
    if section in _CANON_NORMALIZED
}


def _tokenize_header(text: str) -> set[str]:
    norm = _normalize_header_text(text)
    tokens = re.split(r"[^a-z0-9]+", norm)
    return {t for t in tokens if len(t) > 1}


def _analyze_authoring_rules_docx(docx_path: str, note: Optional[str] = None) -> Dict[str, Any]:
    """Return an authoring rule report for a DOCX template."""
    doc = DocxDocument(docx_path)

    # Detect headings
    sections: List[Dict[str, Any]] = []
    seen_sections = set()
    for para in doc.paragraphs:
        raw_text = (para.text or "").strip()
        if not raw_text:
            continue
        norm = _normalize_header_text(raw_text)
        for section, keywords in _SECTION_KEYWORDS.items():
            if section in seen_sections:
                continue
            if any(keyword in norm for keyword in keywords):
                sections.append({
                    "section": section,
                    "match": raw_text,
                    "source": "heading",
                })
                seen_sections.add(section)

    # Placeholder detection
    placeholder_patterns = {
        "dots": re.compile(r"^[\\s·•.…\\.]{3,}$"),
        "insert_text": re.compile(r"(inserez|insert).*texte|lorem", re.IGNORECASE),
        "date_placeholder": re.compile(r"(mois|month)\\s+20xx", re.IGNORECASE),
        "zeros": re.compile(r"^0{2,}$"),
    }
    placeholder_counts = {k: 0 for k in placeholder_patterns}

    def _count_placeholders(text: str) -> None:
        if not text:
            return
        for key, pattern in placeholder_patterns.items():
            if pattern.search(text.strip()):
                placeholder_counts[key] += 1

    for para in doc.paragraphs:
        _count_placeholders(para.text or "")
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                _count_placeholders(cell.text or "")

    # Tables + inferred mapping
    tables: List[Dict[str, Any]] = []
    recognized_tables = 0
    for idx, table in enumerate(doc.tables, 1):
        if not table.rows:
            continue
        header_row = table.rows[0]
        raw_headers = [cell.text.strip() for cell in header_row.cells]

        def _is_placeholder_header(text: str) -> bool:
            return not text or re.search(r"[·•…\\.]{3,}", text) is not None

        # If header row is empty/placeholder, try the next row as header hints.
        if all(_is_placeholder_header(h) for h in raw_headers) and len(table.rows) > 1:
            raw_headers = [cell.text.strip() for cell in table.rows[1].cells]

        headers = [_normalize_header_text(cell) for cell in raw_headers]
        header_tokens = [_tokenize_header(cell) for cell in raw_headers]
        tokens_all = set().union(*header_tokens) if header_tokens else set()

        inferred_section = None
        # Strong signals first
        if {"certificat", "certification", "certificate", "licence", "license"} & tokens_all and {
            "date", "obtention", "issue", "issued"
        } & tokens_all:
            inferred_section = "certifications"
        elif {"institution", "ecole", "universite", "school", "college"} & tokens_all and {
            "diplome", "degree", "diploma"
        } & tokens_all:
            inferred_section = "education"
        elif {"projet", "project"} & tokens_all and {"client", "customer", "mission"} & tokens_all:
            inferred_section = "projects"
        elif {"organisme", "entreprise", "societe", "company", "employeur"} & tokens_all and {
            "fonction", "poste", "role", "position", "title"
        } & tokens_all:
            inferred_section = "experience"
        elif {"competence", "skills", "expertise"} & tokens_all:
            inferred_section = "skills"
        else:
            # Softer scoring fallback
            scores = {"experience": 0, "projects": 0, "education": 0, "certifications": 0, "skills": 0}
            for tokens in header_tokens:
                if tokens & {"periode", "period", "dates", "date", "from", "to"}:
                    scores["experience"] += 1
                    scores["projects"] += 1
                    scores["education"] += 1
                if tokens & {"organisme", "entreprise", "societe", "company", "employeur"}:
                    scores["experience"] += 2
                if tokens & {"fonction", "poste", "role", "position", "title"}:
                    scores["experience"] += 2
                if tokens & {"client", "customer"}:
                    scores["projects"] += 2
                if tokens & {"projet", "project", "mission"}:
                    scores["projects"] += 2
                if tokens & {"institution", "ecole", "universite", "school", "college"}:
                    scores["education"] += 2
                if tokens & {"diplome", "degree", "diploma"}:
                    scores["education"] += 2
                if tokens & {"certificat", "certification", "certificate"}:
                    scores["certifications"] += 2
                if tokens & {"competence", "skills", "expertise"}:
                    scores["skills"] += 2
            best_section = max(scores, key=scores.get)
            if scores[best_section] >= 2:
                inferred_section = best_section

        if inferred_section:
            recognized_tables += 1

        # Suggested column mapping
        col_map: Dict[str, str] = {}
        for col_idx, header in enumerate(headers):
            tokens = header_tokens[col_idx] if col_idx < len(header_tokens) else set()
            if inferred_section == "experience":
                if tokens & {"periode", "period", "dates", "date", "from", "to"}:
                    col_map[str(col_idx)] = "date_range"
                elif tokens & {"organisme", "entreprise", "societe", "company", "employeur"}:
                    col_map[str(col_idx)] = "companyName"
                elif tokens & {"fonction", "poste", "role", "position", "title", "intitule"}:
                    col_map[str(col_idx)] = "jobTitle"
                elif tokens & {"duree", "duration", "delai", "temps"}:
                    col_map[str(col_idx)] = "duration"
            elif inferred_section == "projects":
                if tokens & {"annee", "year"}:
                    col_map[str(col_idx)] = "year"
                elif tokens & {"periode", "period", "dates", "date"}:
                    col_map[str(col_idx)] = "date_range"
                elif tokens & {"client", "customer"}:
                    col_map[str(col_idx)] = "client"
                elif tokens & {"projet", "project", "mission", "intitule"}:
                    col_map[str(col_idx)] = "displayTitle"
                elif tokens & {"delai", "duree", "duration"}:
                    col_map[str(col_idx)] = "duration"
            elif inferred_section == "education":
                if tokens & {"periode", "annee", "year", "date"}:
                    col_map[str(col_idx)] = "date_range"
                elif tokens & {"institution", "ecole", "universite", "school", "college"}:
                    col_map[str(col_idx)] = "institution"
                elif tokens & {"diplome", "degree", "diploma"}:
                    col_map[str(col_idx)] = "degree"
                elif tokens & {"specialite", "specialisation", "field", "filiere", "domaine"}:
                    col_map[str(col_idx)] = "fieldOfStudy"
            elif inferred_section == "certifications":
                if tokens & {"certificat", "certification", "certificate"}:
                    col_map[str(col_idx)] = "name"
                elif tokens & {"date", "obtention", "issue", "issued"}:
                    col_map[str(col_idx)] = "issueDate"
                elif tokens & {"organisme", "issuer", "organisation", "provider"}:
                    col_map[str(col_idx)] = "issuingOrganization"

        loop_key = None
        if inferred_section == "experience":
            loop_key = "work_experiences"
        elif inferred_section == "projects":
            loop_key = "projects"
        elif inferred_section == "education":
            loop_key = "educations"
        elif inferred_section == "certifications":
            loop_key = "certifications"

        tables.append({
            "index": idx,
            "headers": raw_headers,
            "section": inferred_section,
            "row_count": len(table.rows),
            "col_count": len(table.columns),
            "suggested_loop": loop_key,
            "suggested_columns": col_map,
        })

    # Confidence score
    confidence = 0.3
    confidence += min(0.4, 0.05 * len(sections))
    confidence += min(0.4, 0.1 * recognized_tables)
    confidence = min(confidence, 0.95)

    recommendations: List[str] = []
    if not sections:
        recommendations.append("Add clear section headings (Experience, Education, Projects, Certifications).")
    if recognized_tables == 0:
        recommendations.append("No structured tables detected; use tables with headers to enable loops.")
    if any(placeholder_counts.values()):
        recommendations.append("Replace dotted placeholders or 'Insérez votre texte ici' with fields or leave them empty.")

    return {
        "docx_path": docx_path,
        "sections": sections,
        "tables": tables,
        "placeholders": placeholder_counts,
        "confidence": round(confidence, 2),
        "recommendations": recommendations,
        "note": note,
    }


def _postprocess_annexe9_tables(docx_path: str, context: Dict[str, Any]) -> None:
    """Fix Annexe 9 tables by rebuilding rows with python-docx.

    This avoids docxtpl repeating cells (columns) when loops are embedded inside
    table rows. Only runs for the Annexe 9 auto-template.
    """
    doc = DocxDocument(docx_path)

    for table in doc.tables:
        if not table.rows:
            continue
        headers = [_normalize_header_text(cell.text) for cell in table.rows[0].cells]
        if len(headers) < 4:
            continue
        if "periode" not in headers[0] or "projet" not in headers[1] or "client" not in headers[2]:
            continue

        is_projects = "delai" in headers[3] or "délai" in headers[3]
        items = context.get("projects", []) if is_projects else context.get("work_experiences", [])

        # Remove all data rows (keep header row only)
        while len(table.rows) > 1:
            table._tbl.remove(table.rows[1]._tr)

        # No data — keep header row only
        if not items:
            continue

        for item in items:
            row = table.add_row().cells
            row[0].text = str(item.get("date_range") or "")
            if is_projects:
                row[1].text = str(item.get("displayTitle") or item.get("name") or "")
                row[2].text = str(item.get("client") or "")
                row[3].text = str(item.get("duration") or "")
            else:
                row[1].text = str(item.get("jobTitle") or "")
                row[2].text = str(item.get("companyName") or "")
                row[3].text = str(item.get("duration") or "")

    doc.save(docx_path)


def _clear_table_rows(table: Any) -> None:
    while len(table.rows) > 1:
        table._tbl.remove(table.rows[1]._tr)


def _safe_text(value: Any, fallback: str = "") -> str:
    text = str(value).strip() if value is not None else ""
    return text if text else fallback


def _docx_contains_jinja(doc: DocxDocument) -> bool:
    def _has_tag(text: str) -> bool:
        if not text:
            return False
        return "{{" in text or "{%" in text

    for para in doc.paragraphs:
        if _has_tag(para.text or ""):
            return True
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                if _has_tag(cell.text or ""):
                    return True
    return False


def _fill_common_placeholders(doc: DocxDocument, context: Dict[str, Any]) -> None:
    placeholder_re = re.compile(r"^[\.\s]{2,}$")
    phone_re = re.compile(r"(?:\+?\d[\d\s().\-/]{7,}\d)")
    email_re = re.compile(r"[\w.+\- ]+@[\w\-]+\.[\w.\-]+")
    linkedin_re = re.compile(r"(?:https?://)?(?:www\.)?linkedin\.com/\S+", re.IGNORECASE)
    placeholder_count = 0
    header_name_done = False
    header_title_done = False

    def _replace_contact_line(text: str) -> Optional[str]:
        norm = _normalize_header_text(text)
        if norm.startswith("tel"):
            val = context.get('phone') or ''
            return f"Tel : {val}" if val else None
        if norm.startswith("email"):
            val = context.get('email') or ''
            return f"Email : {val}" if val else None
        if norm.startswith("adresse"):
            val = context.get('address') or ''
            return f"Adresse : {val}" if val else None
        if norm.startswith("nom") and "prenom" in norm:
            val = context.get('full_name') or ''
            return f"Nom et Prenom : {val}" if val else None
        return None

    def _replace_header_value_line(text: str) -> Optional[str]:
        nonlocal header_name_done, header_title_done
        clean = (text or "").strip()
        if not clean:
            return None

        # Skip synthetic merged paragraphs that concatenate multiple header runs.
        if len(clean) > 140:
            return None

        if linkedin_re.search(clean):
            return _safe_text(context.get("linkedin"))

        if email_re.search(clean):
            email_value = _safe_text(context.get("email"))
            address_value = str(context.get("address") or "").strip()
            return f"{email_value} {address_value}".strip() if address_value else email_value

        digits = re.sub(r"\D", "", clean)
        if phone_re.search(clean) and len(digits) >= 8 and "@" not in clean:
            return _safe_text(context.get("phone"))

        norm = _normalize_header_text(clean)
        if norm in {
            "competences",
            "experience professionnelle",
            "formation",
            "langues",
            "references",
        }:
            return None

        # Uppercase value lines in headers are often NAME and TITLE.
        ascii_upper = "".join(
            ch for ch in unicodedata.normalize("NFD", clean)
            if unicodedata.category(ch) != "Mn"
        ).upper()
        if re.fullmatch(r"[A-Z'\-\s]{4,}", ascii_upper):
            words = [w for w in clean.split() if w]
            if 1 < len(words) <= 7:
                title_markers = (
                    "ingenieur",
                    "consultant",
                    "manager",
                    "charge",
                    "chef",
                    "responsable",
                    "developer",
                    "architect",
                    "analyst",
                    "projet",
                    "project",
                )
                looks_like_title = any(marker in norm for marker in title_markers)
                if not header_name_done and not looks_like_title:
                    header_name_done = True
                    return _safe_text(context.get("full_name"))
                if not header_title_done:
                    header_title_done = True
                    return _safe_text(context.get("current_position"))
        return None

    _SYMBOL_FONTS = frozenset({
        'font awesome', 'fontawesome', 'wingdings', 'wingdings 2', 'wingdings 3',
        'symbol', 'webdings', 'material icons', 'material icons outlined',
        'glyphicons', 'glyphicons halflings', 'ionicons', 'entypo', 'feather',
        'fa solid', 'fa brands', 'fa regular',
    })
    # Substring keywords that *strongly* imply an icon font even when the
    # exact name varies between Office versions. We avoid bare 'fa' here
    # because it produces false positives on common fonts (e.g. "Verdana FA").
    _SYMBOL_KEYWORDS = ('awesome', 'wingding', 'webding', 'glyphicon', 'material icon')
    # Unicode private-use area / typical icon ranges
    _PRIVATE_USE_AREA = re.compile(
        r'^[-\U000F0000-\U000FFFFD\U00100000-\U0010FFFD]+$'
    )

    def _run_is_icon(run) -> bool:
        """Return True if this run contains only icon/symbol characters."""
        try:
            font_name = (run.font.name or "").lower().strip()
        except Exception:
            font_name = ""
        if font_name and (
            font_name in _SYMBOL_FONTS
            or any(kw in font_name for kw in _SYMBOL_KEYWORDS)
        ):
            return True
        text = (run.text or "")
        stripped = text.strip()
        if stripped and _PRIVATE_USE_AREA.match(stripped):
            return True
        # Common Unicode symbol ranges used as icons (geometric/misc symbols)
        if stripped and all(
            ('⌀' <= c <= '⏿')  # Miscellaneous Technical
            or ('☀' <= c <= '➿')  # Misc Symbols + Dingbats
            or ('⬀' <= c <= '⯿')  # Misc Symbols and Arrows
            or ('' <= c <= '')  # Private Use Area
            for c in stripped
        ):
            return True
        return False

    def _set_para_text_preserving_format(para, new_text: str) -> None:
        """Replace paragraph text while keeping run formatting and icon characters."""
        if not para.runs:
            para.text = new_text
            return

        # Identify icon and text runs
        icon_runs = [r for r in para.runs if _run_is_icon(r)]
        text_runs = [r for r in para.runs if not _run_is_icon(r)]
        first_text_run = text_runs[0] if text_runs else para.runs[0]

        try:
            bold = first_text_run.bold
            italic = first_text_run.italic
            font_name = first_text_run.font.name
            font_size = first_text_run.font.size
        except Exception:
            bold = italic = None
            font_name = None
            font_size = None
        try:
            font_color = (
                first_text_run.font.color.rgb
                if first_text_run.font.color and first_text_run.font.color.type
                else None
            )
        except Exception:
            font_color = None

        if icon_runs and new_text:
            # Clear only non-icon runs; preserve icon runs intact
            for r in text_runs:
                r.text = ""
            if text_runs:
                text_runs[0].text = new_text
                if bold is not None:
                    text_runs[0].bold = bold
                if italic is not None:
                    text_runs[0].italic = italic
                if font_name:
                    text_runs[0].font.name = font_name
                if font_size:
                    text_runs[0].font.size = font_size
                if font_color:
                    from docx.shared import RGBColor  # noqa: F401
                    text_runs[0].font.color.rgb = font_color
            else:
                run = para.add_run(new_text)
                if bold is not None:
                    run.bold = bold
                if italic is not None:
                    run.italic = italic
                if font_name:
                    run.font.name = font_name
                if font_size:
                    run.font.size = font_size
                if font_color:
                    from docx.shared import RGBColor  # noqa: F401
                    run.font.color.rgb = font_color
        elif not new_text:
            # Empty replacement — clear all non-icon runs, keep icons intact
            for r in text_runs:
                r.text = ""
        else:
            # No icon runs — full replacement, preserve first-run format
            para.clear()
            run = para.add_run(new_text)
            if bold is not None:
                run.bold = bold
            if italic is not None:
                run.italic = italic
            if font_name:
                run.font.name = font_name
            if font_size:
                run.font.size = font_size
            if font_color:
                from docx.shared import RGBColor  # noqa: F401
                run.font.color.rgb = font_color

    def _process_paragraphs(paragraphs, header_mode: bool = False):
        nonlocal placeholder_count
        for para in paragraphs:
            text = (para.text or "").strip()
            if not text:
                continue
            replacement = _replace_contact_line(text)
            if replacement is None and header_mode:
                replacement = _replace_header_value_line(text)
            if replacement is not None:
                _set_para_text_preserving_format(para, replacement)
                continue
            if placeholder_re.match(text):
                placeholder_count += 1
                if placeholder_count == 1:
                    _set_para_text_preserving_format(para, context.get("full_name") or "")
                elif placeholder_count == 2:
                    _set_para_text_preserving_format(para, context.get("current_position") or "")
                else:
                    # Additional dotted lines with no data — clear them
                    _set_para_text_preserving_format(para, "")

    def _process_tables(tables, header_mode: bool = False):
        for table in tables:
            for row in table.rows:
                for cell in row.cells:
                    _process_paragraphs(cell.paragraphs, header_mode=header_mode)

    # Process document body
    _process_paragraphs(doc.paragraphs, header_mode=False)
    _process_tables(doc.tables, header_mode=False)

    # Process headers and footers across all sections
    for section in doc.sections:
        # Standard, first-page, and even-page headers
        for header in [section.header, section.first_page_header, section.even_page_header]:
            if header:
                _process_paragraphs(header.paragraphs, header_mode=True)
                _process_tables(header.tables, header_mode=True)
        # Standard, first-page, and even-page footers
        for footer in [section.footer, section.first_page_footer, section.even_page_footer]:
            if footer:
                _process_paragraphs(footer.paragraphs, header_mode=True)
                _process_tables(footer.tables, header_mode=True)

def _resolve_rule_value(section: str, field: str, item: Dict[str, Any]) -> str:
    field = field or ""
    if field == "date_range":
        return str(item.get("date_range") or "")
    if field == "year":
        start = item.get("startDate") or ""
        end = item.get("endDate") or ""
        value = str(start or end or "")
        return value[:4] if value else ""

    # Standard mappings
    if section == "experience":
        if field == "companyName":
            return str(item.get("companyName") or "")
        if field == "jobTitle":
            return str(item.get("jobTitle") or "")
        if field == "duration":
            return str(item.get("duration") or "")
    if section == "projects":
        if field in {"displayTitle", "name"}:
            return str(item.get("displayTitle") or item.get("name") or "")
        if field == "client":
            return str(item.get("client") or "")
        if field == "duration":
            return str(item.get("duration") or "")
    if section == "education":
        if field == "institution":
            return str(item.get("institution") or item.get("school") or "")
        if field == "degree":
            degree = item.get("degree") or ""
            field_of = item.get("fieldOfStudy") or item.get("field") or ""
            return str(f"{degree} - {field_of}".strip(" -")) if field_of else str(degree)
        if field == "fieldOfStudy":
            return str(item.get("fieldOfStudy") or item.get("field") or "")
    if section == "certifications":
        if field == "name":
            return str(
                item.get("name")
                or item.get("title")
                or item.get("certification_name")
                or ""
            )
        if field == "issueDate":
            return str(item.get("issueDate") or item.get("issue_date") or item.get("issuedAt") or "")
        if field == "issuingOrganization":
            return str(item.get("issuingOrganization") or item.get("issuer") or "")

    return str(item.get(field) or "")


def _render_from_authoring_rules(
    template_path: str,
    output_path: str,
    context: Dict[str, Any],
    rules: Dict[str, Any],
) -> None:
    doc = DocxDocument(template_path)
    _fill_common_placeholders(doc, context)

    tables = rules.get("tables") or []
    for table_rule in tables:
        idx = table_rule.get("index")
        section = table_rule.get("section")
        if not idx or not section:
            continue
        if idx - 1 >= len(doc.tables):
            continue
        table = doc.tables[idx - 1]
        # Clear all data rows
        while len(table.rows) > 1:
            table._tbl.remove(table.rows[1]._tr)

        loop_key = table_rule.get("suggested_loop")
        if loop_key:
            items = context.get(loop_key) or []
        else:
            items = []

        col_map = table_rule.get("suggested_columns") or {}
        col_count = len(table.columns)

        if not items:
            # No data for this section — leave table with header row only
            continue

        for item in items:
            row = table.add_row().cells
            for col_idx in range(col_count):
                field = col_map.get(str(col_idx)) or ""
                row[col_idx].text = _resolve_rule_value(section, field, item) if field else ""

    doc.save(output_path)

def _expand_context_with_aliases(context: Dict[str, Any]) -> Dict[str, Any]:
    """Add alias keys to the context so DOCX templates using alternative
    placeholder names (e.g. ``{{ nom }}`` instead of ``{{ full_name }}``)
    resolve correctly.
    """
    expanded = dict(context)
    # Also provide first_name / last_name split.
    full_name = str(context.get("full_name") or "")
    first_name, last_name = _split_full_name(full_name)
    expanded.setdefault("first_name", first_name)
    expanded.setdefault("last_name", last_name)
    # Section aliases commonly used in community CV templates.
    expanded.setdefault("experience", expanded.get("work_experiences", []))
    expanded.setdefault("experiences", expanded.get("work_experiences", []))
    expanded.setdefault("education", expanded.get("educations", []))
    expanded.setdefault("formation", expanded.get("educations", []))

    for alias, canonical in DOCX_ALIASES.items():
        if alias not in expanded and canonical in expanded:
            expanded[alias] = expanded[canonical]
    return expanded


def standardize_template(
    template_path: str,
    output_dir: str,
    context: Dict[str, Any],
    output_formats: List[str],
    cached_field_mapping: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Standardize a template file. If PDF, convert to DOCX or handle overlay.
    Returns a dict with updated template_path, template_ext, auto_template_used,
    temp_dir, matched_template_path, and potentially a direct response.
    """
    template_ext = Path(template_path).suffix.lower()
    auto_template_used = False
    temp_dir = None
    matched_template_path = None

    if template_ext != ".pdf":
        return {
            "template_path": template_path,
            "template_ext": template_ext,
            "auto_template_used": auto_template_used,
            "temp_dir": temp_dir,
            "matched_template_path": matched_template_path,
            "response": None,
        }

    if "pdf" not in output_formats:
        output_formats.append("pdf")

    if template_ext != ".docx":
        # For PDFs, first try to use the overlay method which preserves the original layout.
        # If it's scanned, we might try to build a DOCX from it first.
        is_scanned = is_pdf_scanned(template_path)
        
        if is_scanned and os.getenv("CV_TEMPLATE_DOCX_FROM_SCAN", "1") != "0":
            docx_template_path = build_docx_template_from_scanned_pdf(
                template_path,
                output_dir=os.path.dirname(template_path),
            )
            if docx_template_path:
                logger.info(f"Using auto-generated DOCX template for scanned PDF: {docx_template_path}")
                return {
                    "template_path": docx_template_path,
                    "template_ext": ".docx",
                    "auto_template_used": True,
                    "temp_dir": None,
                    "matched_template_path": None,
                    "response": None,
                }

        # Attempt PDF text overlay (works for both native and scanned PDFs)
        overlay_mapping = None
        if isinstance(cached_field_mapping, dict):
            overlay_mapping = cached_field_mapping.get("overlay")
            if overlay_mapping is None and (
                cached_field_mapping.get("fields") or cached_field_mapping.get("tables")
            ):
                overlay_mapping = cached_field_mapping

        if overlay_mapping is None and os.getenv("CV_TEMPLATE_OVERLAY_AUTO", "1") != "0":
            overlay_mapping = build_auto_overlay_mapping(template_path, context)

        if overlay_mapping and (overlay_mapping.get("fields") or overlay_mapping.get("tables")):
            prefix = _safe_filename(context.get("full_name") or "cv")
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            base_name = f"{prefix}_{timestamp}"
            pdf_path = os.path.join(output_dir, f"{base_name}.pdf")
            logger.info(f"Using overlay mode for PDF: {template_path}")
            apply_pdf_overlay(template_path, pdf_path, context, overlay_mapping)
            return {
                "template_path": template_path,
                "template_ext": ".pdf",
                "auto_template_used": False,
                "temp_dir": None,
                "matched_template_path": None,
                "response": {
                    "docx_path": None,
                    "pdf_path": pdf_path,
                    "field_mapping": {"overlay": overlay_mapping},
                },
            }

        # If overlay didn't find any fields, handle fallback based on whether it's scanned or native
        if is_scanned:
            logger.info(f"Scanned PDF detected but no overlay found, running OCR rebuild: {template_path}")
            template_path = rebuild_scanned_template(template_path)
            template_ext = ".docx"
        else:
            # Native PDF: MUST use pdf2docx. OCR rebuild is only for scanned PDFs —
            # applying it to a native PDF produces garbled text and unusable results.
            logger.info(f"Converting native PDF template to DOCX using pdf2docx: {template_path}")
            try:
                from pdf2docx import Converter
            except ImportError:
                raise RuntimeError(
                    "pdf2docx is required to convert native PDF templates but is not installed. "
                    "Run: pip install pdf2docx  (then restart the service)."
                )
            temp_dir = tempfile.mkdtemp()
            converted_docx_path = os.path.join(temp_dir, "converted_template.docx")
            try:
                cv = Converter(template_path)
                cv.convert(converted_docx_path)
                cv.close()
                if not os.path.exists(converted_docx_path) or os.path.getsize(converted_docx_path) < 100:
                    raise RuntimeError("pdf2docx produced an empty or missing output file.")
                template_path = converted_docx_path
                template_ext = ".docx"
            except RuntimeError:
                raise
            except Exception as e:
                logger.error(f"Failed to convert PDF template to DOCX: {e}")
                raise RuntimeError(f"PDF to DOCX conversion failed: {e}")

    return {
        "template_path": template_path,
        "template_ext": template_ext,
        "auto_template_used": auto_template_used,
        "temp_dir": temp_dir,
        "matched_template_path": matched_template_path,
        "response": None,
    }


def generate_cv_document(
    profile: Dict[str, Any],
    template_path: str,
    output_dir: str,
    output_formats: List[str],
    target_language: Optional[str] = None,
    translate: bool = True,
    filename_prefix: Optional[str] = None,
    cached_field_mapping: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Generate a CV document from a template and profile data.

    Args:
        cached_field_mapping: Previously computed PDF field mapping to reuse.
            When provided the heuristic + LLM analysis is skipped.

    Returns:
        dict with ``docx_path``, ``pdf_path``, and ``field_mapping``
        (the computed mapping to cache on the template).
    """
    if not os.path.exists(template_path):
        raise FileNotFoundError(f"Template not found: {template_path}")

    Path(output_dir).mkdir(parents=True, exist_ok=True)

    context = _build_context(profile)
    if translate and target_language:
        payload = _build_translation_payload(context)
        translated = translate_json_payload(payload, target_language)
        context = _apply_translations(context, translated)

        # Translate description_lines in a dedicated pass for better coverage.
        lines_payload = {
            "work_experience_lines": [
                exp.get("description_lines", []) for exp in context.get("work_experiences", [])
            ],
            "project_lines": [
                proj.get("description_lines", []) for proj in context.get("projects", [])
            ],
        }
        translated_lines = translate_json_payload(lines_payload, target_language)
        we_lines = translated_lines.get("work_experience_lines") if isinstance(translated_lines, dict) else None
        if isinstance(we_lines, list):
            for idx, exp in enumerate(context.get("work_experiences", [])):
                if idx < len(we_lines) and isinstance(we_lines[idx], list):
                    exp["description_lines"] = _normalize_lines(we_lines[idx])
                elif idx < len(we_lines) and we_lines[idx] is not None:
                    exp["description_lines"] = _normalize_lines(we_lines[idx])

    # Set the open-ended label after translation so it matches target language.
    if target_language:
        lang = target_language.lower()
        if lang.startswith("fr"):
            context["open_end_label"] = "Aujourd'hui"
        elif lang.startswith("en"):
            context["open_end_label"] = "Present"
        elif lang.startswith("es"):
            context["open_end_label"] = "Actualidad"
        elif lang.startswith("de"):
            context["open_end_label"] = "Heute"
        elif lang.startswith("it"):
            context["open_end_label"] = "Presente"
        elif lang.startswith("ar"):
            context["open_end_label"] = "حاليًا"
        else:
            context["open_end_label"] = "Present"

    # Derive last degree fields when available.
    if not context.get("last_degree") and not context.get("last_degree_year"):
        degree, year = _derive_last_degree(context)
        context["last_degree"] = degree
        context["last_degree_year"] = year

    # Precompute date ranges for table-friendly templates.
    open_end_label = context.get("open_end_label") or "Present"
    for exp in context.get("work_experiences", []) or []:
        start = exp.get("startDate") or ""
        end = exp.get("endDate") or ""
        if start and not end:
            end = open_end_label
        if start and end:
            exp["date_range"] = f"{start} - {end}"
        else:
            exp["date_range"] = str(start or end or "")

    for proj in context.get("projects", []) or []:
        start = proj.get("startDate") or ""
        end = proj.get("endDate") or ""
        if start and not end:
            end = open_end_label
        if start and end:
            proj["date_range"] = f"{start} - {end}"
        else:
            proj["date_range"] = str(start or end or "")

    for edu in context.get("educations", []) or []:
        start = edu.get("startDate") or ""
        end = edu.get("endDate") or edu.get("graduationDate") or ""
        if start and not end:
            end = open_end_label
        if start and end:
            edu["date_range"] = f"{start} - {end}"
        else:
            edu["date_range"] = str(start or end or edu.get("year") or "")

    prefix = filename_prefix or _safe_filename(context.get("full_name") or "cv")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    base_name = f"{prefix}_{timestamp}"

    # Standardize template (conversion, OCR, etc.)
    original_template_path = template_path
    std_result = standardize_template(
        template_path, output_dir, context, output_formats, cached_field_mapping
    )
    if std_result["response"]:
        return std_result["response"]

    template_path = std_result["template_path"]
    template_ext = std_result["template_ext"]
    auto_template_used = std_result["auto_template_used"]
    temp_dir = std_result["temp_dir"]
    matched_template_path = std_result["matched_template_path"]

    # Analyzer-driven rendering (no DB storage)
    analyzer_only = os.getenv("CV_TEMPLATE_ANALYZER_ONLY", "0") != "0"
    if template_ext == ".docx" and os.getenv("CV_TEMPLATE_USE_ANALYZER", "1") != "0":
        try:
            doc = DocxDocument(template_path)
            if not _docx_contains_jinja(doc):
                rules = _analyze_authoring_rules_docx(template_path)
                min_conf = 0.5
                try:
                    min_conf = float(os.getenv("CV_TEMPLATE_ANALYZER_MIN_CONF", "0.5"))
                except Exception:
                    min_conf = 0.5
                if rules.get("confidence", 0) >= min_conf and any(
                    t.get("section") for t in (rules.get("tables") or [])
                ):
                    logger.info(
                        f"[DEBUG] Using analyzer rules (confidence={rules.get('confidence')}) for rendering."
                    )
                    docx_path = os.path.join(output_dir, f"{base_name}.docx")
                    _render_from_authoring_rules(template_path, docx_path, context, rules)
                    pdf_path = None
                    if "pdf" in output_formats:
                        pdf_path = _convert_to_pdf(docx_path, output_dir)
                    return {
                        "docx_path": docx_path,
                        "pdf_path": pdf_path,
                        "field_mapping": None,
                        "matched_template_path": matched_template_path,
                    }
                if analyzer_only:
                    raise RuntimeError(
                        "Analyzer rules were insufficient to render this template. "
                        "Add explicit DOCX tags or adjust headers to match detected sections."
                    )
        except Exception as exc:
            if analyzer_only:
                raise
            logger.warning(f"[WARN] Analyzer-based rendering failed: {exc}")

    # --- Auto-tag if the template has no Jinja2 tags ---
    from app.services.template_tagger import auto_tag_template
    raw_template_path = template_path
    tagged_path = template_path
    if not auto_template_used:
        tagged_path = auto_tag_template(template_path)
    # If the path changed, that means it generated a tagged file; we should use it!
    # Update: wait, in cv_generator `tagged_path` is the NEW template_path, so template_path is updated. 
    # We just need to capture the tagged_path to remove it at the end.
    
    # Actually wait I see a bug, earlier I wrote `if tagged_path != template_path:` at line 265 but I reassigned template_path! 
    # Let's fix that. I should keep original_template_path.
    original_template_path = template_path
    logger.info(f"[DEBUG] Pre-tagger template path: {template_path}")
    if tagged_path != template_path:
        logger.info(f"[DEBUG] Auto-tagger produced tagged template: {tagged_path}")
        template_path = tagged_path
    else:
        logger.info("[DEBUG] No changes made by Auto-tagger.")

    # --- DOCX generation (handles both original DOCX and converted PDFs) ---
    docx_path = os.path.join(output_dir, f"{base_name}.docx")
    logger.info(f"[DEBUG] Initializing DocxTemplate with path: {template_path}")
    doc = DocxTemplate(template_path)
    # Expand context with aliases so flexible placeholder names work.
    render_context = _expand_context_with_aliases(context)

    # --- Debug: List all variables in the template vs what we have ---
    try:
        template_vars = doc.get_undeclared_template_variables()
        if template_vars:
            logger.warning(f"[DEBUG] Template variables detected: {sorted(list(template_vars))}")
            missing = [v for v in template_vars if v not in render_context]
            if missing:
                logger.warning(f"[WARN] Template contains variables NOT in context: {missing}")
            else:
                logger.warning("[DEBUG] All template variables are present in the rendering context.")
    except Exception as exc:
        logger.debug(f"[DEBUG] Could not analyze template variables: {exc}")

    
    # Log the exact dictionary being passed to DocxTemplate
    logger.warning(f"[DEBUG] --- JINJA2 RENDERING START ---")
    logger.warning(f"[DEBUG] Template path: {template_path}")
    logger.warning(f"[DEBUG] Context keys: {sorted(list(render_context.keys()))}")

    # Log individual fields
    for key in ["full_name", "email", "phone", "address", "current_position", "professional_summary", "date_range", "total_experience_years"]:
        if key in render_context:
            logger.warning(f"[DEBUG]   Field '{key}': {render_context[key]}")

    # Log list-backed sections with summaries
    for list_key in ["work_experiences", "educations", "projects", "skills", "languages", "certifications", "experience", "experiences", "formation"]:
        if list_key in render_context:
            items = render_context[list_key]
            if not isinstance(items, list):
                logger.warning(f"[DEBUG]   List '{list_key}' is not a list: {type(items)}")
                continue
            logger.warning(f"[DEBUG]   List '{list_key}': {len(items)} items")
            # Log the context for the list items if they are dicts
            for i, item in enumerate(items):
                if isinstance(item, dict):
                    # Filter out empty fields and truncate long ones for cleaner logs
                    clean_item = {k: (str(v)[:60] + "...") if len(str(v)) > 60 else v for k, v in item.items() if v is not None}
                    logger.warning(f"[DEBUG]     {list_key}[{i}]: {clean_item}")
                else:
                    logger.warning(f"[DEBUG]     {list_key}[{i}]: {item}")

    logger.warning("[DEBUG] Executing doc.render()...")
    try:
        doc.render(render_context)
        logger.warning("[DEBUG] doc.render() finished.")
        # Apply global cleanup (handle orphaned dotted placeholders or label-based contact info)
        _fill_common_placeholders(doc, context)
        logger.warning("[DEBUG] Global placeholder cleanup finished.")
    except TemplateSyntaxError as exc:
        logger.error(f"[ERROR] Template syntax error during render: {exc}")
        # If auto-tagging produced a bad template, retry once with conditionals disabled.
        if tagged_path != raw_template_path:
            prev_flag = os.getenv("CV_TEMPLATE_TAGGER_CONDITIONALS")
            os.environ["CV_TEMPLATE_TAGGER_CONDITIONALS"] = "0"
            try:
                safe_tagged = auto_tag_template(raw_template_path)
                logger.warning(
                    f"[WARN] Retrying render with conditionals disabled using tagged template: {safe_tagged}"
                )
                template_path = safe_tagged
                tagged_path = safe_tagged
                doc = DocxTemplate(template_path)
                doc.render(render_context)
                logger.info("[DEBUG] doc.render() finished (safe mode).")
            finally:
                if prev_flag is None:
                    os.environ.pop("CV_TEMPLATE_TAGGER_CONDITIONALS", None)
                else:
                    os.environ["CV_TEMPLATE_TAGGER_CONDITIONALS"] = prev_flag
        else:
            raise
    doc.save(docx_path)

    # if auto_template_used:
    #     try:
    #         _postprocess_annexe9_tables(docx_path, context)
    #         logger.warning("[DEBUG] Annexe 9 tables post-processed.")
    #     except Exception as exc:
    #         logger.warning(f"[WARN] Annexe 9 post-processing failed: {exc}")

    try:
        pass
    except Exception as exc:
        logger.warning("Post-processing overflow fixes failed (non-fatal): %s", exc)

    if translate and target_language and target_language not in ("original", "orig"):
        try:
            from app.services.cv_generator_fallback import _translate_section_headings_in_docx
            _translate_section_headings_in_docx(docx_path, target_language)
        except Exception as exc:
            logger.warning("Section heading translation failed (non-fatal): %s", exc)

    pdf_path = None
    if "pdf" in output_formats:
        pdf_path = _convert_to_pdf(docx_path, output_dir)
        
    # Clean up temporary directories (pdf2docx conversion + auto-tagger)
    if temp_dir and os.path.exists(temp_dir):
        shutil.rmtree(temp_dir, ignore_errors=True)
    if template_path != original_template_path and tagged_path == template_path:
        tagged_dir = os.path.dirname(tagged_path)
        if tagged_dir and os.path.exists(tagged_dir) and tagged_dir.startswith(tempfile.gettempdir()):
            shutil.rmtree(tagged_dir, ignore_errors=True)

    return {
        "docx_path": docx_path,
        "pdf_path": pdf_path,
        "field_mapping": None,
        "matched_template_path": matched_template_path,
    }




def _split_full_name(full_name: str) -> tuple[str, str]:
    parts = [part for part in full_name.split(" ") if part]
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def _infer_section(tokens: set[str]) -> Optional[str]:
    if tokens & {
        "project", "projects", "proj",
        # French
        "projet", "projets",
    }:
        return "project"
    if tokens & {
        "cert", "certs", "certification", "certificate", "license", "licence", "credential",
        # French
        "certificat", "certificats", "attestation", "attestations", "habilitation",
    }:
        return "certification"
    if tokens & {
        "education", "edu", "school", "university", "college", "academic", "study",
        # French
        "formation", "formations", "etude", "etudes", "diplome", "diplomes",
        "ecole", "universite", "scolarite",
    }:
        return "education"
    if tokens & {
        "experience", "employment", "work", "job", "career",
        # French
        "emploi", "parcours", "poste", "postes", "exp",
    }:
        return "experience"
    return None


def _infer_attribute(section: str, tokens: set[str]) -> Optional[str]:
    if section == "experience":
        if tokens & {"title", "position", "role", "job", "poste", "fonction", "intitule"}:
            return "title"
        if tokens & {"company", "employer", "organization", "organisation", "client",
                     "entreprise", "societe", "employeur"}:
            return "company"
        if tokens & {"start", "from", "debut"}:
            return "start"
        if tokens & {"end", "to", "until", "fin"}:
            return "end"
        if tokens & {"date", "dates", "period", "duration", "timeframe", "periode", "duree"}:
            return "dates"
        if tokens & {"description", "summary", "details", "responsibilities", "duties",
                     "desc", "resp", "missions", "taches", "activites"}:
            return "description"
    if section == "education":
        if tokens & {"degree", "diploma", "qualification", "diplome", "titre"}:
            return "degree"
        if tokens & {"field", "major", "specialization", "specialisation", "subject",
                     "filiere", "domaine", "specialite"}:
            return "field"
        if tokens & {"institution", "school", "university", "college", "academy",
                     "etablissement", "ecole", "universite"}:
            return "institution"
        if tokens & {"start", "from", "debut"}:
            return "start"
        if tokens & {"end", "to", "until", "graduation", "date", "year", "fin", "annee"}:
            return "end"
    if section == "certification":
        if tokens & {"name", "title", "cert", "certification", "certificate",
                     "nom", "intitule", "certificat"}:
            return "name"
        if tokens & {"issuer", "organization", "organisation", "provider", "authority",
                     "emetteur", "organisme"}:
            return "issuer"
        if tokens & {"id", "credential", "license", "licence", "number", "numero"}:
            return "credential"
        if tokens & {"date", "issued", "issue", "year", "valid", "expiry", "expiration",
                     "expire", "obtention", "delivrance", "validite"}:
            return "date"
    if section == "project":
        if tokens & {"name", "title", "project", "nom", "intitule", "projet"}:
            return "name"
        if tokens & {"role", "position", "responsibility", "fonction"}:
            return "role"
        if tokens & {"client", "customer", "company", "donneur"}:
            return "client"
        if tokens & {"start", "from", "debut"}:
            return "start"
        if tokens & {"end", "to", "until", "fin"}:
            return "end"
        if tokens & {"date", "dates", "period", "duration", "periode", "duree"}:
            return "dates"
        if tokens & {"description", "summary", "details", "desc", "missions"}:
            return "description"
        if tokens & {"skills", "skill", "tech", "technology", "stack", "tools",
                     "competences", "technologies", "outils"}:
            return "skills"
    return None


try:
    from app.services.cv_generator_fallback import (
        NS_A as _FALLBACK_NS_A,
        NS_MC as _FALLBACK_NS_MC,
        NS_W as _FALLBACK_NS_W,
        NS_WPS as _FALLBACK_NS_WPS,
        _WPS_TXBX as _FALLBACK_WPS_TXBX,
        _build_replacements as _fallback_build_replacements,
        _build_section_content as _fallback_build_section_content,
        _compute_input_hash as _fallback_compute_input_hash,
        _detect_template_mode as _fallback_detect_template_mode,
        _detect_personal_info as _fallback_detect_personal_info,
        _extract_all_text as _fallback_extract_all_text,
        _fill_table_section as _fallback_fill_table_section,
        _get_paragraph_texts as _fallback_get_paragraph_texts,
        _identify_section_lxml as _fallback_identify_section_lxml,
        _is_contact_field_value as _fallback_is_contact_field_value,
        _is_mega_contact_para as _fallback_is_mega_contact_para,
        _make_para_elem as _fallback_make_para_elem,
        _xml_safe_text as _fallback_xml_safe_text,
        cleanEmployeeData as _fallback_clean_employee_data,
        process_cv as _fallback_process_cv,
    )

    _extract_all_text = _fallback_extract_all_text
    _get_paragraph_texts = _fallback_get_paragraph_texts
    _detect_personal_info = _fallback_detect_personal_info
    _detect_template_mode = _fallback_detect_template_mode
    _compute_input_hash = _fallback_compute_input_hash
    _build_replacements = _fallback_build_replacements
    _identify_section_lxml = _fallback_identify_section_lxml
    _fill_table_section = _fallback_fill_table_section
    _is_mega_contact_para = _fallback_is_mega_contact_para
    _is_contact_field_value = _fallback_is_contact_field_value
    _make_para_elem = _fallback_make_para_elem
    _xml_safe_text = _fallback_xml_safe_text
    cleanEmployeeData = _fallback_clean_employee_data
    NS_W = _FALLBACK_NS_W
    NS_A = _FALLBACK_NS_A
    NS_MC = _FALLBACK_NS_MC
    NS_WPS = _FALLBACK_NS_WPS
    _WPS_TXBX = _FALLBACK_WPS_TXBX
except Exception:
    pass


def process_cv(
    template_path: str,
    employee_data: Dict[str, Any],
    output_dir: str,
    output_pdf: bool = False,
    debug: bool = False,
    language: str = "original",
    out_warnings: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """Compatibility wrapper around the shared direct-generation runtime."""
    if '_fallback_process_cv' in globals():
        try:
            return _fallback_process_cv(
                template_path=template_path,
                employee_data=employee_data,
                output_dir=output_dir,
                output_pdf=output_pdf,
                debug=debug,
                language=language,
                out_warnings=out_warnings,
            )
        except (FileNotFoundError, ValueError):
            raise
        except Exception as exc:
            if os.getenv("CV_PRIMARY_RETRY_WITH_LEGACY_GENERATOR", "1") == "0":
                raise
            logger.warning(
                "Shared direct-generation runtime failed; retrying with legacy primary generator: %s",
                exc,
                exc_info=True,
            )
            if out_warnings is not None:
                out_warnings.append({
                    "code": "legacy_primary_retry",
                    "message": "Shared direct-generation runtime failed; used legacy primary generator.",
                    "details": str(exc),
                })

    result = generate_cv_document(
        profile=employee_data,
        template_path=template_path,
        output_dir=output_dir,
        output_formats=["docx", "pdf"] if output_pdf else ["docx"],
        target_language=None if language in {"", "original", "orig"} else language,
        translate=language not in {"", "original", "orig"},
    )
    if output_pdf and result.get("pdf_path"):
        return result["pdf_path"]
    return result["docx_path"]


def _build_pdf_autofill_map(
    context: Dict[str, Any], reader: PdfReader
) -> tuple[Dict[str, str], Dict[str, str]]:
    """Return (field_values_map, mapping_record).

    ``field_values_map`` maps PDF field names to resolved string values.
    ``mapping_record`` maps PDF field names to canonical context keys
    (suitable for caching on the template entity).
    """
    pdf_fields = reader.get_fields() or {}
    canonical_map = _build_pdf_field_map(context)

    if not pdf_fields:
        logger.info("No PDF form fields detected, using canonical field map.")
        identity_mapping = {k: k for k in canonical_map}
        return canonical_map, identity_mapping

    normalized_canonical = { _normalize_field_name(key): value for key, value in canonical_map.items() }
    full_name = str(context.get("full_name") or "")
    first_name, last_name = _split_full_name(full_name)

    def pick_single_value(tokens: set[str]) -> Optional[str]:
        if "email" in tokens or "e_mail" in tokens or "mail" in tokens or "courriel" in tokens:
            return str(context.get("email") or "")
        if tokens & {"phone", "mobile", "tel", "telephone", "cell", "portable", "numero"}:
            return str(context.get("phone") or "")
        if tokens & {"address", "location", "adresse", "lieu", "ville"}:
            return str(context.get("address") or "")
        if tokens & {"summary", "profile", "objective", "about", "overview",
                     "profil", "resume", "synthese", "objectif", "presentation"}:
            return str(context.get("professional_summary") or "")
        if tokens & {"skills", "skill", "competencies", "competency", "technologies",
                     "technology", "tech", "stack", "tools",
                     "competences", "competence", "savoir", "faire", "outils"}:
            return "\n".join([str(s) for s in context.get("skills", []) or []])
        if "years" in tokens and tokens & {"experience", "annees"}:
            return str(context.get("total_experience_years") or "")
        if tokens & {"current", "present", "actuel", "actuelle"} and tokens & {"position", "title", "role", "job", "poste", "fonction"}:
            return str(context.get("current_position") or "")
        if tokens & {"position", "title", "role", "job", "poste", "fonction"} and not tokens & {"experience", "employment", "work", "emploi"}:
            return str(context.get("current_position") or "")
        if tokens & {"first", "firstname"} and "name" in tokens:
            return first_name
        if tokens & {"last", "lastname", "surname", "family"} and "name" in tokens:
            return last_name

        if "name" in tokens:
            blockers = {
                "company",
                "employer",
                "institution",
                "school",
                "university",
                "college",
                "project",
                "client",
                "certificate",
                "certification",
                "issuer",
                "organization",
                "organisation",
            }
            if not tokens & blockers:
                return full_name
        return None

    def pick_indexed_value(section: str, attr: str, idx: int) -> Optional[str]:
        if idx <= 0:
            return None
        index = idx - 1
        if section == "experience":
            items = context.get("work_experiences", []) or []
            if index >= len(items):
                return ""
            exp = items[index]
            if attr == "title":
                return str(exp.get("jobTitle") or "")
            if attr == "company":
                return str(exp.get("companyName") or "")
            if attr == "start":
                return str(exp.get("startDate") or "")
            if attr == "end":
                return str(exp.get("endDate") or "")
            if attr == "dates":
                return _format_date_range(exp.get("startDate"), exp.get("endDate"))
            if attr == "description":
                return str(exp.get("description") or "")
        if section == "education":
            items = context.get("educations", []) or []
            if index >= len(items):
                return ""
            edu = items[index]
            if attr == "degree":
                return str(edu.get("degree") or "")
            if attr == "field":
                return str(edu.get("fieldOfStudy") or "")
            if attr == "institution":
                return str(edu.get("institution") or "")
            if attr == "start":
                return str(edu.get("startDate") or "")
            if attr == "end":
                return str(edu.get("endDate") or "")
        if section == "certification":
            items = context.get("certifications", []) or []
            if index >= len(items):
                return ""
            cert = items[index]
            if attr == "name":
                return str(cert.get("name") or "")
            if attr == "issuer":
                return str(cert.get("issuingOrganization") or "")
            if attr == "credential":
                return str(cert.get("credentialId") or "")
            if attr == "date":
                return str(cert.get("issueDate") or "")
        if section == "project":
            items = context.get("projects", []) or []
            if index >= len(items):
                return ""
            proj = items[index]
            if attr == "name":
                return str(proj.get("name") or "")
            if attr == "role":
                return str(proj.get("role") or "")
            if attr == "client":
                return str(proj.get("client") or "")
            if attr == "start":
                return str(proj.get("startDate") or "")
            if attr == "end":
                return str(proj.get("endDate") or "")
            if attr == "dates":
                return _format_date_range(proj.get("startDate"), proj.get("endDate"))
            if attr == "description":
                return str(proj.get("description") or "")
            if attr == "skills":
                skills = proj.get("skills") or []
                if isinstance(skills, list):
                    return ", ".join([str(s) for s in skills])
        return None

    field_map: Dict[str, str] = {}
    mapping_record: Dict[str, str] = {}  # PDF field → context key (for caching)
    unmatched_fields: List[str] = []

    def infer_section_from_attributes(tokens: set[str]) -> Optional[str]:
        if tokens & {"degree", "diploma", "qualification", "institution", "school",
                     "university", "college", "diplome", "ecole", "universite",
                     "etablissement", "filiere"}:
            return "education"
        if tokens & {"cert", "certs", "certification", "certificate", "license",
                     "licence", "credential", "issuer", "certificat", "attestation",
                     "habilitation", "emetteur", "organisme"}:
            return "certification"
        if tokens & {"project", "projects", "proj", "client",
                     "projet", "projets", "donneur"}:
            return "project"
        if tokens & {"company", "employer", "position", "role", "job", "experience",
                     "title", "entreprise", "societe", "employeur", "poste",
                     "fonction", "emploi"}:
            return "experience"
        return None

    for field_name in pdf_fields.keys():
        normalized = _normalize_field_name(field_name)
        tokens = set(_tokenize_field_name(field_name))
        if field_name in canonical_map:
            field_map[field_name] = canonical_map[field_name]
            mapping_record[field_name] = field_name
            continue
        if normalized in normalized_canonical:
            field_map[field_name] = normalized_canonical[normalized]
            mapping_record[field_name] = normalized
            continue

        index = _extract_index(normalized)
        section = _infer_section(tokens)
        if index and not section:
            section = infer_section_from_attributes(tokens)
        if section and index:
            attr = _infer_attribute(section, tokens) or "summary"
            indexed_value = pick_indexed_value(section, attr, index)
            if indexed_value is not None:
                field_map[field_name] = indexed_value
                mapping_record[field_name] = f"{section}_{index}_{attr}"
                continue

        single_value = pick_single_value(tokens)
        if single_value is not None:
            field_map[field_name] = single_value
            # Try to record the canonical key for caching.
            for ck, cv in canonical_map.items():
                if cv == single_value:
                    mapping_record[field_name] = ck
                    break
            else:
                mapping_record[field_name] = normalized
            continue

        if section:
            # Map section-level fields to aggregated text when no index is present.
            section_key_map = {
                "experience": "work_experiences",
                "education": "educations",
                "certification": "certifications",
                "project": "projects",
            }
            ctx_key = section_key_map.get(section, "")
            if ctx_key:
                field_map[field_name] = canonical_map.get(ctx_key, "")
                mapping_record[field_name] = ctx_key
            continue

        unmatched_fields.append(field_name)

    # --- LLM fallback for remaining unmatched fields ---
    if unmatched_fields:
        logger.info("Attempting LLM mapping for %d unmatched fields: %s",
                    len(unmatched_fields), ", ".join(unmatched_fields[:20]))
        llm_results = _llm_map_fields(unmatched_fields, context, canonical_map)
        for field_name, result_entry in llm_results.items():
            if isinstance(result_entry, dict):
                # LLM returned {"key": ..., "value": ...}
                context_key = result_entry.get("key", "NONE")
                generated_value = result_entry.get("value")
            else:
                context_key = str(result_entry)
                generated_value = None

            if context_key and context_key != "NONE":
                if context_key in canonical_map:
                    field_map[field_name] = canonical_map[context_key]
                elif context_key in normalized_canonical:
                    field_map[field_name] = normalized_canonical[context_key]
                elif generated_value:
                    field_map[field_name] = str(generated_value)
                else:
                    field_map[field_name] = str(context.get(context_key) or "")
                mapping_record[field_name] = context_key
            elif generated_value:
                # LLM generated a value directly (e.g. composed from DB data)
                field_map[field_name] = str(generated_value)
                mapping_record[field_name] = "_llm_generated"
            else:
                mapping_record[field_name] = "NONE"
        still_unmatched = [
            f for f in unmatched_fields
            if f not in llm_results
            or (isinstance(llm_results[f], str) and llm_results[f] == "NONE")
            or (isinstance(llm_results[f], dict) and llm_results[f].get("key") == "NONE" and not llm_results[f].get("value"))
        ]
        if still_unmatched:
            logger.info("Still unmapped after LLM: %s", ", ".join(still_unmatched[:20]))

    return field_map, mapping_record


def _format_date_range(start_value: Any, end_value: Any) -> str:
    start = str(start_value or "").strip()
    end = str(end_value or "").strip()
    if start and end:
        return f"{start} - {end}"
    return start or end


def _derive_last_degree(context: Dict[str, Any]) -> tuple[str, str]:
    educations = context.get("educations") or []
    if not educations:
        return "", ""

    def sort_key(edu: Dict[str, Any]) -> str:
        return str(edu.get("endDate") or edu.get("startDate") or "")

    latest = sorted(educations, key=sort_key, reverse=True)[0]
    degree = str(latest.get("degree") or latest.get("fieldOfStudy") or "")
    year = str(latest.get("endDate") or latest.get("startDate") or "")
    if year and len(year) >= 4:
        year = year[:4]
    return degree, year


def _build_pdf_field_map(context: Dict[str, Any]) -> Dict[str, str]:
    def join_items(items: List[Dict[str, Any]], fmt: str, empty_placeholder: str = "N/A") -> str:
        if not items:
            return empty_placeholder
        lines: List[str] = []
        for item in items:
            try:
                lines.append(fmt.format(**item))
            except Exception:
                lines.append(" ".join([str(v) for v in item.values() if v]))
        return "\n".join(lines)

    experiences = context.get("work_experiences", []) or []
    educations = context.get("educations", []) or []
    certifications = context.get("certifications", []) or []
    projects = context.get("projects", []) or []

    field_map: Dict[str, str] = {
        "full_name": str(context.get("full_name") or ""),
        "email": str(context.get("email") or ""),
        "phone": str(context.get("phone") or ""),
        "address": str(context.get("address") or ""),
        "current_position": str(context.get("current_position") or ""),
        "professional_summary": str(context.get("professional_summary") or ""),
        "total_experience_years": str(context.get("total_experience_years") or ""),
        "skills": "\n".join([str(s) for s in context.get("skills", []) or []]) or "N/A",
        "work_experiences": join_items(
            experiences,
            "{jobTitle} — {companyName} ({startDate} - {endDate})\n{description}",
        ),
        "educations": join_items(
            educations,
            "{degree} {fieldOfStudy} — {institution} ({endDate})",
        ),
        "certifications": join_items(
            certifications,
            "{name} — {issuingOrganization} ({issueDate})",
        ),
        "projects": join_items(
            projects,
            "{name} — {role} ({startDate} - {endDate})\n{description}",
        ),
    }

    # Provide indexed fields if the PDF template uses numbered field names.
    for idx, exp in enumerate(experiences, start=1):
        field_map[f"work_experience_{idx}_title"] = str(exp.get("jobTitle") or "")
        field_map[f"work_experience_{idx}_company"] = str(exp.get("companyName") or "")
        field_map[f"work_experience_{idx}_dates"] = _format_date_range(exp.get("startDate"), exp.get("endDate"))
        field_map[f"work_experience_{idx}_description"] = str(exp.get("description") or "")

    for idx, edu in enumerate(educations, start=1):
        field_map[f"education_{idx}_degree"] = str(edu.get("degree") or "")
        field_map[f"education_{idx}_field"] = str(edu.get("fieldOfStudy") or "")
        field_map[f"education_{idx}_institution"] = str(edu.get("institution") or "")
        field_map[f"education_{idx}_date"] = str(edu.get("endDate") or "")
        field_map[f"education_{idx}_start"] = str(edu.get("startDate") or "")

    for idx, cert in enumerate(certifications, start=1):
        field_map[f"certification_{idx}_name"] = str(cert.get("name") or "")
        field_map[f"certification_{idx}_issuer"] = str(cert.get("issuingOrganization") or "")
        field_map[f"certification_{idx}_date"] = str(cert.get("issueDate") or "")

    for idx, proj in enumerate(projects, start=1):
        field_map[f"project_{idx}_name"] = str(proj.get("name") or "")
        field_map[f"project_{idx}_role"] = str(proj.get("role") or "")
        field_map[f"project_{idx}_client"] = str(proj.get("client") or "")
        field_map[f"project_{idx}_dates"] = _format_date_range(proj.get("startDate"), proj.get("endDate"))
        field_map[f"project_{idx}_description"] = str(proj.get("description") or "")
        skills = proj.get("skills") or []
        if isinstance(skills, list):
            field_map[f"project_{idx}_skills"] = ", ".join([str(s) for s in skills])

    return {k: v for k, v in field_map.items() if v is not None}


def _convert_to_pdf(docx_path: str, output_dir: str) -> str:
    """Convert DOCX to PDF using LibreOffice headless."""
    # Use LIBREOFFICE_PATH env var (same as cv_generator_fallback._find_libreoffice)
    _soffice = os.environ.get("LIBREOFFICE_PATH") or ""
    if not _soffice or not os.path.exists(_soffice):
        import sys as _sys
        if _sys.platform == "win32":
            for _cand in [
                r"C:\Program Files\LibreOffice\program\soffice.exe",
                r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
            ]:
                if os.path.exists(_cand):
                    _soffice = _cand
                    break
        if not _soffice:
            _soffice = "soffice"  # fallback: must be in PATH
    cmd = [
        _soffice,
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        output_dir,
        docx_path,
    ]
    logger.info(f"Converting DOCX to PDF with LibreOffice: {' '.join(cmd)}")
    completed = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if completed.returncode != 0:
        logger.error(f"PDF conversion failed: {completed.stderr}")
        raise RuntimeError("Failed to convert DOCX to PDF. Ensure LibreOffice is installed.")

    pdf_path = os.path.splitext(docx_path)[0] + ".pdf"
    if not os.path.exists(pdf_path):
        raise RuntimeError("PDF conversion did not produce output file")
    return pdf_path


async def convert_to_pdf_safe(docx_path: str, output_dir: str) -> str:
    """Thread-safe, serialized DOCX-to-PDF conversion.

    LibreOffice uses a per-user lock file and crashes when multiple
    ``soffice`` processes run concurrently.  This wrapper serializes
    invocations through an asyncio semaphore and runs the blocking
    subprocess in a thread so the event loop is never blocked.
    """
    async with _SOFFICE_SEMAPHORE:
        return await asyncio.get_event_loop().run_in_executor(
            None, _convert_to_pdf, docx_path, output_dir
        )


# ---------------------------------------------------------------------------
# Template analysis – extracts field/placeholder names from a template
# and runs the mapping pipeline without generating output.
# ---------------------------------------------------------------------------

def analyze_template(template_path: str) -> Dict[str, Any]:
    """Extract and map all fields from a template file.

    Returns a dict with ``fields`` (list of field analysis dicts),
    ``field_mapping`` (the computed mapping), and ``detected_fields``
    (raw list of field/placeholder names).
    """
    if not os.path.exists(template_path):
        raise FileNotFoundError(f"Template not found: {template_path}")

    ext = Path(template_path).suffix.lower()

    if ext == ".pdf":
        if is_pdf_scanned(template_path):
            rebuilt_path = rebuild_scanned_template(template_path)
            result = _analyze_docx_template(rebuilt_path)
            result["template_type"] = "pdf_scanned"
            result["rebuilt_docx_path"] = rebuilt_path
            result["authoring_rules"] = _analyze_authoring_rules_docx(
                rebuilt_path,
                note="Rules derived from OCR rebuild of scanned PDF.",
            )
            return result
        return _analyze_pdf_template(template_path)

    if ext == ".docx":
        if is_docx_scanned(template_path):
            rebuilt_path = rebuild_scanned_template(template_path)
            result = _analyze_docx_template(rebuilt_path)
            result["template_type"] = "docx_scanned"
            result["rebuilt_docx_path"] = rebuilt_path
            result["authoring_rules"] = _analyze_authoring_rules_docx(
                rebuilt_path,
                note="Rules derived from OCR rebuild of scanned DOCX.",
            )
            return result
        result = _analyze_docx_template(template_path)
        result["authoring_rules"] = _analyze_authoring_rules_docx(template_path)
        return result

    raise ValueError(f"Unsupported template type: {ext}")


def _analyze_pdf_template(template_path: str) -> Dict[str, Any]:
    from pdf2docx import Converter
    import tempfile
    import shutil
    
    temp_dir = tempfile.mkdtemp()
    converted_docx_path = os.path.join(temp_dir, "converted_template.docx")
    
    try:
        cv = Converter(template_path)
        cv.convert(converted_docx_path)
        cv.close()
        
        # Analyze it exactly as if it were a DOCX file
        result = _analyze_docx_template(converted_docx_path)
        result["template_type"] = "pdf"
        result["authoring_rules"] = _analyze_authoring_rules_docx(
            converted_docx_path,
            note="Rules derived from PDF-to-DOCX conversion.",
        )
        
        return result
    except Exception as e:
        logger.error(f"Failed to analyze PDF via DOCX conversion: {e}")
        return {
            "template_type": "pdf",
            "detected_fields": [],
            "fields": [],
            "field_mapping": {},
            "warning": f"Conversion failed: {e}",
        }
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def _analyze_docx_template(template_path: str) -> Dict[str, Any]:
    doc = DocxTemplate(template_path)
    # docxtpl exposes undeclared variables found in the template.
    try:
        variables = list(doc.get_undeclared_template_variables())
    except Exception:
        variables = []

    # Check which variables have canonical matches or alias matches.
    all_canonical = set(_CONTEXT_KEYS) | {"first_name", "last_name", "last_update"}
    all_aliases = set(DOCX_ALIASES.keys())

    fields = []
    mapping: Dict[str, str] = {}
    for var in variables:
        lower_var = var.lower()
        if lower_var in all_canonical or var in all_canonical:
            fields.append({"name": var, "mapped_to": lower_var, "source": "exact"})
            mapping[var] = lower_var
        elif lower_var in DOCX_ALIASES:
            canonical = DOCX_ALIASES[lower_var]
            fields.append({"name": var, "mapped_to": canonical, "source": "alias"})
            mapping[var] = canonical
        else:
            fields.append({"name": var, "mapped_to": None, "source": "unmatched"})
            mapping[var] = "NONE"

    return {
        "template_type": "docx",
        "detected_fields": variables,
        "fields": fields,
        "field_mapping": mapping,
        "unmapped_count": sum(1 for f in fields if f["mapped_to"] is None),
        "total_count": len(fields),
    }
