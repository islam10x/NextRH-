"""
Resume Parser Service — APILayer Integration
=============================================
Calls the APILayer Resume Parser API with a DOCX (or PDF) file binary
and returns the structured JSON response with all detected CV fields.

Usage:
    from app.services.resume_parser_service import parse_resume_from_file, parse_resume_from_bytes

    parsed = parse_resume_from_file("path/to/cv.docx")
    # or
    parsed = parse_resume_from_bytes(raw_bytes)
"""

import json
import logging
from pathlib import Path
from typing import Any, Dict

import requests

from app.config import settings

logger = logging.getLogger("ai_service.resume_parser")

_APILAYER_ENDPOINT = "https://api.apilayer.com/resume_parser/upload"
_REQUEST_TIMEOUT_SECONDS = 30


def parse_resume_from_bytes(file_bytes: bytes) -> Dict[str, Any]:
    """
    Send raw DOCX or PDF binary to the APILayer Resume Parser API.

    Returns the full structured JSON response on success.
    Raises RuntimeError with a clear message on:
      - missing API key
      - HTTP 401 (wrong/expired key)
      - HTTP 422 (unsupported file format)
      - connection timeout
      - any other HTTP error

    Logs the full JSON response at INFO level for debugging during development.
    """
    api_key = settings.APILAYER_API_KEY
    if not api_key:
        raise RuntimeError(
            "APILAYER_API_KEY is not configured. "
            "Add APILAYER_API_KEY=<your_key> to your .env file."
        )

    headers = {
        "Content-Type": "application/octet-stream",
        "apikey": api_key,
    }

    try:
        response = requests.post(
            _APILAYER_ENDPOINT,
            headers=headers,
            data=file_bytes,
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
    except requests.Timeout:
        raise RuntimeError(
            f"APILayer resume parser timed out after {_REQUEST_TIMEOUT_SECONDS}s. "
            "Check your network connection."
        )
    except requests.ConnectionError as exc:
        raise RuntimeError(f"APILayer connection failed: {exc}")

    if response.status_code == 401:
        raise RuntimeError(
            "APILayer rejected the API key (HTTP 401 Unauthorized). "
            "Please regenerate your key at https://apilayer.com and update APILAYER_API_KEY in .env."
        )
    if response.status_code == 403:
        raise RuntimeError(
            "APILayer key is valid but not subscribed to the Resume Parser API (HTTP 403). "
            "Subscribe at https://apilayer.com/marketplace/resume_parser-api (free plan available)."
        )
    if response.status_code == 422:
        raise RuntimeError(
            "APILayer could not process the uploaded file (HTTP 422 Unprocessable Entity). "
            "Ensure the file is a valid DOCX or PDF and is not password-protected."
        )
    if not response.ok:
        raise RuntimeError(
            f"APILayer returned HTTP {response.status_code}: {response.text[:300]}"
        )

    try:
        parsed = response.json()
    except ValueError as exc:
        raise RuntimeError(
            f"APILayer returned a non-JSON response (could not decode): {exc}. "
            f"Raw response: {response.text[:200]}"
        )

    # Full debug log — useful during development to inspect every detected field
    logger.info(
        "APILayer parsed response:\n%s",
        json.dumps(parsed, ensure_ascii=False, indent=2)[:3000],
    )

    return parsed


def parse_resume_from_file(file_path: str) -> Dict[str, Any]:
    """
    Read a DOCX or PDF file from disk and send it to the APILayer Resume Parser.

    Returns the structured JSON response.
    Raises FileNotFoundError if the file does not exist.
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Template file not found: {file_path}")

    file_bytes = path.read_bytes()
    logger.info(
        "Sending '%s' (%d bytes) to APILayer Resume Parser",
        path.name,
        len(file_bytes),
    )
    return parse_resume_from_bytes(file_bytes)
