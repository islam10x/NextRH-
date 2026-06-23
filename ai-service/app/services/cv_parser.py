import os
import re
import json
from typing import Any, Dict, List, Optional, Tuple, Union
from app.parsers.pdf_parser import PDFParser
from app.parsers.docx_parser import DocxParser
from app.parsers.template_parser import TemplateCVParser
from app.config import settings
from app.utils.llm import call_local_chat, parse_json_object
from app.utils.logger import logger
from fastapi import UploadFile


def _merge_apilayer(base: Dict[str, Any], api: Dict[str, Any]) -> Dict[str, Any]:
    """
    Merge APILayer parsed data into the base TemplateCVParser result.

    Strategy: base (deterministic regex parser) takes priority for fields it
    already found. APILayer fills only MISSING or EMPTY fields.
    This way the existing parser keeps its quality while APILayer enriches gaps.
    """

    def _val(v: Any) -> bool:
        """True if value is non-empty."""
        if v is None:
            return False
        if isinstance(v, (list, dict)):
            return len(v) > 0
        return bool(str(v).strip())

    def _clean(v: Any) -> str:
        s = str(v or "").strip()
        return "" if s in ("-", "N/A", "n/a", "none", "None", "null") else s

    merged = dict(base)

    # ── Scalar personal fields ────────────────────────────────────────
    _SCALAR_FIELDS = {
        "email":      lambda a: _clean(a.get("email")),
        "phone":      lambda a: _clean(a.get("phone")),
        "address":    lambda a: (
            _clean(a.get("address"))
            or ", ".join(
                filter(None, [
                    _clean(a.get("city")),
                    _clean(a.get("state")),
                    _clean(a.get("country")),
                ])
            )
        ),
        "linkedin":   lambda a: next(
            (
                lnk if isinstance(lnk, str) else _clean(lnk.get("url", ""))
                for lnk in (a.get("social_links") or [])
                if "linkedin" in str(lnk).lower()
            ),
            _clean(a.get("linkedin")),
        ),
    }
    for field, extractor in _SCALAR_FIELDS.items():
        if not _val(merged.get(field)):
            val = extractor(api)
            if val:
                merged[field] = val
                logger.info(f"[APILayer enrichment] {field}: {val}")

    # ── Name: APILayer returns a single 'name' string ────────────────
    if not _val(merged.get("first_name")) and not _val(merged.get("last_name")):
        full = _clean(api.get("name"))
        if full:
            parts = full.split()
            merged["first_name"] = parts[0] if parts else ""
            merged["last_name"] = " ".join(parts[1:]) if len(parts) > 1 else ""
            logger.info(f"[APILayer enrichment] name: {full}")

    # ── Summary / objective ───────────────────────────────────────────
    if not _val(merged.get("summary")):
        summary = (
            _clean(api.get("objective"))
            or _clean(api.get("summary"))
            or _clean(api.get("professional_summary"))
        )
        if summary:
            merged["summary"] = summary
            logger.info(f"[APILayer enrichment] summary: {summary[:80]}...")

    # ── Skills: append any new ones APILayer found ────────────────────
    base_skills: List[str] = [str(s).lower() for s in (merged.get("skills") or [])]
    for skill in (api.get("skills") or []):
        s = _clean(skill)
        if s and s.lower() not in base_skills:
            merged.setdefault("skills", []).append(s)
            base_skills.append(s.lower())

    # ── Experience: use APILayer list if base found nothing ───────────
    if not _val(merged.get("experience")):
        api_exp = api.get("experience") or []
        if api_exp:
            merged["experience"] = [
                {
                    "title":       _clean(e.get("title") or e.get("position") or e.get("job_title", "")),
                    "company":     _clean(e.get("company") or e.get("organization") or e.get("employer", "")),
                    "start_date":  _clean(e.get("date_start") or e.get("start_date", "")),
                    "end_date":    _clean(e.get("date_end") or e.get("end_date", "")),
                    "description": _clean(e.get("description", "")),
                }
                for e in api_exp
                if _clean(e.get("title") or e.get("position", ""))
                or _clean(e.get("company") or e.get("organization", ""))
            ]
            logger.info(f"[APILayer enrichment] experience: {len(merged['experience'])} entries")

    # ── Education: use APILayer list if base found nothing ───────────
    if not _val(merged.get("education")):
        api_edu = api.get("education") or []
        if api_edu:
            merged["education"] = [
                {
                    "degree":      _clean(e.get("degree") or e.get("name") or e.get("qualification", "")),
                    "institution": _clean(e.get("institution") or e.get("school") or e.get("university", "")),
                    "end_date":    _clean(e.get("graduation_date") or e.get("end_date", "")),
                }
                for e in api_edu
                if _clean(e.get("degree") or e.get("name", ""))
                or _clean(e.get("institution") or e.get("school", ""))
            ]
            logger.info(f"[APILayer enrichment] education: {len(merged['education'])} entries")

    # ── Languages: use APILayer list if base found nothing ───────────
    if not _val(merged.get("languages")):
        api_langs = api.get("languages") or []
        if api_langs:
            merged["languages"] = [
                v for v in (
                    _clean(l) if isinstance(l, str) else _clean(l.get("name", ""))
                    for l in api_langs
                )
                if v
            ]
            if merged["languages"]:
                logger.info(f"[APILayer enrichment] languages: {merged['languages']}")

    return merged


def _local_resume_enrichment(raw_text: str) -> Dict[str, Any]:
    """Best-effort local enrichment that mimics APILayer's response shape."""
    text = (raw_text or "").strip()
    if not text:
        return {}

    excerpt = text[:12000]
    prompt = (
        "Extract CV data from the text and return ONLY a valid JSON object.\n"
        "Use this schema (leave unknown fields as empty strings/null/[]):\n"
        "{\n"
        '  "name": "", "email": "", "phone": "", "address": "",\n'
        '  "city": "", "state": "", "country": "", "linkedin": "",\n'
        '  "social_links": [{"url": ""}],\n'
        '  "objective": "", "summary": "", "professional_summary": "",\n'
        '  "skills": [""],\n'
        '  "experience": [{"title": "", "position": "", "company": "", "organization": "", '
        '"date_start": "", "date_end": "", "description": ""}],\n'
        '  "education": [{"degree": "", "name": "", "institution": "", "school": "", "graduation_date": ""}],\n'
        '  "certifications": [{"name": "", "date_obtained": ""}],\n'
        '  "projects": [{"name": "", "client": "", "date": "", "description": ""}],\n'
        '  "languages": [""]\n'
        "}\n"
        "Rules:\n"
        "- Do not invent data.\n"
        "- Keep company, institution and certification names unchanged.\n"
        "- Each certification must be a SEPARATE list entry (never glue several into one name).\n"
        "- Return JSON only, no markdown.\n\n"
        f"CV text:\n{excerpt}"
    )

    preferred_model = (
        str(settings.LOCAL_CV_MODEL or "").strip()
        or str(settings.TRANSLATION_MODEL or "").strip()
        or str(settings.GROQ_CV_MODEL or "").strip()
    )
    raw = call_local_chat(
        messages=[{"role": "user", "content": prompt}],
        model=preferred_model or None,
        temperature=0.0,
        timeout=settings.GROQ_TIMEOUT_SECONDS * 2,
        max_tokens=3000,
        disable_streaming=True,
    )

    parsed = parse_json_object(raw)
    if not isinstance(parsed, dict):
        return {}
    return parsed


def _despace_letters(value: str) -> str:
    """Collapse decorative letter-spacing (e.g. 'H I C H E M' -> 'HICHEM').

    Some CV headers render the name with a space between every glyph. PyMuPDF
    then reads each letter as a separate token, which breaks name extraction
    (first_name becomes a single letter). Only collapses when most tokens are
    single letters, so normal names like 'Anouar ABDALLAH' are left untouched.
    """
    text = (value or "").strip()
    if not text:
        return text

    tokens = text.split()
    if len(tokens) < 4:
        return text

    single = sum(1 for t in tokens if len(t) == 1 and t.isalpha())
    if single / len(tokens) < 0.6:
        return text

    out: List[str] = []
    buf = ""
    for t in tokens:
        if len(t) == 1 and t.isalpha():
            buf += t
        else:
            if buf:
                out.append(buf)
                buf = ""
            out.append(t)
    if buf:
        out.append(buf)
    return " ".join(out)


def _sanitize_skills(skills: Any) -> List[str]:
    """Drop entries that don't look like a real skill (prose, dates, certs, bullets).

    Applied to whatever ends up in the skills field — in every path — so that even
    when the LLM is unreachable and we fall back to the deterministic parser (which
    can mis-extract skills on non-standard CVs), obvious garbage is removed. Worst
    case the field is empty; it never shows prose or certification dumps. Real short
    skills ("Cisco", "BGP", "VMware") are kept untouched.
    """
    month_re = re.compile(
        r"(?i)\b(jan(?:vier|uary)?|f[eé]v(?:rier)?|feb(?:ruary)?|mars|march|"
        r"avr(?:il)?|apr(?:il)?|mai|may|juin|june|juil(?:let)?|july|"
        r"ao[uû]t|aug(?:ust)?|sept(?:embre|ember)?|oct(?:obre|ober)?|"
        r"nov(?:embre|ember)?|d[eé]c(?:embre|ember)?)\b"
    )
    year_re = re.compile(r"\b(19|20)\d{2}\b")

    out: List[str] = []
    seen = set()
    for raw in (skills or []):
        s = re.sub(r"\s+", " ", str(raw or "")).strip()
        if not s:
            continue
        if len(s) > 50:                                  # a skill is short
            continue
        if len(s.split()) > 6:                           # a sentence, not a skill
            continue
        if month_re.search(s) or year_re.search(s):      # contains a date
            continue
        if re.match(r"(?i)^o\b", s) or s[0] in "-–—•·,:;|":  # bullet / punctuation lead
            continue
        if "etc." in s.lower():
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


def _verify_or_correct_cv(
    raw_text: str, structured_data: Dict[str, Any]
) -> Tuple[Dict[str, Any], bool]:
    """Single-call LLM (Groq) verify-or-correct of the deterministic extraction.

    Sends the raw CV text plus the deterministic parser's JSON. The LLM compares
    them field by field:
      - if the extraction is correct and complete -> returns {"valid": true} and
        we KEEP the deterministic result (fast, reproducible).
      - if anything is wrong / missing / garbled -> returns the full corrected
        extraction, which REPLACES the deterministic result.

    Returns (data, corrected). On any failure (LLM unreachable, unparseable
    output, no correction provided) the deterministic result is kept unchanged.
    """
    text = (raw_text or "").strip()
    if not text:
        return structured_data, False

    excerpt = text[:12000]
    current = json.dumps(
        {
            k: structured_data.get(k)
            for k in (
                "first_name", "last_name", "email", "phone", "address",
                "experience", "education", "certifications", "projects", "skills",
            )
        },
        ensure_ascii=False,
    )

    prompt = (
        "You verify a CV extraction produced by an automated parser.\n"
        "Compare the EXTRACTED JSON field by field against the CV TEXT.\n\n"
        "If every field is correct and complete, reply with EXACTLY:\n"
        '{"valid": true}\n\n'
        "If anything is wrong, missing, or garbled (name split incorrectly, a "
        'company that is just a bullet like "o", several certifications merged '
        "into one entry, missing experiences/education, a block of text in the "
        "wrong field), reply with:\n"
        '{"valid": false, "data": { ...full corrected extraction... }}\n\n'
        'The "data" object MUST use EXACTLY this schema:\n'
        "{\n"
        '  "first_name": "", "last_name": "", "email": "", "phone": "", "address": "",\n'
        '  "experience": [{"start_date": "", "end_date": "", "company": "", "title": "", "description": ""}],\n'
        '  "education": [{"end_date": "", "institution": "", "degree": ""}],\n'
        '  "certifications": [{"name": "", "date_obtained": ""}],\n'
        '  "projects": [{"name": "", "client": "", "date": "", "description": ""}],\n'
        '  "skills": [""]\n'
        "}\n"
        "Rules:\n"
        "- Do not invent data; use only what appears in the CV text.\n"
        "- Keep company, institution and certification names verbatim.\n"
        "- Each certification must be a SEPARATE entry.\n"
        '- "skills" = real technical skills/technologies only (e.g. "Cisco", "BGP", '
        '"VMware"). NEVER put certifications, dates, or full sentences in "skills". '
        "If the CV has no dedicated skills section, return an empty list.\n"
        "- Return JSON only, no markdown.\n\n"
        f"CV TEXT:\n{excerpt}\n\n"
        f"EXTRACTED JSON:\n{current}"
    )

    preferred_model = (
        str(settings.LOCAL_CV_MODEL or "").strip()
        or str(settings.TRANSLATION_MODEL or "").strip()
        or str(settings.GROQ_CV_MODEL or "").strip()
    )

    raw = call_local_chat(
        messages=[{"role": "user", "content": prompt}],
        model=preferred_model or None,
        temperature=0.0,
        timeout=settings.GROQ_TIMEOUT_SECONDS * 3,
        max_tokens=3000,
        disable_streaming=True,
    )

    parsed = parse_json_object(raw)
    if not isinstance(parsed, dict):
        logger.warning("Verifier returned unparseable output — keeping deterministic result")
        return structured_data, False

    # Explicitly validated: keep the deterministic extraction untouched.
    if parsed.get("valid") is True and "data" not in parsed:
        logger.info("Verifier: deterministic extraction validated — kept as is")
        return structured_data, False

    # Otherwise, expect a corrected payload (under "data", or at top level).
    corrected = parsed.get("data")
    if not isinstance(corrected, dict):
        if parsed.get("valid") is False:
            corrected = {k: v for k, v in parsed.items() if k != "valid"}
    if not isinstance(corrected, dict) or not corrected:
        logger.warning("Verifier flagged invalid but provided no usable correction — keeping deterministic result")
        return structured_data, False

    merged = _build_from_llm(corrected, structured_data, fallback_lists=False)
    merged["first_name"] = _despace_letters(merged.get("first_name", ""))
    merged["last_name"] = _despace_letters(merged.get("last_name", ""))
    logger.info("Verifier: extraction was corrected by the LLM")
    return merged, True


def _build_from_llm(
    llm: Dict[str, Any], template: Dict[str, Any], fallback_lists: bool = True
) -> Dict[str, Any]:
    """Build structured_data from LLM output (authoritative), using the template
    parser result only to fill fields the LLM left empty.

    Used for non-conforming CVs where the deterministic parser produced garbage.
    Inverts the normal priority: LLM wins, template is the fallback.

    When `fallback_lists` is False, the list fields (experience, education,
    certifications, skills) are taken from the LLM ONLY — never from the template.
    This is used by the verify-or-correct path: there the template was already
    judged wrong, so an empty LLM list means "genuinely none", and falling back
    to the template would resurrect the very garbage we are replacing.
    """

    def _clean(v: Any) -> str:
        s = str(v or "").strip()
        return "" if s.lower() in ("-", "n/a", "none", "null") else s

    result: Dict[str, Any] = {
        "first_name": "",
        "last_name": "",
        "email": "",
        "phone": "",
        "address": "",
        "experience": [],
        "certifications": [],
        "education": [],
        "projects": [],
        "skills": [],
    }

    # ── Name (accept "name" OR split first_name/last_name) ────────────
    full = _clean(llm.get("name"))
    if full:
        parts = full.split()
        result["first_name"] = parts[0]
        result["last_name"] = " ".join(parts[1:]) if len(parts) > 1 else ""
    elif _clean(llm.get("first_name")) or _clean(llm.get("last_name")):
        result["first_name"] = _clean(llm.get("first_name"))
        result["last_name"] = _clean(llm.get("last_name"))
    else:
        result["first_name"] = _clean(template.get("first_name"))
        result["last_name"] = _clean(template.get("last_name"))

    # ── Scalar personal fields ────────────────────────────────────────
    result["email"] = _clean(llm.get("email")) or _clean(template.get("email"))
    result["phone"] = _clean(llm.get("phone")) or _clean(template.get("phone"))
    result["address"] = (
        _clean(llm.get("address"))
        or ", ".join(
            filter(None, [_clean(llm.get("city")), _clean(llm.get("state")), _clean(llm.get("country"))])
        )
        or _clean(template.get("address"))
    )

    # ── Experience ────────────────────────────────────────────────────
    exp: List[Dict[str, str]] = []
    for e in (llm.get("experience") or []):
        title = _clean(e.get("title") or e.get("position"))
        company = _clean(e.get("company") or e.get("organization") or e.get("employer"))
        if not title and not company:
            continue
        exp.append({
            "start_date": _clean(e.get("date_start") or e.get("start_date")),
            "end_date": _clean(e.get("date_end") or e.get("end_date")),
            "company": company,
            "title": title,
            "description": _clean(e.get("description")),
        })
    result["experience"] = exp if (exp or not fallback_lists) else (template.get("experience") or [])

    # ── Education ─────────────────────────────────────────────────────
    edu: List[Dict[str, str]] = []
    for e in (llm.get("education") or []):
        degree = _clean(e.get("degree") or e.get("name") or e.get("qualification"))
        institution = _clean(e.get("institution") or e.get("school") or e.get("university"))
        if not degree and not institution:
            continue
        edu.append({
            "end_date": _clean(e.get("graduation_date") or e.get("end_date")),
            "institution": institution,
            "degree": degree,
        })
    result["education"] = edu if (edu or not fallback_lists) else (template.get("education") or [])

    # ── Certifications ────────────────────────────────────────────────
    certs: List[Dict[str, str]] = []
    for c in (llm.get("certifications") or []):
        if isinstance(c, str):
            name, date = _clean(c), ""
        else:
            name = _clean(c.get("name"))
            date = _clean(c.get("date_obtained") or c.get("date"))
        if name:
            certs.append({"name": name, "date_obtained": date})
    result["certifications"] = certs if (certs or not fallback_lists) else (template.get("certifications") or [])

    # ── Projects (LLM only; drop the template's 'Unknown Project' noise) ─
    projs: List[Dict[str, str]] = []
    for p in (llm.get("projects") or []):
        if isinstance(p, str):
            name, client, date, desc = "", "", "", _clean(p)
        else:
            name = _clean(p.get("name"))
            client = _clean(p.get("client"))
            date = _clean(p.get("date"))
            desc = _clean(p.get("description"))
        if name or client or desc:
            projs.append({"name": name, "client": client, "date": date, "description": desc})
    result["projects"] = projs

    # ── Skills (de-duplicated) ────────────────────────────────────────
    skills: List[str] = []
    seen = set()
    for s in (llm.get("skills") or []):
        sv = _clean(s)
        if sv and sv.lower() not in seen:
            skills.append(sv)
            seen.add(sv.lower())
    result["skills"] = skills if (skills or not fallback_lists) else (template.get("skills") or [])

    return result


class CVParserService:
    def __init__(self):
        self.pdf_parser = PDFParser()
        self.docx_parser = DocxParser()
        self.template_parser = TemplateCVParser()

    async def parse_cv(self, file: UploadFile, user_id: str) -> Dict[str, Any]:
        """
        Main entry point to parse a CV file.

        Pipeline:
          1. TemplateCVParser  — deterministic regex/layout parser (primary)
          2. Local LLM enrichment — fills fields the primary parser missed
          3. Merge: primary takes priority, local enrichment fills gaps
        """
        filename = file.filename
        content_type = file.content_type

        logger.info(f"Parsing CV: {filename} ({content_type}) for user {user_id}")

        # Save temp file
        temp_path = f"/tmp/{filename}"
        if os.name == "nt":
            temp_path = os.path.join(os.environ["TEMP"], filename)

        try:
            with open(temp_path, "wb") as buffer:
                content = await file.read()
                buffer.write(content)

            # ── Step 1: Deterministic template parser ─────────────────
            structured_data = self.template_parser.parse(temp_path)

            # Collapse decorative letter-spacing in the header name.
            structured_data["first_name"] = _despace_letters(structured_data.get("first_name", ""))
            structured_data["last_name"] = _despace_letters(structured_data.get("last_name", ""))

            # ── Step 2: LLM verify-or-correct (single Groq call) ──────
            # The deterministic result is validated field-by-field against the CV.
            # If correct, it is kept (reproducible). If not, the LLM returns a
            # corrected extraction that replaces it.
            if filename.lower().endswith((".docx", ".pdf")):
                try:
                    if filename.lower().endswith(".pdf"):
                        raw_text = self.pdf_parser.parse(temp_path)
                    else:
                        raw_text = self.docx_parser.parse(temp_path)

                    structured_data, corrected = _verify_or_correct_cv(raw_text, structured_data)
                    logger.info("CV verification complete (corrected=%s)", corrected)
                except Exception as exc:
                    logger.warning(f"CV verification failed ({exc}) — keeping deterministic result")

            # Final safety net: drop non-skill-looking entries regardless of the
            # path taken above (covers the LLM-unreachable fallback on non-standard CVs).
            structured_data["skills"] = _sanitize_skills(structured_data.get("skills"))

            # ── Step 3: Metadata ──────────────────────────────────────
            metadata = {}
            if filename.lower().endswith(".pdf"):
                metadata = self.pdf_parser.extract_metadata(temp_path)
            elif filename.lower().endswith(".docx"):
                metadata = self.docx_parser.extract_metadata(temp_path)

            return {
                "structured_data": structured_data,
                "metadata": metadata,
                "filename": filename,
            }

        except Exception as e:
            logger.error(f"Error parsing CV {filename}: {str(e)}")
            raise e
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

