"""
Resume Parser Service — Local Parsing Utility
============================================
Parses CV bytes/files locally (no external API calls).
"""

import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Dict

from app.parsers.template_parser import TemplateCVParser

logger = logging.getLogger("ai_service.resume_parser")


def _detect_extension(file_bytes: bytes) -> str:
    if file_bytes.startswith(b"%PDF-"):
        return ".pdf"
    # DOCX files are ZIP containers. We keep this coarse check because this
    # helper is only used for CV inputs, not arbitrary archive processing.
    if file_bytes.startswith(b"PK"):
        return ".docx"
    raise RuntimeError("Unsupported resume format. Expected PDF or DOCX bytes.")


def parse_resume_from_bytes(file_bytes: bytes) -> Dict[str, Any]:
    """Parse resume bytes locally and return structured JSON."""
    if not file_bytes:
        raise RuntimeError("Empty file bytes.")

    suffix = _detect_extension(file_bytes)
    parser = TemplateCVParser()
    tmp_path = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(file_bytes)
            tmp_path = tmp.name

        parsed = parser.parse(tmp_path)
        logger.info("Local resume parsing succeeded (%s, %d bytes)", suffix, len(file_bytes))
        return parsed
    except Exception as exc:
        raise RuntimeError(f"Local resume parsing failed: {exc}") from exc
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def parse_resume_from_file(file_path: str) -> Dict[str, Any]:
    """Read a CV file from disk and parse it locally."""
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Template file not found: {file_path}")

    file_bytes = path.read_bytes()
    logger.info("Local parsing for '%s' (%d bytes)", path.name, len(file_bytes))
    return parse_resume_from_bytes(file_bytes)
