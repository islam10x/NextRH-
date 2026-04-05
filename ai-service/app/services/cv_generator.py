import asyncio
import logging
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from docxtpl import DocxTemplate
from pypdf import PdfReader, PdfWriter
from pypdf.generic import BooleanObject

from app.services.translation_service import translate_json_payload

logger = logging.getLogger(__name__)

_SOFFICE_SEMAPHORE = asyncio.Semaphore(1)

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
    "full_name", "email", "phone", "address", "current_position",
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
    projects = list(profile.get("projects") or [])
    for p in projects:
        # User requested fallback: generated title -> actual project name -> role -> placeholder
        p["displayTitle"] = p.get("generatedTitle") or p.get("name") or p.get("role") or "Unknown Project"

    work_experiences = list(profile.get("workExperiences") or [])

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
            existing_desc = str(target_exp.get("description") or "").strip()
            if existing_desc:
                target_exp["description"] = f"{existing_desc}\n\n{projects_block}"
            else:
                target_exp["description"] = projects_block
            existing_lines = []
            if isinstance(target_exp.get("description_lines"), list):
                existing_lines = [str(v) for v in target_exp.get("description_lines") if str(v).strip()]
            target_exp["description_lines"] = _dedupe_preserve_order(existing_lines + project_lines)
        elif not work_experiences:
            # Create a synthetic Next Step experience entry to host projects.
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

    return {
        "full_name": profile.get("name") or "",
        "email": profile.get("email") or "",
        "phone": profile.get("phone") or "",
        "address": profile.get("address") or "",
        "current_position": profile.get("currentPosition") or "",
        "professional_summary": profile.get("professionalSummary") or "",
        "total_experience_years": profile.get("totalExperienceYears") or "",
        "skills": profile.get("skills") or [],
        "work_experiences": work_experiences,
        "educations": profile.get("educations") or [],
        "certifications": profile.get("certifications") or [],
        "projects": projects,
        "languages": profile.get("languages") or [],
        "awards": profile.get("awards") or profile.get("distinctions") or [],
        "last_update": profile.get("lastUpdate") or "",
        "open_end_label": "Present",
        "section_titles": {},
    }


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

    for alias, canonical in DOCX_ALIASES.items():
        if alias not in expanded and canonical in expanded:
            expanded[alias] = expanded[canonical]
    return expanded


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

    template_ext = Path(template_path).suffix.lower()
    
    # If the template is a PDF, we convert it to a DOCX first so DocxTemplate
    # can naturally expand Jinja tags and lists without the limitations of 
    # static AcroForm boxes.
    temp_dir = None
    if template_ext == ".pdf":
        logger.info(f"Converting PDF template to DOCX using pdf2docx: {template_path}")
        from pdf2docx import Converter
        
        temp_dir = tempfile.mkdtemp()
        converted_docx_path = os.path.join(temp_dir, "converted_template.docx")
        
        try:
            cv = Converter(template_path)
            cv.convert(converted_docx_path)
            cv.close()
            # Pretend the uploaded file was a DOCX!
            template_path = converted_docx_path
            
            if "pdf" not in output_formats:
                output_formats.append("pdf")
        except Exception as e:
            logger.error(f"Failed to convert PDF template to DOCX: {e}")
            raise RuntimeError(f"PDF to DOCX conversion failed: {str(e)}")

    # --- Auto-tag if the template has no Jinja2 tags ---
    from app.services.template_tagger import auto_tag_template
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
    prefix = filename_prefix or _safe_filename(context.get("full_name") or "cv")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    base_name = f"{prefix}_{timestamp}"

    docx_path = os.path.join(output_dir, f"{base_name}.docx")
    logger.info(f"[DEBUG] Initializing DocxTemplate with path: {template_path}")
    doc = DocxTemplate(template_path)
    # Expand context with aliases so flexible placeholder names work.
    render_context = _expand_context_with_aliases(context)
    
    # Log the exact dictionary being passed to DocxTemplate
    logger.info(f"[DEBUG] Rendering DocxTemplate with context keys: {list(render_context.keys())}")
    for k, v in render_context.items():
        if isinstance(v, list):
            logger.info(f"[DEBUG] Context List '{k}': {len(v)} items")
        else:
            logger.info(f"[DEBUG] Context Var '{k}': {str(v)[:50]}")

    logger.info("[DEBUG] Executing doc.render()...")
    doc.render(render_context)
    logger.info("[DEBUG] doc.render() finished.")
    doc.save(docx_path)

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
    cmd = [
        "soffice",
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
        return _analyze_pdf_template(template_path)

    if ext == ".docx":
        return _analyze_docx_template(template_path)

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
