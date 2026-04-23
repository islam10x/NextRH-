"""
CV Generation API Endpoint
===========================
Accepts a CV template file + employee data JSON and returns
a generated CV with personal data replaced.
"""

import json
import os
import shutil
import tempfile
import zipfile
from typing import Any, Dict, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from app.services.cv_generator import process_cv, convert_docx_to_pdf
from app.services.cv_errors import (
    CVGenerationError, CVValidationError, CVTemplateError,
    CVIOError, CVRenderError, CVExportError,
)
from app.services.cv_io import validate_zip_members
from app.services.translation_service import (
    translate_cv_best_effort,
    translate_docx_headings,
    SUPPORTED_LANGUAGES,
)
from app.utils.logger import logger

# Hard ceiling: reject templates bigger than 50 MB to avoid memory exhaustion.
_MAX_TEMPLATE_BYTES = 50 * 1024 * 1024

router = APIRouter()


@router.post("/cv")
async def generate_cv(
    template: UploadFile = File(...),
    employee_data: str = Form(...),
    output_format: Optional[str] = Form("docx"),
    debug: Optional[str] = Form("false"),
    language: Optional[str] = Form("en"),
):
    """
    Generate a CV by replacing template fields with employee data.

    - **template**: CV template file (.docx)
    - **employee_data**: JSON string with employee profile data
    - **output_format**: Output format: "docx", "pdf", or "both" (returns DOCX with PDF preview)
    - **debug**: Set to "true" to include a generation trace JSON alongside the output
    """
    debug_mode = debug and debug.lower() in ("true", "1", "yes")
    # Validate file type - only DOCX is supported for reliable processing
    allowed_extensions = (".docx",)
    file_ext = os.path.splitext(template.filename or "")[1].lower()
    if file_ext not in allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported template format: {file_ext}. Please upload a .docx file.",
        )

    # Parse employee data
    try:
        emp_data = json.loads(employee_data)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid employee_data JSON: {e}")

    if not isinstance(emp_data, dict):
        raise HTTPException(status_code=400, detail="employee_data must be a JSON object")

    # Validate and normalise language code
    target_lang = (language or "en").strip().lower()
    if target_lang not in SUPPORTED_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported language '{target_lang}'. Supported values: {sorted(SUPPORTED_LANGUAGES)}",
        )

    # Validate required fields
    emp_name = (emp_data.get("name") or "").strip()
    if not emp_name:
        # Try to build from firstName/lastName (backend sometimes sends those instead)
        first = (emp_data.get("firstName") or "").strip()
        last = (emp_data.get("lastName") or "").strip()
        emp_name = f"{first} {last}".strip()
        if emp_name:
            emp_data["name"] = emp_name
        else:
            raise HTTPException(
                status_code=400,
                detail="employee_data must include 'name' (or 'firstName'/'lastName')",
            )

    temp_dir = tempfile.mkdtemp(prefix="cv_gen_")
    template_path = os.path.join(temp_dir, f"template{file_ext}")

    try:
        # Save uploaded template and validate its structure
        content = await template.read()

        if len(content) > _MAX_TEMPLATE_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"Template too large ({len(content) // 1024 // 1024} MB). Max is {_MAX_TEMPLATE_BYTES // 1024 // 1024} MB.",
            )

        with open(template_path, "wb") as f:
            f.write(content)

        # Verify it's a valid DOCX (ZIP with word/document.xml)
        if not zipfile.is_zipfile(template_path):
            raise HTTPException(
                status_code=400,
                detail="Uploaded file is not a valid DOCX (corrupt or not a ZIP archive).",
            )
        try:
            with zipfile.ZipFile(template_path, "r") as zf:
                # Security: reject path-traversal attacks in ZIP entries
                validate_zip_members(zf)
                if "word/document.xml" not in zf.namelist():
                    raise HTTPException(
                        status_code=400,
                        detail="Uploaded file is a ZIP but not a valid DOCX (missing word/document.xml).",
                    )
        except zipfile.BadZipFile:
            raise HTTPException(status_code=400, detail="Uploaded file has a corrupt ZIP structure.")
        except CVTemplateError as e:
            raise HTTPException(status_code=400, detail=str(e))

        # ── Translation layer ─────────────────────────────────────────────
        # Apply translation AFTER validation, BEFORE template rendering.
        # Only translatable text fields (summary, descriptions) are touched.
        # The template itself is never modified.
        logger.info("Applying translation layer: target language = %s", target_lang)
        emp_data = translate_cv_best_effort(emp_data, target_lang)

        # Generate CV (always DOCX first)
        docx_path = process_cv(
            template_path=template_path,
            employee_data=emp_data,
            output_dir=temp_dir,
            output_pdf=False,
            debug=debug_mode,
        )

        if not os.path.exists(docx_path):
            raise HTTPException(status_code=500, detail="CV generation failed — no output file")

        # ── Translate section headings in generated DOCX ──────────────────
        # The data fields (summary, descriptions) were already translated above.
        # This pass replaces hardcoded template labels (e.g. "Education",
        # "Professional Experience") using a static lookup table — no API call.
        translate_docx_headings(docx_path, target_lang)

        # Handle output format
        output_format_lower = (output_format or "docx").lower()
        
        if output_format_lower == "pdf":
            # Convert to PDF and return PDF only
            pdf_path = convert_docx_to_pdf(docx_path)
            if pdf_path and os.path.exists(pdf_path):
                return FileResponse(
                    path=pdf_path,
                    filename=os.path.basename(pdf_path),
                    media_type="application/pdf",
                    headers={"X-CV-Format": "pdf"},
                )
            else:
                # Fallback to DOCX if PDF conversion fails
                logger.warning("PDF conversion failed, returning DOCX")
                return FileResponse(
                    path=docx_path,
                    filename=os.path.basename(docx_path),
                    media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    headers={"X-CV-Format": "docx", "X-PDF-Failed": "true"},
                )
        
        elif output_format_lower == "both":
            # Return DOCX with PDF path in header (for preview)
            pdf_path = convert_docx_to_pdf(docx_path)
            headers = {"X-CV-Format": "docx"}
            if pdf_path and os.path.exists(pdf_path):
                headers["X-PDF-Available"] = "true"
            
            return FileResponse(
                path=docx_path,
                filename=os.path.basename(docx_path),
                media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                headers=headers,
            )
        
        else:
            # Default: return DOCX
            return FileResponse(
                path=docx_path,
                filename=os.path.basename(docx_path),
                media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                headers={"X-CV-Format": "docx"},
            )

    except HTTPException:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    except (ValueError, CVValidationError, CVTemplateError) as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(e))
    except CVGenerationError as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error(f"CV generation error [{e.category}]: {e.detail}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"CV generation failed ({e.category}): {e.detail}",
        )
    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error(f"CV generation unexpected error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="CV generation failed (internal error)")


# ─── Standalone multilingual CV translation endpoint ─────────────────────────

from fastapi import Body
from pydantic import BaseModel, field_validator


class _TranslateRequest(BaseModel):
    target_language: str
    cv_data: Dict[str, Any]

    @field_validator("target_language")
    @classmethod
    def _check_lang(cls, v: str) -> str:
        v = v.strip().lower()
        if v not in SUPPORTED_LANGUAGES:
            raise ValueError(
                f"Unsupported target_language '{v}'. "
                f"Supported values: {sorted(SUPPORTED_LANGUAGES)}"
            )
        return v

    @field_validator("cv_data")
    @classmethod
    def _check_cv_data(cls, value: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(value, dict) or not value:
            raise ValueError("cv_data must be a non-empty JSON object")
        return value


@router.post("/cv/translate")
async def translate_cv_endpoint(request: _TranslateRequest):
    """
    Translate a structured CV into a target language using Groq LLM.

    Accepts a CV written in **any** language and returns the same JSON
    structure with all human-readable fields translated into
    ``target_language`` (``en`` or ``fr``).

    - Semantic understanding is performed first, then translation.
    - Proper names, company / school names, technical terms, and contact
      data are **never** modified.
    """
    try:
        translated = translate_cv_best_effort(request.cv_data, request.target_language)
        return {"target_language": request.target_language, "cv_data": translated}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("CV translation endpoint error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="CV translation failed (internal error)")
