from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
from pathlib import Path

from app.services.cv_generator import generate_cv_document, analyze_template

import os

router = APIRouter()

# Allow overriding the root path via environment variables for VM deployments
_env_root = os.getenv("PROJECT_ROOT")
REPO_ROOT = Path(_env_root).resolve() if _env_root else Path(__file__).resolve().parents[3]


class GenerateCvRequest(BaseModel):
    template_path: str
    output_dir: str
    output_formats: List[str] = Field(default_factory=lambda: ["docx", "pdf"])
    language: Optional[str] = None
    translate: bool = True
    filename_prefix: Optional[str] = None
    profile: Dict[str, Any]
    field_mapping: Optional[Dict[str, str]] = None


class AnalyzeTemplateRequest(BaseModel):
    template_path: str


class UpdateFieldMappingRequest(BaseModel):
    template_path: str
    field_mapping: Dict[str, str]


import os
import logging

logger = logging.getLogger(__name__)

def _validate_path(path_str: str, label: str) -> Path:
    resolved = Path(path_str).resolve()
    norm_resolved = os.path.normcase(str(resolved))
    norm_root = os.path.normcase(str(REPO_ROOT))
    if not norm_resolved.startswith(norm_root):
        logger.error(f"Path validation failed for {label}: resolved='{norm_resolved}', root='{norm_root}'")
        raise HTTPException(
            status_code=400,
            detail=f"{label} must be within the repository",
        )
    return resolved


@router.post("/cv")
async def generate_cv(req: GenerateCvRequest):
    resolved_template = _validate_path(req.template_path, "template_path")
    resolved_output = _validate_path(req.output_dir, "output_dir")

    try:
        result = generate_cv_document(
            profile=req.profile,
            template_path=str(resolved_template),
            output_dir=str(resolved_output),
            output_formats=req.output_formats,
            target_language=req.language,
            translate=req.translate,
            filename_prefix=req.filename_prefix,
            cached_field_mapping=req.field_mapping,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    docx_path = result.get("docx_path")
    pdf_path = result.get("pdf_path")

    def to_relative(path_str: Optional[str]):
        if not path_str:
            return None
        try:
            return str(Path(path_str).resolve().relative_to(REPO_ROOT))
        except Exception:
            return path_str

    return {
        "docx_path": docx_path,
        "pdf_path": pdf_path,
        "docx_relative_path": to_relative(docx_path),
        "pdf_relative_path": to_relative(pdf_path),
        "field_mapping": result.get("field_mapping"),
    }


@router.post("/analyze-template")
async def analyze_template_endpoint(req: AnalyzeTemplateRequest):
    """Extract and map all fields/placeholders from a template file."""
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
