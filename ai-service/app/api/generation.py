Unified endpoint supporting both primary and fallback CV generation engines.
Accepts both JSON (path-based) and multipart (file upload) workflows.
"""
from __future__ import annotations

from __future__ import annotations

import json
import os
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.services.cv_errors import CVGenerationError, CVTemplateError, CVValidationError
from app.services.cv_generator import (
    analyze_template,
    generate_cv_document,
    standardize_template,
)
from app.services.cv_generator_fallback import (
    convert_docx_to_pdf as convert_docx_to_pdf_fallback,
)
from app.services.cv_generator_fallback import process_cv as process_cv_fallback
from app.services.cv_io import validate_zip_members
from app.utils.logger import logger

router = APIRouter()

# Allow overriding the root path via environment variables for VM deployments
_env_root = os.getenv("PROJECT_ROOT")
REPO_ROOT = Path(_env_root).resolve() if _env_root else Path(__file__).resolve().parents[3]

# Hard ceiling: reject templates bigger than 50 MB to avoid memory exhaustion.
_MAX_TEMPLATE_BYTES = 50 * 1024 * 1024


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


def _profile_to_fallback_payload(profile: Dict[str, Any]) -> Dict[str, Any]:
    name = (profile.get("name") or "").strip()
    if not name:
        first = (profile.get("firstName") or "").strip()
        last = (profile.get("lastName") or "").strip()
        name = f"{first} {last}".strip()

    return {
        "name": name,
        "title": profile.get("title") or profile.get("currentPosition") or "",
        "email": profile.get("email") or "",
        "phone": profile.get("phone") or "",
        "address": profile.get("address") or "",
        "summary": profile.get("summary") or profile.get("professionalSummary") or "",
        "skills": profile.get("skills") or [],
        "experience": profile.get("experience") or profile.get("workExperiences") or [],
        "education": profile.get("education") or profile.get("educations") or [],
        "languages": profile.get("languages") or [],
        "certifications": profile.get("certifications") or [],
        "projects": profile.get("projects") or [],
        "photo": profile.get("photo"),
    }


def _run_fallback_generation(
    template_path: str,
    output_dir: str,
    profile: Dict[str, Any],
    output_formats: List[str],
    debug: bool,
) -> Dict[str, Optional[str]]:
    employee_data = _profile_to_fallback_payload(profile)
    docx_path = process_cv_fallback(
        template_path=template_path,
        employee_data=employee_data,
        output_dir=output_dir,
        output_pdf=False,
        debug=debug,
    )

    pdf_path: Optional[str] = None
    if "pdf" in output_formats:
        pdf_path = convert_docx_to_pdf_fallback(docx_path)

    if output_formats == ["pdf"] and pdf_path:
        return {"docx_path": docx_path, "pdf_path": pdf_path}

    return {"docx_path": docx_path, "pdf_path": pdf_path}


@router.post("/cv")
async def generate_cv(
    request: Request,
    template: Optional[UploadFile] = File(None),
    employee_data: Optional[str] = Form(None),
    output_format: Optional[str] = Form("docx"),
    debug: Optional[str] = Form("false"),
    engine: Optional[str] = Form("primary"),
):
    """Unified endpoint supporting both JSON/path and multipart/upload workflows."""

    content_type = (request.headers.get("content-type") or "").lower()

    # JSON mode (legacy path-based flow used by cv-generation module)
    if "application/json" in content_type:
        try:
            payload = await request.json()
            req = GenerateCvRequest.model_validate(payload)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid JSON payload: {exc}") from exc

        resolved_template = _validate_path(req.template_path, "template_path")
        resolved_output = _validate_path(req.output_dir, "output_dir")
        output_formats = _normalize_formats(output_formats=req.output_formats)

        try:
            if req.engine == "fallback":
                result = _run_fallback_generation(
                    template_path=str(resolved_template),
                    output_dir=str(resolved_output),
                    profile=req.profile,
                    output_formats=output_formats,
                    debug=req.debug,
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
            }
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Template file not found")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    # Multipart mode (upload template + employee_data)
    if template is None or employee_data is None:
        raise HTTPException(
            status_code=400,
            detail="Multipart mode requires 'template' file and 'employee_data' form field",
        )

    debug_mode = str(debug or "false").lower() in ("true", "1", "yes")
    engine_mode = str(engine or "primary").lower()
    if engine_mode not in ("primary", "fallback"):
        raise HTTPException(status_code=400, detail="engine must be 'primary' or 'fallback'")

    file_ext = os.path.splitext(template.filename or "")[1].lower()
    if file_ext not in (".docx", ".pdf"):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported template format: {file_ext}. Please upload a .docx or .pdf file.",
        )
    return resolved

    try:
        profile = json.loads(employee_data)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid employee_data JSON: {exc}") from exc

    if not isinstance(profile, dict):
        raise HTTPException(status_code=400, detail="employee_data must be a JSON object")

    emp_name = (profile.get("name") or "").strip()
    if not emp_name:
        first = (profile.get("firstName") or "").strip()
        last = (profile.get("lastName") or "").strip()
        emp_name = f"{first} {last}".strip()
        if emp_name:
            profile["name"] = emp_name
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

    raw_experience = profile.get("work_experiences") or profile.get("experience") or profile.get("workExperiences") or []
    raw_education = profile.get("educations") or profile.get("education") or profile.get("educations") or []
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
        "certifications": profile.get("certifications") or [],
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

    # Apply Rania's Groq-powered translation pipeline (translate_cv_best_effort)
    # before rendering. Only the supported languages (en/fr) are translated;
    # 'original'/unsupported codes pass through unchanged.
    lang = (language or "original").strip().lower()
    should_translate_headings = bool(lang) and lang in CV_TRANSLATION_SUPPORTED_LANGUAGES
    if should_translate_headings:
        logger.info("Translating employee data to '%s' via Groq (cv_translation)", lang)
        try:
            employee_data = translate_cv_best_effort(employee_data, lang)
        except Exception as exc:
            logger.warning("CV data translation failed (non-fatal): %s", exc)

    engine_warnings: List[Dict[str, Any]] = []
    docx_path = process_cv_fallback(
        template_path=template_path,
        employee_data=employee_data,
        output_dir=output_dir,
        output_pdf=False,
        debug=debug,
        language=lang,
        out_warnings=engine_warnings,
    )
    fallback_warnings.extend(engine_warnings)

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
        content = await template.read()
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
                        detail=(
                            "Uploaded file is a ZIP but not a valid DOCX "
                            "(missing word/document.xml)."
                        ),
                    )
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail="Uploaded file has a corrupt ZIP structure.") from exc
        except CVTemplateError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        formats = _normalize_formats(output_format=output_format)

        # Standardize template (conversion, OCR, etc.) for engines that expect DOCX
        std_result = standardize_template(
            template_path, temp_dir, profile, formats
        )
        if std_result["response"]:
            r = std_result["response"]
            if output_format == "pdf" and r.get("pdf_path"):
                 return FileResponse(
                    path=r["pdf_path"],
                    filename=os.path.basename(r["pdf_path"]),
                    media_type="application/pdf",
                    headers={"X-CV-Format": "pdf", "X-CV-Engine": engine_mode},
                )
            # If we already have a response (e.g. from overlay mode), we could return it
            # but usually we want to proceed to return the file. 
            # For now, if response exists but isn't what we wanted, we proceed with the path.

        template_path = std_result["template_path"]
        # If it was converted, update the file_ext for correct engine logic
        if template_path.endswith(".docx"):
            file_ext = ".docx"

        if engine_mode == "fallback":
            result = _run_fallback_generation(
                template_path=template_path,
                output_dir=temp_dir,
                profile=profile,
                output_formats=formats,
                debug=debug_mode,
            )
        else:
            result = generate_cv_document(
                profile=profile,
                template_path=template_path,
                output_dir=temp_dir,
                output_formats=formats,
                target_language=profile.get("language") if isinstance(profile.get("language"), str) else None,
                translate=bool(profile.get("translate", True)),
                filename_prefix=profile.get("filename_prefix") if isinstance(profile.get("filename_prefix"), str) else None,
                cached_field_mapping=profile.get("field_mapping") if isinstance(profile.get("field_mapping"), dict) else None,
            )

        docx_path = result.get("docx_path")
        pdf_path = result.get("pdf_path")

        if output_format and output_format.lower() == "pdf":
            if pdf_path and os.path.exists(pdf_path):
                return FileResponse(
                    path=pdf_path,
                    filename=os.path.basename(pdf_path),
                    media_type="application/pdf",
                    headers={"X-CV-Format": "pdf", "X-CV-Engine": engine_mode},
                )
            if docx_path and os.path.exists(docx_path):
                logger.warning("PDF conversion failed in %s mode, returning DOCX", engine_mode)
                return FileResponse(
                    path=docx_path,
                    filename=os.path.basename(docx_path),
                    media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    headers={
                        "X-CV-Format": "docx",
                        "X-PDF-Failed": "true",
                        "X-CV-Engine": engine_mode,
                    },
                )
            raise HTTPException(status_code=500, detail="CV generation failed - no output file")

        if not docx_path or not os.path.exists(docx_path):
            raise HTTPException(status_code=500, detail="CV generation failed - no output file")

        headers = {"X-CV-Format": "docx", "X-CV-Engine": engine_mode}
        if pdf_path and os.path.exists(pdf_path):
            headers["X-PDF-Available"] = "true"

        return FileResponse(
            path=docx_path,
            filename=os.path.basename(docx_path),
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers=headers,
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

        # Merge engine-side warnings (e.g. unfilled fields, Groq unavailable
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
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except CVGenerationError as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error("CV generation error [%s]: %s", exc.category, exc.detail, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"CV generation failed ({exc.category}): {exc.detail}",
        ) from exc
    except Exception as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error("CV generation unexpected error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="CV generation failed (internal error)") from exc


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
