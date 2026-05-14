"""
CV Generation API Endpoint
===========================
Unified endpoint supporting both primary and fallback CV generation engines.
Accepts both JSON (path-based) and multipart (file upload) workflows.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.services.cv_errors import CVGenerationError, CVTemplateError, CVValidationError
from app.services.cv_generator import (
    analyze_template,
    generate_cv_document,
    standardize_template,
)
from app.services.pdf_overlay import build_auto_overlay_mapping
from app.services.cv_generator_fallback import (
    convert_docx_to_pdf as convert_docx_to_pdf_fallback,
)
from app.services.cv_generator_fallback import process_cv as process_cv_fallback
from app.services.cv_translation import (
    SUPPORTED_LANGUAGES as CV_TRANSLATION_SUPPORTED_LANGUAGES,
    translate_cv_best_effort,
    translate_docx_headings,
)
from app.services.cv_io import validate_zip_members
from app.utils.logger import logger

router = APIRouter()

# Allow overriding the root path via environment variables for VM deployments
_env_root = os.getenv("PROJECT_ROOT")
REPO_ROOT = Path(_env_root).resolve() if _env_root else Path(__file__).resolve().parents[3]

# Hard ceiling: reject templates bigger than 50 MB to avoid memory exhaustion.
_MAX_TEMPLATE_BYTES = 50 * 1024 * 1024

_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_PDF_MIME = "application/pdf"
_SUPPORTED_TEMPLATE_EXTS = (".docx", ".pdf")
_SUPPORTED_ENGINES = ("primary", "fallback")


def _cleanup_dir(path_str: str) -> None:
    """Best-effort temp-dir cleanup, used as a FastAPI BackgroundTask."""
    shutil.rmtree(path_str, ignore_errors=True)


class GenerateCvRequest(BaseModel):
    template_path: str
    output_dir: str
    output_formats: List[str] = Field(default_factory=lambda: ["docx", "pdf"])
    language: Optional[str] = None
    translate: bool = True
    filename_prefix: Optional[str] = None
    profile: Dict[str, Any]
    field_mapping: Optional[Dict[str, str]] = None
    engine: Literal["primary", "fallback"] = "primary"
    debug: bool = False


class AnalyzeTemplateRequest(BaseModel):
    template_path: str


def _validate_path(path_str: str, label: str) -> Path:
    resolved = Path(path_str).resolve()
    norm_resolved = os.path.normcase(str(resolved))
    norm_root = os.path.normcase(str(REPO_ROOT))
    if not norm_resolved.startswith(norm_root):
        logger.error(
            "Path validation failed for %s: resolved='%s', root='%s'",
            label,
            norm_resolved,
            norm_root,
        )
        raise HTTPException(
            status_code=400,
            detail=f"{label} must be within the repository",
        )
    return resolved


def _to_relative(path_str: Optional[str]) -> Optional[str]:
    if not path_str:
        return None
    try:
        return str(Path(path_str).resolve().relative_to(REPO_ROOT))
    except Exception:
        return path_str


def _normalize_formats(
    output_formats: Optional[List[str]] = None,
    output_format: Optional[str] = None,
) -> List[str]:
    if output_formats:
        values = [str(v).lower() for v in output_formats]
    else:
        raw = (output_format or "docx").lower()
        if raw == "both":
            values = ["docx", "pdf"]
        elif raw == "pdf":
            values = ["pdf"]
        else:
            values = ["docx"]

    normalized: List[str] = []
    for value in values:
        if value in ("docx", "pdf") and value not in normalized:
            normalized.append(value)

    if not normalized:
        normalized = ["docx"]
    return normalized


def _safe_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _format_date_range(start_value: Any, end_value: Any) -> str:
    start = _safe_str(start_value)
    end = _safe_str(end_value)
    if start and end:
        return f"{start} - {end}"
    return start or end


def _coerce_string_list(value: Any, dict_keys: tuple[str, ...] = ()) -> List[str]:
    if value is None:
        return []

    raw_items: List[Any]
    if isinstance(value, list):
        raw_items = value
    else:
        raw_items = [value]

    out: List[str] = []
    seen: set[str] = set()
    for item in raw_items:
        text = ""
        if isinstance(item, str):
            text = item.strip()
        elif isinstance(item, dict):
            for key in dict_keys:
                candidate = item.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    text = candidate.strip()
                    break
            if not text:
                fallback = item.get("name")
                if isinstance(fallback, str):
                    text = fallback.strip()
        elif item is not None:
            text = str(item).strip()

        if not text:
            continue
        norm = text.lower()
        if norm in seen:
            continue
        seen.add(norm)
        out.append(text)

    return out


def _normalize_experience_entries(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []

    normalized: List[Dict[str, Any]] = []
    for entry in value:
        if not isinstance(entry, dict):
            continue
        title = _safe_str(entry.get("title") or entry.get("jobTitle") or entry.get("role"))
        company = _safe_str(entry.get("company") or entry.get("companyName") or entry.get("client"))
        start_date = _safe_str(entry.get("startDate") or entry.get("start_date"))
        end_date = _safe_str(entry.get("endDate") or entry.get("end_date"))
        dates = _safe_str(entry.get("dates")) or _format_date_range(start_date, end_date)
        description = _safe_str(entry.get("description"))

        merged = dict(entry)
        merged["title"] = title
        merged["jobTitle"] = title or _safe_str(entry.get("jobTitle"))
        merged["company"] = company
        merged["companyName"] = company or _safe_str(entry.get("companyName"))
        merged["dates"] = dates
        merged["start_date"] = start_date
        merged["end_date"] = end_date
        merged["description"] = description
        normalized.append(merged)

    return normalized


def _normalize_education_entries(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []

    normalized: List[Dict[str, Any]] = []
    for entry in value:
        if not isinstance(entry, dict):
            continue
        degree = _safe_str(entry.get("degree"))
        institution = _safe_str(entry.get("institution") or entry.get("school"))
        start_date = _safe_str(entry.get("startDate") or entry.get("start_date"))
        end_date = _safe_str(entry.get("endDate") or entry.get("end_date") or entry.get("graduationDate"))
        dates = _safe_str(entry.get("dates")) or _format_date_range(start_date, end_date)

        merged = dict(entry)
        merged["degree"] = degree
        merged["institution"] = institution
        merged["dates"] = dates
        merged["end_date"] = end_date
        normalized.append(merged)

    return normalized


def _profile_to_fallback_payload(profile: Dict[str, Any]) -> Dict[str, Any]:
    name = (profile.get("name") or "").strip()
    if not name:
        first = (profile.get("firstName") or "").strip()
        last = (profile.get("lastName") or "").strip()
        name = f"{first} {last}".strip()

    raw_experience = profile.get("experience") or profile.get("workExperiences") or []
    raw_education = profile.get("education") or profile.get("educations") or []
    normalized_experience = _normalize_experience_entries(raw_experience)
    normalized_education = _normalize_education_entries(raw_education)

    linkedin = (
        profile.get("linkedin")
        or profile.get("linkedinUrl")
        or profile.get("linkedin_url")
        or profile.get("linkedIn")
        or ""
    )

    raw_address = _safe_str(profile.get("address"))
    if not raw_address:
        address_parts = [
            _safe_str(profile.get("addressLine1") or profile.get("street")),
            _safe_str(profile.get("addressLine2")),
            _safe_str(profile.get("postalCode") or profile.get("zip") or profile.get("zipCode")),
            _safe_str(profile.get("city") or profile.get("town")),
            _safe_str(profile.get("state") or profile.get("province") or profile.get("region")),
            _safe_str(profile.get("country")),
            _safe_str(profile.get("location")),
        ]
        dedup_parts: List[str] = []
        seen_addr: set[str] = set()
        for part in address_parts:
            if not part:
                continue
            key = part.lower()
            if key in seen_addr:
                continue
            seen_addr.add(key)
            dedup_parts.append(part)
        raw_address = ", ".join(dedup_parts)

    return {
        "name": name,
        "firstName": profile.get("firstName") or "",
        "lastName": profile.get("lastName") or "",
        "title": profile.get("title") or profile.get("currentPosition") or "",
        "email": profile.get("email") or "",
        "phone": profile.get("phone") or "",
        "address": raw_address,
        "linkedin": linkedin,
        "summary": profile.get("summary") or profile.get("professionalSummary") or "",
        "skills": _coerce_string_list(profile.get("skills"), ("name", "skill", "label")),
        "experience": normalized_experience,
        "education": normalized_education,
        "languages": _coerce_string_list(profile.get("languages"), ("name", "language", "label", "lang")),
        "certifications": _coerce_string_list(profile.get("certifications"), ("name", "certification_name", "title")),
        "projects": profile.get("projects") or [],
        "photo": profile.get("photo"),
    }



def _run_fallback_generation(
    template_path: str,
    output_dir: str,
    profile: Dict[str, Any],
    output_formats: List[str],
    debug: bool,
    language: str = "original",
) -> Dict[str, Any]:
    employee_data = _profile_to_fallback_payload(profile)

    fallback_warnings: List[Dict[str, Any]] = []

    # Apply translation pipeline (translate_cv_best_effort)
    # before rendering. Only the supported languages (en/fr) are translated;
    # 'original'/unsupported codes pass through unchanged.
    lang = (language or "original").strip().lower()
    should_translate_headings = bool(lang) and lang in CV_TRANSLATION_SUPPORTED_LANGUAGES
    if should_translate_headings:
        logger.info("Translating employee data to '%s' via local translation pipeline", lang)
        try:
            employee_data = translate_cv_best_effort(employee_data, lang)
        except Exception as exc:
            logger.warning("CV data translation failed (non-fatal): %s", exc)

    docx_path = process_cv_fallback(
        template_path=template_path,
        employee_data=employee_data,
        output_dir=output_dir,
        output_pdf=False,
        debug=debug,
        language=lang,
    )

    if should_translate_headings:
        try:
            translate_docx_headings(docx_path, lang)
        except Exception as exc:
            logger.warning("Section heading translation failed (non-fatal): %s", exc)

    pdf_path: Optional[str] = None
    if "pdf" in output_formats:
        try:
            pdf_path = convert_docx_to_pdf_fallback(docx_path)
        except FileNotFoundError:
            logger.warning(
                "LibreOffice (soffice) not found — PDF conversion skipped. "
                "Install LibreOffice to enable PDF output."
            )
            fallback_warnings.append({
                "code": "pdf_conversion_unavailable",
                "severity": "info",
                "message": (
                    "PDF preview is unavailable because LibreOffice is not "
                    "installed on the AI service. The DOCX file is still ready."
                ),
            })
        except Exception as exc:
            logger.warning("PDF conversion failed (non-fatal): %s", exc)
            fallback_warnings.append({
                "code": "pdf_conversion_failed",
                "severity": "warning",
                "message": f"PDF conversion failed: {exc}",
            })

    return {
        "docx_path": docx_path,
        "pdf_path": pdf_path,
        "warnings": fallback_warnings,
    }



def _validate_template_ext(filename: Optional[str]) -> str:
    """Return a lowercase extension or raise 400 if unsupported."""
    file_ext = os.path.splitext(filename or "")[1].lower()
    if file_ext not in _SUPPORTED_TEMPLATE_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported template format: {file_ext or '(none)'}. Upload a .docx or .pdf file.",
        )
    return file_ext


def _validate_engine(engine_value: Optional[str]) -> str:
    engine_mode = (engine_value or "fallback").strip().lower()
    if engine_mode not in _SUPPORTED_ENGINES:
        raise HTTPException(status_code=400, detail="engine must be 'primary' or 'fallback'")
    return engine_mode


def _parse_employee_data(raw: str) -> Dict[str, Any]:
    """Decode and lightly normalize the employee_data JSON form field."""
    try:
        profile = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid employee_data JSON: {exc}") from exc

    if not isinstance(profile, dict):
        raise HTTPException(status_code=400, detail="employee_data must be a JSON object")

    name = (profile.get("name") or "").strip()
    if not name:
        first = (profile.get("firstName") or "").strip()
        last = (profile.get("lastName") or "").strip()
        name = f"{first} {last}".strip()

    if not name:
        raise HTTPException(
            status_code=400,
            detail="employee_data must include 'name' (or 'firstName'/'lastName')",
        )
    profile["name"] = name
    return profile


async def _persist_uploaded_template(
    upload: UploadFile, temp_dir: str, file_ext: str
) -> str:
    """Stream the uploaded template to disk, enforcing the size cap."""
    template_path = os.path.join(temp_dir, f"template{file_ext}")
    content = await upload.read()
    if len(content) > _MAX_TEMPLATE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Template too large ({len(content) // 1024 // 1024} MB). "
                f"Max is {_MAX_TEMPLATE_BYTES // 1024 // 1024} MB."
            ),
        )
    with open(template_path, "wb") as file_handle:
        file_handle.write(content)
    return template_path


def _validate_docx_template(template_path: str) -> None:
    """Raise 400 if the file is not a valid DOCX archive."""
    if not zipfile.is_zipfile(template_path):
        raise HTTPException(
            status_code=400,
            detail="Uploaded file is not a valid DOCX (corrupt or not a ZIP archive).",
        )
    try:
        with zipfile.ZipFile(template_path, "r") as zip_file:
            validate_zip_members(zip_file)
            if "word/document.xml" not in zip_file.namelist():
                raise HTTPException(
                    status_code=400,
                    detail="Uploaded file is a ZIP but not a valid DOCX (missing word/document.xml).",
                )
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Uploaded file has a corrupt ZIP structure.") from exc
    except CVTemplateError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _collect_template_warnings(
    template_path: str, engine_mode: str, profile: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """Return a list of `{code, message, severity}` warnings for the user.

    Best-effort: any failure here returns an empty list so generation isn't
    blocked. Warnings include unmapped Jinja2 placeholders (primary engine),
    missing section headings (both engines), and missing profile fields the
    template appears to want.
    """
    warnings: List[Dict[str, Any]] = []
    try:
        analysis = analyze_template(template_path)
    except Exception as exc:
        logger.warning("Template pre-analysis failed (non-fatal): %s", exc)
        return warnings

    # Primary engine cares about unmapped placeholders; fallback engine doesn't
    # use them, so skip that warning entirely in fallback mode.
    if engine_mode == "primary":
        unmapped_count = analysis.get("unmapped_count") or 0
        if unmapped_count:
            unmapped_names = [
                f.get("name")
                for f in (analysis.get("fields") or [])
                if f.get("source") == "unmatched" and f.get("name")
            ]
            warnings.append({
                "code": "unmapped_placeholders",
                "severity": "warning",
                "message": (
                    f"{unmapped_count} placeholder(s) in this template don't match a known "
                    "profile field and will be left unfilled."
                ),
                "details": unmapped_names[:20],
            })

    rules = analysis.get("authoring_rules") or {}
    sections_found = {s.get("section") for s in (rules.get("sections") or [])}
    expected_sections = {"experience", "education", "skills"}
    missing_sections = sorted(expected_sections - sections_found)
    if missing_sections:
        warnings.append({
            "code": "missing_section_headings",
            "severity": "info",
            "message": (
                "No clear section headings detected for: "
                + ", ".join(missing_sections)
                + ". The engine will still try to place content, but explicit "
                "headings improve accuracy."
            ),
            "details": missing_sections,
        })

    # Profile-side warnings: surface fields the user is missing that templates
    # commonly want, so the generated CV doesn't have suspicious blanks.
    missing_profile_fields: List[str] = []
    for key, label in (
        ("summary", "professional summary"),
        ("email", "email"),
        ("phone", "phone"),
        ("address", "address"),
    ):
        value = profile.get(key)
        if not value or (isinstance(value, str) and not value.strip()):
            missing_profile_fields.append(label)
    if missing_profile_fields:
        warnings.append({
            "code": "missing_profile_fields",
            "severity": "info",
            "message": (
                "The selected employee profile is missing: "
                + ", ".join(missing_profile_fields)
                + ". These fields will be blank in the output."
            ),
            "details": missing_profile_fields,
        })

    return warnings


def _encode_warnings_header(warnings: List[Dict[str, Any]]) -> Optional[str]:
    """Serialize warnings to a JSON string safe for an HTTP header value."""
    if not warnings:
        return None
    try:
        encoded = json.dumps(warnings, ensure_ascii=True, separators=(",", ":"))
    except Exception:
        return None
    # Keep the header reasonably bounded — most servers/proxies cap header size
    # around 8 KB. Cut to ~6 KB to leave room for the rest of the response.
    if len(encoded) > 6000:
        encoded = json.dumps(warnings[:5], ensure_ascii=True, separators=(",", ":"))
    return encoded


def _file_response(
    path: str, *, mime: str, engine: str, extra_headers: Optional[Dict[str, str]] = None,
) -> FileResponse:
    """Build a FileResponse with consistent CV headers.

    Note: we deliberately don't set `background=` here — FastAPI auto-attaches
    any tasks added via the injected `BackgroundTasks` dependency to the
    returned response, so the temp-dir cleanup runs after the bytes flush.
    """
    headers = {
        "X-CV-Format": "pdf" if mime == _PDF_MIME else "docx",
        "X-CV-Engine": engine,
    }
    if extra_headers:
        headers.update(extra_headers)
    return FileResponse(
        path=path,
        filename=os.path.basename(path),
        media_type=mime,
        headers=headers,
    )


def _select_response_path(
    docx_path: Optional[str],
    pdf_path: Optional[str],
    output_format: str,
    engine: str,
    warnings: Optional[List[Dict[str, Any]]] = None,
) -> FileResponse:
    """Pick the right file to return based on requested output_format."""
    want_pdf = (output_format or "").lower() == "pdf"

    extra: Dict[str, str] = {}
    encoded_warnings = _encode_warnings_header(warnings or [])
    if encoded_warnings:
        extra["X-CV-Warnings"] = encoded_warnings

    if want_pdf:
        if pdf_path and os.path.exists(pdf_path):
            return _file_response(pdf_path, mime=_PDF_MIME, engine=engine, extra_headers=extra or None)
        if docx_path and os.path.exists(docx_path):
            logger.warning("PDF conversion failed in %s mode, returning DOCX as fallback", engine)
            extra["X-PDF-Failed"] = "true"
            return _file_response(
                docx_path,
                mime=_DOCX_MIME,
                engine=engine,
                extra_headers=extra,
            )
        raise HTTPException(status_code=500, detail="CV generation failed - no output file")

    if not docx_path or not os.path.exists(docx_path):
        raise HTTPException(status_code=500, detail="CV generation failed - no output file")

    if pdf_path and os.path.exists(pdf_path):
        extra["X-PDF-Available"] = "true"
    return _file_response(docx_path, mime=_DOCX_MIME, engine=engine, extra_headers=extra or None)


async def _handle_json_request(request: Request) -> Dict[str, Any]:
    """Path-based flow used by the cv-generation NestJS module."""
    try:
        payload = await request.json()
        req = GenerateCvRequest.model_validate(payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON payload: {exc}") from exc

    resolved_template = _validate_path(req.template_path, "template_path")
    resolved_output = _validate_path(req.output_dir, "output_dir")
    output_formats = _normalize_formats(output_formats=req.output_formats)

    _tmp_dir: Optional[str] = None
    try:
        if req.engine == "fallback":
            template_for_fallback = str(resolved_template)
            # If PDF, convert to DOCX first
            if resolved_template.suffix.lower() == ".pdf":
                try:
                    import tempfile as _tf
                    _tmp_dir = _tf.mkdtemp(prefix="cv_fb_pdf_")
                    std_result = standardize_template(template_for_fallback, _tmp_dir, req.profile, ["docx"])
                    if std_result.get("response"):
                        raise RuntimeError("PDF standardization returned an unexpected direct response")
                    converted = std_result["template_path"]
                    if not converted or not os.path.exists(converted) or converted == template_for_fallback:
                        raise RuntimeError("Conversion produced no output file.")
                    template_for_fallback = converted
                    logger.info("Converted PDF to DOCX for fallback (JSON mode): %s", converted)
                except HTTPException:
                    raise
                except Exception as exc:
                    msg = str(exc)
                    logger.error("PDF-to-DOCX conversion failed (JSON mode): %s", msg, exc_info=True)
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Could not convert the PDF template to DOCX: {msg} "
                            "Please install pdf2docx (pip install pdf2docx) and restart "
                            "the service, or use a DOCX template instead."
                        ),
                    )
            result = _run_fallback_generation(
                template_path=template_for_fallback,
                output_dir=str(resolved_output),
                profile=req.profile,
                output_formats=output_formats,
                debug=req.debug,
                language=req.language or "original",
            )
        else:
            result = generate_cv_document(
                profile=req.profile,
                template_path=str(resolved_template),
                output_dir=str(resolved_output),
                output_formats=output_formats,
                target_language=req.language,
                translate=req.translate,
                filename_prefix=req.filename_prefix,
                cached_field_mapping=req.field_mapping,
            )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Template file not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except CVGenerationError as exc:
        logger.error("CV generation error [%s]: %s", exc.category, exc.detail, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"CV generation failed ({exc.category}): {exc.detail}",
        ) from exc
    except Exception as exc:
        logger.error("CV generation unexpected error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="CV generation failed (internal error)") from exc
    finally:
        # Always clean up the temporary PDF→DOCX conversion directory after
        # generation has completed, regardless of success or failure.
        if _tmp_dir:
            shutil.rmtree(_tmp_dir, ignore_errors=True)

    docx_path = result.get("docx_path")
    pdf_path = result.get("pdf_path")
    matched_template_path = result.get("matched_template_path")

    return {
        "engine": req.engine,
        "docx_path": docx_path,
        "pdf_path": pdf_path,
        "docx_relative_path": _to_relative(docx_path),
        "pdf_relative_path": _to_relative(pdf_path),
        "field_mapping": result.get("field_mapping"),
        "matched_template_path": matched_template_path,
        "matched_template_relative_path": _to_relative(matched_template_path),
        "warnings": result.get("warnings") or [],
    }


@router.post("/cv")
async def generate_cv(
    request: Request,
    background_tasks: BackgroundTasks,
    template: Optional[UploadFile] = File(None),
    employee_data: Optional[str] = Form(None),
    output_format: Optional[str] = Form("docx"),
    debug: Optional[str] = Form("false"),
    language: Optional[str] = Form("original"),
    engine: Optional[str] = Form("fallback"),
):
    """Unified endpoint supporting both JSON/path and multipart/upload workflows."""

    content_type = (request.headers.get("content-type") or "").lower()

    # ── JSON mode (path-based flow used by cv-generation module) ──────────
    if "application/json" in content_type:
        return await _handle_json_request(request)

    # ── Multipart mode (upload template + employee_data) ──────────────────
    if template is None or employee_data is None:
        raise HTTPException(
            status_code=400,
            detail="Multipart mode requires 'template' file and 'employee_data' form field",
        )

    debug_mode = str(debug or "false").lower() in ("true", "1", "yes")
    engine_mode = _validate_engine(engine)
    file_ext = _validate_template_ext(template.filename)

    # Fallback engine only handles DOCX natively; PDF templates are converted
    # to DOCX inside the main try block via standardize_template.
    profile = _parse_employee_data(employee_data)

    temp_dir = tempfile.mkdtemp(prefix="cv_gen_")
    # On success, the FileResponse's BackgroundTasks (injected) cleans the dir
    # *after* the bytes are flushed to the client. On error paths we need
    # explicit cleanup since BackgroundTasks won't fire without a response.
    background_tasks.add_task(_cleanup_dir, temp_dir)
    success = False

    try:
        template_path = await _persist_uploaded_template(template, temp_dir, file_ext)

        if file_ext == ".docx":
            _validate_docx_template(template_path)

        formats = _normalize_formats(output_format=output_format)

        # If PDF uploaded with fallback engine, convert to DOCX first.
        # A failed conversion is always surfaced as a clear error — we never
        # silently fall back to OCR on a native PDF because that produces
        # unusable garbled output.
        if engine_mode == "fallback" and file_ext == ".pdf":
            try:
                std_result = standardize_template(template_path, temp_dir, profile, ["docx"])
                if std_result.get("response"):
                    raise RuntimeError("PDF standardization returned an unexpected direct response")
                converted_path = std_result["template_path"]
                if not converted_path or not os.path.exists(converted_path) or converted_path == template_path:
                    raise RuntimeError("Conversion produced no output file.")
                _validate_docx_template(converted_path)
                template_path = converted_path
                logger.info("Converted PDF template to DOCX for fallback engine: %s", template_path)
            except HTTPException:
                raise
            except Exception as exc:
                msg = str(exc)
                logger.error("PDF-to-DOCX conversion for fallback engine failed: %s", msg, exc_info=True)
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Could not convert the PDF template to DOCX: {msg} "
                        "Please install pdf2docx (pip install pdf2docx) and restart "
                        "the service, or use a DOCX template instead."
                    ),
                )

        # Pre-flight analysis — surface warnings about the template/profile
        # combination before the engine runs. Best-effort, never blocks.
        try:
            pre_warnings = _collect_template_warnings(template_path, engine_mode, profile)
        except Exception as exc:
            logger.warning("Template warning collection failed (non-fatal): %s", exc)
            pre_warnings = []

        if engine_mode == "fallback":
            # Advanced AI engine — lxml + local model pattern-based replacement.
            result = _run_fallback_generation(
                template_path=template_path,
                output_dir=temp_dir,
                profile=profile,
                output_formats=formats,
                debug=debug_mode,
                language=language or "original",
            )
        else:
            # Islam's Standard engine — Jinja2/docxtpl authoring-rules renderer.
            std_result = standardize_template(template_path, temp_dir, profile, formats)
            if std_result["response"]:
                r = std_result["response"]
                if (output_format or "").lower() == "pdf" and r.get("pdf_path"):
                    success = True
                    return _file_response(r["pdf_path"], mime=_PDF_MIME, engine=engine_mode)

            template_path = std_result["template_path"]

            # Resolve target language: the `language` form param takes precedence.
            # 'original' / '' / None all mean "do not translate".
            _req_lang = (language or "").strip().lower()
            profile_lang = _req_lang if _req_lang not in ("", "original", "orig") else None
            should_translate = profile_lang is not None

            cached_mapping = (
                profile.get("field_mapping") if isinstance(profile.get("field_mapping"), dict) else None
            )
            filename_prefix = (
                profile.get("filename_prefix") if isinstance(profile.get("filename_prefix"), str) else None
            )

            result = generate_cv_document(
                profile=profile,
                template_path=template_path,
                output_dir=temp_dir,
                output_formats=formats,
                target_language=profile_lang,
                translate=should_translate,
                filename_prefix=filename_prefix,
                cached_field_mapping=cached_mapping,
            )

        # Merge engine-side warnings (e.g. unfilled fields, local model unavailable
        # from the fallback engine) with pre-flight analysis warnings.
        engine_warnings = result.get("warnings") if isinstance(result, dict) else None
        merged_warnings = list(pre_warnings)
        if isinstance(engine_warnings, list):
            merged_warnings.extend(w for w in engine_warnings if isinstance(w, dict))

        response = _select_response_path(
            result.get("docx_path"),
            result.get("pdf_path"),
            output_format or "docx",
            engine_mode,
            warnings=merged_warnings,
        )
        success = True
        return response

    except HTTPException:
        raise
    except (ValueError, CVValidationError, CVTemplateError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except CVGenerationError as exc:
        logger.error("CV generation error [%s]: %s", exc.category, exc.detail, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"CV generation failed ({exc.category}): {exc.detail}",
        ) from exc
    except Exception as exc:
        logger.error("CV generation unexpected error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="CV generation failed (internal error)") from exc
    finally:
        if not success:
            shutil.rmtree(temp_dir, ignore_errors=True)


@router.post("/analyze-template")
async def analyze_template_endpoint(req: AnalyzeTemplateRequest):
    """Extract and map all fields/placeholders from a template file via primary engine."""
    resolved = _validate_path(req.template_path, "template_path")

    try:
        result = analyze_template(str(resolved))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Template file not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return result


@router.post("/build-overlay-mapping")
async def build_overlay_mapping_endpoint(req: AnalyzeTemplateRequest):
    """Compute a label→position overlay mapping for a PDF template.

    Used at template-upload time to cache the mapping so the primary engine
    can preserve the PDF's exact layout on every subsequent generation
    without recomputing positions for each request.
    """
    resolved = _validate_path(req.template_path, "template_path")
    if resolved.suffix.lower() != ".pdf":
        raise HTTPException(status_code=400, detail="Overlay mapping only applies to PDF templates")
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Template file not found")

    # The mapper accepts a context dict to fill date-derived fields. At upload
    # time we don't have an employee — the empty context just means the few
    # context-dependent rules (last_degree, open_end_label) skip themselves;
    # all label-anchored fields are still detected.
    try:
        mapping = build_auto_overlay_mapping(str(resolved), {})
    except Exception as exc:
        logger.error("Overlay mapping build failed for %s: %s", resolved, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Overlay mapping failed: {exc}")

    return mapping
