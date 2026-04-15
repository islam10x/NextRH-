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
from app.services.cv_generator import analyze_template, generate_cv_document
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
    if file_ext != ".docx":
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported template format: {file_ext}. Please upload a .docx file.",
        )

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
            raise HTTPException(
                status_code=400,
                detail="employee_data must include 'name' (or 'firstName'/'lastName')",
            )

    temp_dir = tempfile.mkdtemp(prefix="cv_gen_")
    template_path = os.path.join(temp_dir, f"template{file_ext}")

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

    except HTTPException:
        shutil.rmtree(temp_dir, ignore_errors=True)
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
