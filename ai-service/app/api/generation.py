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
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from app.services.cv_generator import process_cv, convert_docx_to_pdf
from app.services.cv_errors import (
    CVGenerationError, CVValidationError, CVTemplateError,
    CVIOError, CVRenderError, CVExportError,
)
from app.services.cv_io import validate_zip_members
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
