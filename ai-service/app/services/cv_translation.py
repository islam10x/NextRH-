"""
CV Translation Service (Groq-powered)
======================================
Uses the Groq LLM to:

    1. Translate employee-data text fields in a single batch call before rendering.
    2. Post-process the generated DOCX to translate section headings that are
         hardcoded in the template (e.g. "Experience", "Compétences").

Translation rules
    TRANSLATE:  summary · experience descriptions · project descriptions
                            · section headings / labels found in the DOCX
    NEVER:      names · email · phone · company names · skills · certifications
                            · job titles · dates · structured identifiers
"""

import json
import logging
import os
import re
import shutil
import zipfile
from copy import deepcopy
from typing import Any, Dict, List, Optional, Tuple

from app.config import settings

logger = logging.getLogger("ai_service.translation")

SUPPORTED_LANGUAGES = {"en", "fr"}

_LANG_NAMES: Dict[str, str] = {
    "en": "English",
    "fr": "French",
}

_PROTECTED_FIELD_NAMES = {
    "name",
    "firstname",
    "lastname",
    "email",
    "phone",
    "linkedin",
    "company",
    "companyname",
    "institution",
    "school",
    "client",
    "dates",
    "startdate",
    "enddate",
    "iscurrent",
    "photo",
}

_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_XML_NS = "http://www.w3.org/XML/1998/namespace"

# Patterns that disqualify a short paragraph from being a heading
_NON_HEADING_RE = re.compile(
    r"@|https?://|linkedin\.com|"      # contact / URL
    r"\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|"  # dates dd/mm/yyyy
    r"^\+?\d[\d\s\-\(\)\.]{5,}$",     # phone numbers
    re.IGNORECASE,
)


def _is_protected_field(field_name: Optional[str]) -> bool:
    if not field_name:
        return False
    normalized = field_name.strip().lower()
    return normalized in _PROTECTED_FIELD_NAMES or normalized.endswith("date")


def _has_translatable_content(data: Dict[str, Any]) -> bool:
    scalar_fields = (
        "title",
        "summary",
        "address",
    )
    for field in scalar_fields:
        if str(data.get(field) or "").strip():
            return True

    for field in ("skills", "languages", "certifications"):
        if any(str(item or "").strip() for item in (data.get(field) or [])):
            return True

    for entry in data.get("experience") or []:
        if not isinstance(entry, dict):
            continue
        for field in ("title", "role", "description"):
            if str(entry.get(field) or "").strip():
                return True

    for entry in data.get("education") or []:
        if not isinstance(entry, dict):
            continue
        for field in ("degree", "description", "fieldOfStudy"):
            if str(entry.get(field) or "").strip():
                return True

    for entry in data.get("projects") or []:
        if not isinstance(entry, dict):
            continue
        for field in ("name", "role", "description"):
            if str(entry.get(field) or "").strip():
                return True

    return False


def _merge_translated_value(original: Any, translated: Any, field_name: Optional[str] = None) -> Any:
    if _is_protected_field(field_name):
        return deepcopy(original)

    if isinstance(original, dict):
        translated_dict = translated if isinstance(translated, dict) else {}
        merged: Dict[str, Any] = {}
        for key, value in original.items():
            merged[key] = _merge_translated_value(value, translated_dict.get(key), key)
        return merged

    if isinstance(original, list):
        translated_list = translated if isinstance(translated, list) else []
        merged_list: List[Any] = []
        for index, value in enumerate(original):
            next_translated = translated_list[index] if index < len(translated_list) else None
            merged_list.append(_merge_translated_value(value, next_translated, field_name))
        return merged_list

    if original is None:
        return None

    if isinstance(original, str):
        if not original.strip():
            return original
        if isinstance(translated, str) and translated.strip():
            return translated.strip()
        return original

    if translated is None:
        return deepcopy(original)

    if isinstance(translated, type(original)):
        return deepcopy(translated)

    return deepcopy(original)


def _merge_translated_cv_data(source: Dict[str, Any], translated: Dict[str, Any]) -> Dict[str, Any]:
    return _merge_translated_value(source, translated)


# ─── Groq helpers ────────────────────────────────────────────────────────────

def _groq_client():
    from groq import Groq
    # 4× the per-request timeout: translation batches can be large
    return Groq(api_key=settings.GROQ_API_KEY, timeout=settings.GROQ_TIMEOUT_SECONDS * 4)


def _extract_json(raw: str) -> Dict[str, str]:
    """Extract the first JSON object from an LLM response.

    Handles:
    - markdown code fences (```json … ```)
    - leading/trailing prose
    - trailing commas before } or ]
    """
    # Strip code fences
    raw = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.MULTILINE)
    raw = re.sub(r"\s*```$", "", raw, flags=re.MULTILINE)
    # Find the outermost { … } block
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start == -1 or end == 0:
        raise ValueError("No JSON object found in response")
    candidate = raw[start:end]
    # Remove trailing commas (common LLM mistake)
    candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
    return json.loads(candidate)


def _translate_batch(texts: List[str], target_lang: str, context: str) -> List[str]:
    """Translate a list of strings via a single Groq call.

    Falls back to per-item translation when the batch JSON cannot be parsed.
    Returns original texts on complete failure.
    """
    if not texts:
        return texts

    lang_name = _LANG_NAMES.get(target_lang, target_lang)
    input_map = {str(i): t for i, t in enumerate(texts)}

    prompt = (
        f"You are a professional CV translator. Translate each JSON value to {lang_name}.\n"
        f"Context: {context}\n\n"
        "ALWAYS translate:\n"
        "  • Job titles, position names, role descriptions (e.g. 'Administrateur' → 'Administrator', "
        "'Chef de projet' → 'Project Manager', 'Ingénieur' → 'Engineer')\n"
        "  • Degree / diploma names, field-of-study descriptions\n"
        "  • Summaries, descriptions, skill labels\n\n"
        "LEAVE UNCHANGED:\n"
        "  • Company names, brand names, institution names\n"
        "  • Technical terms: programming languages, frameworks, tool names, acronyms\n"
        "  • Contact data: emails, phone numbers, URLs\n"
        "  • Date strings and numeric values\n"
        "  • Personal names\n"
        "\nPreserve newlines inside strings.\n"
        "Return ONLY a valid JSON object with the exact same integer keys. "
        "No markdown fences, no extra text, no trailing commas.\n\n"
        + json.dumps(input_map, ensure_ascii=False)
    )

    try:
        client = _groq_client()
        resp = client.chat.completions.create(
            model=settings.GROQ_CV_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.05,
            max_tokens=4096,
        )
        raw = resp.choices[0].message.content or ""
        result_map = _extract_json(raw)
        out = [str(result_map.get(str(i), texts[i])) for i in range(len(texts))]
        logger.info("Groq batch translated %d item(s) → %s", len(texts), target_lang)
        return out
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Groq batch JSON parse failed (%s) — falling back to per-item.", exc)
        return _translate_items_individually(texts, target_lang, lang_name)
    except Exception as exc:
        logger.warning("Groq batch call failed (%s) — using originals.", exc)
        return texts


def _translate_items_individually(
    texts: List[str], target_lang: str, lang_name: str
) -> List[str]:
    """Per-item fallback: one Groq call per text.  Used when batch JSON fails."""
    results: List[str] = list(texts)
    try:
        client = _groq_client()
    except Exception as exc:
        logger.warning("Groq client init failed in per-item fallback (%s).", exc)
        return results

    for i, text in enumerate(texts):
        if not text or not text.strip():
            continue
        prompt = (
            f"Translate the following professional CV text to {lang_name}.\n"
            "Do NOT translate proper names, company names, technical tools, "
            "emails, URLs, or dates. Return ONLY the translated text.\n\n"
            f"{text}"
        )
        try:
            resp = client.chat.completions.create(
                model=settings.GROQ_CV_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.05,
                max_tokens=1024,
            )
            results[i] = (resp.choices[0].message.content or text).strip()
        except Exception as exc:
            logger.warning("Per-item translation %d failed (%s) — keeping original.", i, exc)
    return results


# ─── DOCX heading post-processor ─────────────────────────────────────────────

def _collect_short_paragraphs(root) -> List[Tuple[str, str]]:
    """Return (normalized_key, original_text) for every short paragraph
    in the document that could be a section heading.

    Candidates:
      - text length ≤ 60 chars
      - no contact/URL/phone/date patterns
      - not a bare single digit or punctuation
    Duplicates (same normalized key) are returned only once.
    """
    seen: Dict[str, str] = {}
    for para in root.iter(f"{{{_W}}}p"):
        full_text = "".join(
            (t.text or "") for t in para.iter(f"{{{_W}}}t")
        ).strip()
        if not full_text or len(full_text) > 60:
            continue
        if _NON_HEADING_RE.search(full_text):
            continue
        # Skip bare punctuation or single chars
        if re.match(r"^[\W\d]{1,2}$", full_text):
            continue
        key = full_text.lower()
        if key not in seen:
            seen[key] = full_text
    return list(seen.items())  # [(norm_key, original_text)]


def translate_docx_headings(docx_path: str, target_lang: str) -> None:
    """Post-process the generated DOCX in-place.

    Extracts all short paragraphs, sends them to Groq with instructions to
    translate only the ones that are section labels/headings (the LLM decides),
    and applies replacements back to every matching paragraph in the document
    (including textbox copies).

    Works regardless of the template's source language (EN, FR, or any other).
    Any error is silently caught — CV generation is never interrupted.
    """
    if target_lang not in SUPPORTED_LANGUAGES:
        return

    lang_name = _LANG_NAMES.get(target_lang, target_lang)

    try:
        from lxml import etree

        with zipfile.ZipFile(docx_path, "r") as zf:
            doc_xml = zf.read("word/document.xml")

        root = etree.fromstring(doc_xml)

        candidates = _collect_short_paragraphs(root)
        if not candidates:
            logger.debug("No heading candidates found in DOCX.")
            return

        # Build input for Groq: ask it to translate ONLY section headings
        orig_texts = [orig for _, orig in candidates]
        input_map = {str(i): t for i, t in enumerate(orig_texts)}

        prompt = (
            f"You are translating a CV document to {lang_name}.\n"
            "Below is a JSON map of short text fragments extracted from the document.\n"
            "For each fragment:\n"
            f"  - If it is a CV section label or heading (e.g. Experience, Education, Skills, "
            f"Profile, Languages, Certifications, Projects, Contact, Summary, Interests, etc.), "
            f"translate it to {lang_name}.\n"
            "  - If it is NOT a section label (e.g. a person's name, a job title, a company name, "
            "a city, a date, a technology name, or any other non-label text), return it UNCHANGED.\n\n"
            "Return ONLY a valid JSON object with the exact same integer keys. "
            "No markdown fences, no extra text, no trailing commas.\n\n"
            + json.dumps(input_map, ensure_ascii=False)
        )

        try:
            client = _groq_client()
            resp = client.chat.completions.create(
                model=settings.GROQ_CV_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=2048,
            )
            raw = resp.choices[0].message.content or ""
            result_map = _extract_json(raw)
        except (json.JSONDecodeError, ValueError) as exc:
            logger.warning("Heading translation JSON parse failed (%s).", exc)
            return
        except Exception as exc:
            logger.warning("Heading translation Groq call failed (%s).", exc)
            return

        # Build replacement dict: original_text → translated (only where changed)
        replacement_map: Dict[str, str] = {}
        for i, (_, orig) in enumerate(candidates):
            translated = str(result_map.get(str(i), orig)).strip()
            if translated and translated.lower() != orig.lower():
                replacement_map[orig] = translated
                logger.debug("Heading: %r → %r", orig, translated)

        if not replacement_map:
            logger.debug("Groq produced no heading changes.")
            return

        # Apply to ALL matching paragraphs (including textbox copies)
        replaced = 0
        for para in root.iter(f"{{{_W}}}p"):
            full_text = "".join(
                (t.text or "") for t in para.iter(f"{{{_W}}}t")
            ).strip()
            if full_text not in replacement_map:
                continue

            new_text = replacement_map[full_text]
            runs = list(para.iter(f"{{{_W}}}r"))
            if not runs:
                continue

            first_t = runs[0].find(f"{{{_W}}}t")
            if first_t is not None:
                first_t.text = new_text
                first_t.set(f"{{{_XML_NS}}}space", "preserve")
            for run in runs[1:]:
                t_el = run.find(f"{{{_W}}}t")
                if t_el is not None:
                    t_el.text = ""
            replaced += 1

        if replaced == 0:
            return

        new_xml = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
        tmp = docx_path + ".hdg_tmp"
        try:
            with zipfile.ZipFile(docx_path, "r") as zin, \
                 zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    zout.writestr(
                        item,
                        new_xml if item.filename == "word/document.xml"
                        else zin.read(item.filename),
                    )
            shutil.move(tmp, docx_path)
            logger.info("Translated %d section heading(s) to %s.", replaced, target_lang)
        except Exception:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise

    except Exception as exc:
        logger.warning("DOCX heading translation failed (non-fatal): %s", exc)


# ─── Public API ───────────────────────────────────────────────────────────────

def translate_cv_data(employee_data: Dict[str, Any], target_lang: str) -> Dict[str, Any]:
    """Return a copy of *employee_data* with ALL human-readable text fields translated.

    Translates every text field that a reader will see in the final CV:
      - title (current position)
      - summary
      - address (city / country label — not a raw identifier)
      - skills list
      - experience: job title, description
      - education: degree
      - certifications list
      - projects: name, role, description

    NOT translated (identifiers / contact / dates / proper nouns):
      name, email, phone, company names, institution names,
      client names, dates, URLs, technical tool names (Python, Docker, …).

    Empty fields are NEVER fabricated — if a value is absent or blank in
    the source data it stays absent/blank in the output.

    All fields are collected into a single batch and translated in one Groq
    call.  Falls back to per-item translation when batch JSON fails, and falls
    back to originals on complete Groq failure.
    """
    if not target_lang or target_lang not in SUPPORTED_LANGUAGES:
        return employee_data

    data: Dict[str, Any] = dict(employee_data)

    # ── Index of each translatable field ─────────────────────────────────────
    texts: List[str] = []

    # ── Top-level fields ─────────────────────────────────────────────────────
    title_idx: Optional[int] = None
    if (data.get("title") or "").strip():
        title_idx = len(texts)
        texts.append(data["title"].strip())

    summary_idx: Optional[int] = None
    if (data.get("summary") or "").strip():
        summary_idx = len(texts)
        texts.append(data["summary"].strip())

    address_idx: Optional[int] = None
    if (data.get("address") or "").strip():
        address_idx = len(texts)
        texts.append(data["address"].strip())

    # ── Skills ───────────────────────────────────────────────────────────────
    # Technical tool names (Python, React, Docker…) will be kept by the LLM.
    # Human-readable soft skills ("Communication", "Leadership") will be translated.
    skills_orig: List[str] = [str(s) for s in (data.get("skills") or []) if s]
    skills_indices: List[int] = []
    for skill in skills_orig:
        skills_indices.append(len(texts))
        texts.append(skill)

    # ── Experience ───────────────────────────────────────────────────────────
    experience = [dict(e) for e in (data.get("experience") or [])]
    exp_title_map: List[Tuple[int, int]] = []   # (exp_i, text_i)
    exp_role_map:  List[Tuple[int, int]] = []
    exp_desc_map:  List[Tuple[int, int]] = []
    for i, exp in enumerate(experience):
        if exp.get("title"):
            exp_title_map.append((i, len(texts)))
            texts.append(str(exp["title"]))
        if exp.get("role"):
            exp_role_map.append((i, len(texts)))
            texts.append(str(exp["role"]))
        if exp.get("description"):
            exp_desc_map.append((i, len(texts)))
            texts.append(str(exp["description"]))

    # ── Education ────────────────────────────────────────────────────────────
    education = [dict(e) for e in (data.get("education") or [])]
    edu_degree_map: List[Tuple[int, int]] = []
    for i, edu in enumerate(education):
        if edu.get("degree"):
            edu_degree_map.append((i, len(texts)))
            texts.append(str(edu["degree"]))

    # ── Certifications ───────────────────────────────────────────────────────
    # Cert names: branded ones (AWS, PMP, CISSP) are kept by the LLM.
    certs_orig: List[str] = [str(c) for c in (data.get("certifications") or []) if c]
    cert_indices: List[int] = []
    for cert in certs_orig:
        cert_indices.append(len(texts))
        texts.append(cert)

    # ── Projects ─────────────────────────────────────────────────────────────
    projects = [dict(p) for p in (data.get("projects") or [])]
    proj_name_map: List[Tuple[int, int]] = []
    proj_role_map: List[Tuple[int, int]] = []
    proj_desc_map: List[Tuple[int, int]] = []
    for i, proj in enumerate(projects):
        if proj.get("name"):
            proj_name_map.append((i, len(texts)))
            texts.append(str(proj["name"]))
        if proj.get("role"):
            proj_role_map.append((i, len(texts)))
            texts.append(str(proj["role"]))
        if proj.get("description"):
            proj_desc_map.append((i, len(texts)))
            texts.append(str(proj["description"]))

    if not texts:
        return data

    # ── Single batch call ─────────────────────────────────────────────────────
    translated = _translate_batch(
        texts,
        target_lang,
        context=(
            "professional CV content — job titles, degree names, skill names, "
            "project names, roles, summaries, and descriptions"
        ),
    )

    # ── Write back ────────────────────────────────────────────────────────────

    if address_idx is not None:
        data["address"] = translated[address_idx]

    if title_idx is not None:
        data["title"] = translated[title_idx]
    if summary_idx is not None:
        data["summary"] = translated[summary_idx]

    if skills_indices:
        data["skills"] = [translated[i] for i in skills_indices]

    if exp_title_map or exp_role_map or exp_desc_map:
        for exp_i, txt_i in exp_title_map:
            experience[exp_i]["title"] = translated[txt_i]
        for exp_i, txt_i in exp_role_map:
            experience[exp_i]["role"] = translated[txt_i]
        for exp_i, txt_i in exp_desc_map:
            experience[exp_i]["description"] = translated[txt_i]
        data["experience"] = experience

    if edu_degree_map:
        for edu_i, txt_i in edu_degree_map:
            education[edu_i]["degree"] = translated[txt_i]
        data["education"] = education

    if cert_indices:
        data["certifications"] = [translated[i] for i in cert_indices]

    if proj_name_map or proj_role_map or proj_desc_map:
        for proj_i, txt_i in proj_name_map:
            projects[proj_i]["name"] = translated[txt_i]
        for proj_i, txt_i in proj_role_map:
            projects[proj_i]["role"] = translated[txt_i]
        for proj_i, txt_i in proj_desc_map:
            projects[proj_i]["description"] = translated[txt_i]
        data["projects"] = projects

    return data


# ─── Semantic multilingual CV translation ────────────────────────────────────

_LANG_RULES: Dict[str, str] = {
    "en": (
        "Use formal professional British/American English. "
        "Translate ALL human-readable fields into English, even if the input is already partially in English — "
        "because the template source language may be French or any other language. "
        "Translate the address field (city/country label). "
        "Keep technical terms (Python, Django, SQL, Docker, React, etc.) and proper nouns unchanged. "
        "NEVER invent content for empty or missing fields — leave them as empty strings."
    ),
    "fr": (
        "Use formal professional French. "
        "Translate all human-readable fields including the address field (city/country label). "
        "Keep technical terms (Python, Django, SQL, Docker, React, etc.) and proper nouns unchanged. "
        "NEVER invent content for empty or missing fields — leave them as empty strings."
    ),
}

_SEMANTIC_SYSTEM_PROMPT = """\
You are a professional multilingual CV translation engine.
Your job:
  1. UNDERSTAND the meaning of each field semantically, regardless of the input language.
  2. OUTPUT the same JSON structure with every human-readable value translated into the
     requested target language.

NEVER translate or modify:
  - Company / institution names
  - Email addresses, phone numbers, URLs
  - Technical terms: programming languages, frameworks, libraries, tool names, acronyms
    (Python, Django, SQL, Docker, React, AWS, Git, etc.)
  - Dates and numeric values
  - Any field whose value is null, empty string, or missing — leave it exactly as-is
    - Personal names ("name" field)

DO translate:
  - title (job title / position)
  - summary
  - address (city / country label)
        - certifications labels when they are descriptive text; keep certification acronyms and brand names unchanged
        - language names (English, French, etc.)
  - experience[].role  and  experience[].description
    - experience[].title when it contains the job title shown to the reader
  - education[].degree  and  education[].description
    - education[].fieldOfStudy
  - skills  (soft skills only; technical tool names stay)
    - projects[].name, projects[].role, projects[].description

CRITICAL: Do NOT invent or fill in missing data. If a field is empty or absent in the
input, output it as empty string or omit it. Never fabricate addresses, summaries,
descriptions, or any other content.

Return ONLY a valid JSON object with exactly the same keys as the input cv_data.
No markdown fences, no explanations, no extra text, no trailing commas.
"""


def translate_cv_structured(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Semantic multilingual CV translation via a single Groq call.

    Accepts the structured payload::

        {
            "target_language": "en" | "fr",
            "cv_data": {
                "name": str,
                "title": str,
                "summary": str,
                "experience": [{"role": str, "company": str, "description": str}],
                "education":  [{"degree": str, "school": str, "description": str}],
                "skills": [str]
            }
        }

    Behaviour
    ---------
    * Input can be written in **any** language — the LLM performs semantic
      understanding first, then produces clean professional output in
      *target_language*.
    * Uses a **single** Groq call for the whole CV (fast & coherent).
    * Falls back to the raw ``cv_data`` on any Groq failure so the caller
      always receives a usable result.

    Returns
    -------
    The ``cv_data`` dict with all translatable fields replaced by their
    *target_language* equivalents.  The ``name``, ``company``, ``school``
    fields and all technical keywords are left unchanged.
    """
    target_lang = str(payload.get("target_language") or "en").strip().lower()
    cv_data: Dict[str, Any] = dict(payload.get("cv_data") or {})

    if not cv_data:
        raise ValueError("'cv_data' is required and must be a non-empty object.")

    if target_lang not in SUPPORTED_LANGUAGES:
        raise ValueError(
            f"Unsupported target_language '{target_lang}'. "
            f"Supported values: {sorted(SUPPORTED_LANGUAGES)}"
        )

    lang_name = _LANG_NAMES.get(target_lang, target_lang)
    lang_rules = _LANG_RULES.get(target_lang, f"Use formal professional {lang_name}.")

    user_prompt = (
        f"Target language: {lang_name}\n"
        f"Language rules: {lang_rules}\n\n"
        "Translate the following CV JSON into the target language following all rules above.\n"
        "Return ONLY the translated JSON object — same structure, no extra text.\n\n"
        + json.dumps(cv_data, ensure_ascii=False)
    )

    try:
        client = _groq_client()
        resp = client.chat.completions.create(
            model=settings.GROQ_CV_MODEL,
            messages=[
                {"role": "system", "content": _SEMANTIC_SYSTEM_PROMPT},
                {"role": "user",   "content": user_prompt},
            ],
            temperature=0.05,
            max_tokens=4096,
        )
        raw = resp.choices[0].message.content or ""
        translated_data = _extract_json(raw)
        translated_data = _merge_translated_cv_data(cv_data, translated_data)

        logger.info(
            "translate_cv_structured: translated CV to %s (%d experience, %d education, %d skills).",
            target_lang,
            len(translated_data.get("experience") or []),
            len(translated_data.get("education") or []),
            len(translated_data.get("skills") or []),
        )
        return translated_data

    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning(
            "translate_cv_structured: JSON parse error (%s) — returning original cv_data.", exc
        )
        return cv_data
    except Exception as exc:
        logger.warning(
            "translate_cv_structured: Groq call failed (%s) — returning original cv_data.", exc
        )
        return cv_data


def translate_cv_best_effort(cv_data: Dict[str, Any], target_lang: str) -> Dict[str, Any]:
    """Translate a CV with the strongest available path while preserving structure.

    Strategy:
      1. Try the semantic whole-document translator for coherence.
      2. If it makes no changes, fall back to the field-batch translator to avoid
         returning an untranslated CV on partial Groq failures.
      3. Always preserve the original CV structure and protected identifiers.
    """
    if not target_lang or target_lang not in SUPPORTED_LANGUAGES:
        return cv_data

    source = deepcopy(cv_data)
    semantic = translate_cv_structured({
        "target_language": target_lang,
        "cv_data": source,
    })
    semantic = _merge_translated_cv_data(source, semantic)

    if semantic != source:
        return semantic

    if not _has_translatable_content(source):
        return semantic

    logger.info(
        "translate_cv_best_effort: semantic translation produced no changes for %s; trying field fallback.",
        target_lang,
    )
    fallback = translate_cv_data(deepcopy(source), target_lang)
    return _merge_translated_cv_data(source, fallback)
