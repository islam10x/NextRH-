import os
import json
from typing import Any, Dict, List, Optional, Union
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
        '  "languages": [""]\n'
        "}\n"
        "Rules:\n"
        "- Do not invent data.\n"
        "- Keep company and institution names unchanged.\n"
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
        max_tokens=2200,
        disable_streaming=True,
    )

    parsed = parse_json_object(raw)
    if not isinstance(parsed, dict):
        return {}
    return parsed


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

            # ── Step 2: Local LLM enrichment (best-effort) ─────────────
            if filename.lower().endswith((".docx", ".pdf")):
                try:
                    if filename.lower().endswith(".pdf"):
                        raw_text = self.pdf_parser.parse(temp_path)
                    else:
                        raw_text = self.docx_parser.parse(temp_path)

                    local_parsed = _local_resume_enrichment(raw_text)
                    if local_parsed:
                        logger.info(
                            "Local enrichment raw response:\n%s",
                            json.dumps(local_parsed, ensure_ascii=False, indent=2)[:2000],
                        )
                        structured_data = _merge_apilayer(structured_data, local_parsed)
                    else:
                        logger.warning("Local enrichment returned empty result — using parser-only result")
                except Exception as exc:
                    logger.warning(f"Local enrichment failed ({exc}) — using parser-only result")

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

