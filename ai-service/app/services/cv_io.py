"""
CV Generation — Safe DOCX I/O Utilities
=========================================
Hardened helpers for DOCX zip extraction, repacking, and XML parsing.
All operations validate paths against traversal attacks, enforce size limits,
and guarantee atomic writes (the original file is untouched on failure).
"""

import logging
import os
import re
import shutil
import tempfile
import zipfile
from contextlib import contextmanager
from typing import Generator, List

from lxml import etree

from app.services.cv_errors import CVIOError, CVTemplateError

logger = logging.getLogger("ai_service.cv_io")

# ── Safety limits ────────────────────────────────────────────────────────
MAX_DOCX_BYTES = 50 * 1024 * 1024       # 50 MB
MAX_ZIP_ENTRIES = 2_000                   # sane ceiling for DOCX internals
MAX_SINGLE_XML_BYTES = 20 * 1024 * 1024  # 20 MB per XML part


def validate_zip_members(zf: zipfile.ZipFile) -> None:
    """Reject DOCX archives that contain path-traversal entries or too many files."""
    names = zf.namelist()
    if len(names) > MAX_ZIP_ENTRIES:
        raise CVTemplateError(
            f"DOCX has {len(names)} entries (max {MAX_ZIP_ENTRIES})")
    for name in names:
        # Reject absolute paths and traversal sequences
        if name.startswith('/') or name.startswith('\\'):
            raise CVTemplateError(f"Absolute path in DOCX: {name!r}")
        # Normalise both forward and back slashes before checking
        normalised = name.replace('\\', '/')
        if '..' in normalised.split('/'):
            raise CVTemplateError(f"Path traversal in DOCX: {name!r}")


def validate_docx_structure(path: str) -> None:
    """Verify *path* is a valid DOCX with required internal structure.

    Raises CVTemplateError on any problem.
    """
    if not os.path.isfile(path):
        raise CVTemplateError(f"File not found: {path}")
    size = os.path.getsize(path)
    if size > MAX_DOCX_BYTES:
        raise CVTemplateError(
            f"Template too large ({size // 1024 // 1024} MB, max {MAX_DOCX_BYTES // 1024 // 1024} MB)")
    if not zipfile.is_zipfile(path):
        raise CVTemplateError("File is not a valid DOCX (not a ZIP archive)")
    try:
        with zipfile.ZipFile(path, 'r') as zf:
            validate_zip_members(zf)
            if 'word/document.xml' not in zf.namelist():
                raise CVTemplateError(
                    "ZIP is not a valid DOCX (missing word/document.xml)")
    except zipfile.BadZipFile as exc:
        raise CVTemplateError(f"Corrupt ZIP: {exc}") from exc


@contextmanager
def atomic_docx_write(docx_path: str) -> Generator[str, None, None]:
    """Extract → edit → atomic-repack.

    Yields a temp-dir path.  On success, atomically replaces *docx_path*
    with the repacked content.  On exception the original is left untouched.
    """
    temp_dir = tempfile.mkdtemp(prefix="cv_atomic_")
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            validate_zip_members(zf)
            zf.extractall(temp_dir)
        yield temp_dir
        # Repack to a tmp file, then atomic move
        tmp_docx = docx_path + '.tmp'
        with zipfile.ZipFile(tmp_docx, 'w', zipfile.ZIP_DEFLATED) as zout:
            for root_dir, _dirs, files in os.walk(temp_dir):
                for fname in files:
                    fpath = os.path.join(root_dir, fname)
                    arcname = os.path.relpath(fpath, temp_dir)
                    zout.write(fpath, arcname)
        shutil.move(tmp_docx, docx_path)
    except CVTemplateError:
        raise
    except Exception as exc:
        tmp_docx = docx_path + '.tmp'
        if os.path.exists(tmp_docx):
            os.remove(tmp_docx)
        raise CVIOError(f"DOCX write failed: {exc}", cause=exc) from exc
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def safe_parse_xml(xml_bytes: bytes, *, label: str = "XML") -> etree._Element:
    """Parse XML bytes with size guard and clear error message."""
    if len(xml_bytes) > MAX_SINGLE_XML_BYTES:
        raise CVTemplateError(
            f"{label} too large ({len(xml_bytes)} bytes, max {MAX_SINGLE_XML_BYTES})")
    try:
        return etree.fromstring(xml_bytes)
    except etree.XMLSyntaxError as exc:
        raise CVTemplateError(f"Malformed {label}: {exc}") from exc


def xml_files_in_docx(docx_path: str) -> List[str]:
    """Return arc-names of all word/*.xml parts inside *docx_path*."""
    with zipfile.ZipFile(docx_path, 'r') as zf:
        return [n for n in zf.namelist()
                if n.startswith('word/') and n.endswith('.xml')]


def xml_safe_text(text: str) -> str:
    """Sanitise *text* for insertion into an OOXML ``<w:t>`` element.

    Strips control characters illegal in XML 1.0.  Does **not** escape ``&``
    or ``<`` because lxml handles that automatically when setting ``.text``.
    """
    if not text:
        return text
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', text)
