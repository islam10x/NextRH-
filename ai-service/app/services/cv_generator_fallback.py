"""
CV Generation Service (Production-Ready)
=========================================
Handles DOCX templates with complex layouts including textboxes, shapes, tables.
Uses lxml paragraph-level text joining to handle Word's run-splitting behavior,
then applies replacements across runs while preserving formatting.
"""

import copy
import hashlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unicodedata
import zipfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from lxml import etree
from docx import Document
from docxtpl import DocxTemplate
from jinja2.exceptions import TemplateError
from PIL import Image
from groq import Groq

from app.config import settings
from app.services.translation_service import translate_cv_best_effort
from app.services.cv_validation import validate_employee_data, ValidationReport
from app.services.cv_generation_context import GenerationContext
from app.services.field_mapping_service import build_replacement_map as build_apilayer_replacement_map, get_template_summary
from app.services.resume_parser_service import parse_resume_from_file
from app.services.cv_errors import (
    CVGenerationError, CVValidationError, CVTemplateError,
    CVIOError, CVRenderError, CVExportError, CVExternalError,
)
from app.services.cv_io import (
    validate_zip_members, validate_docx_structure, atomic_docx_write,
    safe_parse_xml, xml_safe_text, xml_files_in_docx,
)

logger = logging.getLogger("ai_service.cv_generator")

_GROQ_RATE_LIMIT_COOLDOWN_UNTIL = 0.0
_GROQ_RATE_LIMIT_REASON = ""


def _groq_retry_after_seconds(message: str) -> float:
    """Extract a server-provided Groq retry delay when available."""
    msg = (message or "").lower()
    match = re.search(r'try again in\s*(?:(\d+)m)?\s*([\d.]+)s', msg)
    if not match:
        return 0.0
    minutes = int(match.group(1) or 0)
    seconds = float(match.group(2) or 0.0)
    return minutes * 60 + seconds


def _is_groq_rate_limit_error(exc: Exception) -> bool:
    """Return True when the Groq failure is quota/rate-limit related."""
    msg = str(exc).lower()
    return any(
        marker in msg
        for marker in (
            "rate_limit",
            "rate limit",
            "429",
            "tokens per day",
            "rate_limit_exceeded",
            "please try again in",
            "quota",
            "cooldown active",
        )
    )


def _is_groq_soft_fallback_error(exc: Exception) -> bool:
    """Return True when Groq failure should degrade quietly to deterministic fallback."""
    return _is_groq_rate_limit_error(exc)


def _distribute_entries_across_boxes(entries: List[List[Dict[str, Any]]], n_boxes: int) -> List[List[Dict[str, Any]]]:
    """Spread logical section entries across available boxes without collapsing into one."""
    if n_boxes <= 0:
        return []
    if not entries:
        return [[] for _ in range(n_boxes)]
    if len(entries) <= n_boxes:
        return [entries[i] if i < len(entries) else [] for i in range(n_boxes)]

    base = len(entries) // n_boxes
    extra = len(entries) % n_boxes
    grouped: List[List[Dict[str, Any]]] = []
    entry_idx = 0

    for box_idx in range(n_boxes):
        take = base + (1 if box_idx < extra else 0)
        flattened: List[Dict[str, Any]] = []
        for _ in range(take):
            flattened.extend(entries[entry_idx])
            entry_idx += 1
        grouped.append(flattened)

    return grouped


def _build_apilayer_template_pairs(
    template_path: str,
    employee: Dict[str, Any],
) -> List[Tuple[str, str]]:
    """Best-effort APILayer-based replacement pairs for template values.

    This supplements the deterministic detector with structured template parsing
    when an APILayer key is configured. It does not affect layout or styling,
    only the old→new text pairs applied by the existing replacement engine.
    """
    if not settings.APILAYER_API_KEY:
        return []
    if not template_path.lower().endswith((".docx", ".pdf")):
        return []

    parsed_template = parse_resume_from_file(template_path)
    pairs = list(build_apilayer_replacement_map(parsed_template, employee))

    template_summary = get_template_summary(parsed_template)
    employee_summary = str(employee.get("summary") or "").strip()
    if template_summary and template_summary != employee_summary:
        existing_olds = {old for old, _new in pairs}
        if template_summary not in existing_olds:
            pairs.append((template_summary, employee_summary))

    pairs.sort(key=lambda item: len(item[0]), reverse=True)
    return pairs


# ═══════════════════════════════════════════════════════════════════════════
#  Utilities — Safe file handling & XML safety
# ═══════════════════════════════════════════════════════════════════════════

def _xml_safe_text(text: str) -> str:
    """Ensure text is safe for insertion into OOXML <w:t> elements.

    Strips control characters (except tab/newline/carriage-return) that would
    make the XML unparseable.  Does NOT escape &/</> because lxml's
    etree.tostring handles that automatically.
    """
    if not text:
        return text
    # Strip characters that are illegal in XML 1.0
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', text)




@contextmanager
def _atomic_docx_write(docx_path: str):
    """Context manager for safe DOCX modification via extract→edit→repack.

    Extracts the DOCX to a temp dir, yields the temp dir path, then
    atomically repacks and replaces the original file.  If any exception
    occurs during the edit phase, the original file is left untouched.

    Usage:
        with _atomic_docx_write(docx_path) as tmp:
            # edit files in tmp/word/document.xml etc.
            pass
        # docx_path is now updated atomically
    """
    temp_dir = tempfile.mkdtemp(prefix="cv_atomic_")
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)
        yield temp_dir
        # Repack to a temp file first, then rename (atomic on same filesystem)
        tmp_docx = docx_path + '.tmp'
        with zipfile.ZipFile(tmp_docx, 'w', zipfile.ZIP_DEFLATED) as zout:
            for root_dir, _dirs, files in os.walk(temp_dir):
                for fname in files:
                    fpath = os.path.join(root_dir, fname)
                    arcname = os.path.relpath(fpath, temp_dir)
                    zout.write(fpath, arcname)
        # Atomic replace
        shutil.move(tmp_docx, docx_path)
    except Exception:
        # Clean up temp docx if it was created
        tmp_docx = docx_path + '.tmp'
        if os.path.exists(tmp_docx):
            os.remove(tmp_docx)
        raise
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def _compute_input_hash(template_path: str, employee_data: Dict[str, Any]) -> str:
    """Compute a deterministic hash of inputs for idempotency verification."""
    h = hashlib.sha256()
    with open(template_path, 'rb') as f:
        h.update(f.read())
    # Sort keys for deterministic JSON serialization
    h.update(json.dumps(employee_data, sort_keys=True, default=str).encode('utf-8'))
    return h.hexdigest()[:16]

# Namespace URIs used in OOXML
NS_W  = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS_A  = 'http://schemas.openxmlformats.org/drawingml/2006/main'
NS_R  = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS_WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'
NS_WP  = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
NS_MC  = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
NS_V   = 'urn:schemas-microsoft-com:vml'

# Fully-qualified tag for a WordprocessingML shape textbox
_WPS_TXBX = f'{{{NS_WPS}}}txbx'
_XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space'

NSMAP = {
    'w': NS_W,
    'a': NS_A,
    'r': NS_R,
}


# ═══════════════════════════════════════════════════════════════════════════
#  Pre-processing — SDT dissolution & layout table detection
# ═══════════════════════════════════════════════════════════════════════════

def _dissolve_sdts(tree: Any) -> int:
    """Remove Structured Document Tag (content control) wrappers in-place.

    Word templates wrap editable regions in ``<w:sdt>`` elements.  These
    wrappers make downstream paragraph/run iteration harder.  This function
    promotes each ``<w:sdtContent>``'s children to the SDT's parent position,
    effectively removing the wrapper while keeping all inner content and
    formatting intact.

    Processes deepest SDTs first (reverse document order) so that nested
    SDTs are dissolved before their parents.

    Returns the number of SDTs dissolved.
    """
    W = NS_W
    SDT = f'{{{W}}}sdt'
    SDT_CONTENT = f'{{{W}}}sdtContent'

    sdts = list(tree.iter(SDT))
    if not sdts:
        return 0

    # Process deepest-first to avoid parent invalidation
    sdts.reverse()
    dissolved = 0

    for sdt in sdts:
        parent = sdt.getparent()
        if parent is None:
            continue
        sdt_content = sdt.find(SDT_CONTENT)
        if sdt_content is None:
            continue

        idx = list(parent).index(sdt)
        children = list(sdt_content)
        for i, child in enumerate(children):
            parent.insert(idx + i, child)

        parent.remove(sdt)
        dissolved += 1

    return dissolved


def _dissolve_sdts_in_docx(docx_path: str) -> int:
    """Dissolve all SDT content controls in a DOCX file on disk.

    Opens the DOCX, dissolves SDTs in every ``word/*.xml`` file
    (document.xml, headers, footers, glossary), and writes back.

    Returns total number of SDTs dissolved.
    """
    temp_dir = tempfile.mkdtemp()
    total = 0

    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            validate_zip_members(zf)
            zf.extractall(temp_dir)

        any_changed = False
        word_dir = os.path.join(temp_dir, 'word')
        if not os.path.isdir(word_dir):
            return 0

        for xml_root, _dirs, xml_files in os.walk(word_dir):
            for xml_name in xml_files:
                if not xml_name.endswith('.xml'):
                    continue
                xml_path = os.path.join(xml_root, xml_name)
                with open(xml_path, 'rb') as f:
                    raw = f.read()
                try:
                    tree = etree.fromstring(raw)
                except etree.XMLSyntaxError as exc:
                    logger.warning(f"Malformed XML in {xml_name} during SDT dissolution: {exc}")
                    continue

                count = _dissolve_sdts(tree)
                if count > 0:
                    with open(xml_path, 'wb') as f:
                        f.write(etree.tostring(
                            tree, xml_declaration=True,
                            encoding='UTF-8', standalone=True,
                        ))
                    any_changed = True
                    total += count

        if any_changed:
            with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for root_dir, _dirs, files in os.walk(temp_dir):
                    for fname in files:
                        fpath = os.path.join(root_dir, fname)
                        arcname = os.path.relpath(fpath, temp_dir)
                        zout.write(fpath, arcname)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return total


def _is_layout_table(tbl: Any, body: Any) -> bool:
    """Detect whether a ``<w:tbl>`` is used as a page-layout container.

    Layout tables create multi-column CV layouts (sidebar + main area) using
    a single table with merged cells.  They differ from data tables (which
    hold tabular experience/education rows) in that:

    * They are the sole/dominant content element in ``<w:body>``.
    * They have 3+ grid columns with varying widths (sidebar vs. main).
    * Their cells contain CV section headings (Formation, Expérience …).
    """
    W = NS_W

    # Heuristic 1: almost no text outside the table
    body_elements = [c for c in body if c.tag != f'{{{W}}}sectPr']
    body_paras_with_text = 0
    for c in body_elements:
        if c.tag == f'{{{W}}}p':
            texts = [t.text for t in c.iter(f'{{{W}}}t') if t.text]
            if ''.join(texts).strip():
                body_paras_with_text += 1
    if body_paras_with_text > 2:
        return False

    # Heuristic 2: table should have 2+ grid columns (sidebar + main area is common 2-col layout)
    grid_cols = tbl.findall(f'{{{W}}}tblGrid/{{{W}}}gridCol')
    if len(grid_cols) < 2:
        return False

    # Heuristic 3: cells contain section-heading-like text
    section_kws: set = set()
    for kw_list in _SECTION_MAP.values():
        for kw in kw_list:
            section_kws.add(kw.lower())

    section_like_count = 0
    for tc in tbl.iter(f'{{{W}}}tc'):
        cell_paras = tc.findall(f'{{{W}}}p')
        for cp in cell_paras:
            texts = [t.text for t in cp.iter(f'{{{W}}}t') if t.text]
            line = ''.join(texts).strip()
            if not line or len(line) > 50:
                continue
            line_lower = re.sub(r'\s+', ' ', line).lower()
            for kw in section_kws:
                if (line_lower == kw
                        or line_lower.startswith(kw + ' ')
                        or line_lower.startswith(kw + ':')):
                    section_like_count += 1
                    break

    return section_like_count >= 2


def _get_layout_table(body: Any) -> Optional[Any]:
    """Return the layout table in ``<w:body>``, or ``None``."""
    W = NS_W
    for child in body:
        if child.tag == f'{{{W}}}tbl' and _is_layout_table(child, body):
            return child
    return None


def _identify_section_from_text(text: str) -> Optional[str]:
    """Lightweight section identification from a plain-text string.

    Used when we don't have access to a ``<w:p>`` element.  Matches against
    ``_SECTION_MAP`` keywords, preferring exact matches and short texts.
    """
    t = re.sub(r'\s+', ' ', text.strip().lower()
               ).replace('\u2019', "'").replace('\u2018', "'").replace('\u00a0', ' ')
    if not t or len(t) > 50:
        return None
    for section, keywords in _SECTION_MAP.items():
        for kw in keywords:
            if t == kw or t.startswith(kw + ' ') or t.startswith(kw + ':'):
                return section
    return None


def _replace_sections_in_layout_table(
    tbl: Any, body: Any, employee: Dict[str, Any], preferred_language: Optional[str] = None,
) -> int:
    """Replace CV section content inside a layout-table's cells.

    Iterates through table cells, detects section headings, and replaces
    the content paragraphs that follow each heading with employee data.

    When a cell contains multiple sections (e.g. "Communication" +
    "Direction"), each section's content is replaced independently.

    Returns the number of sections replaced.
    """
    W = NS_W
    replaced = 0

    for tc in tbl.iter(f'{{{W}}}tc'):
        cell_paras = list(tc.findall(f'{{{W}}}p'))
        if not cell_paras:
            continue

        # Detect section headings within this cell
        cell_sections: List[Tuple[int, str, Any]] = []  # (idx, section_name, para_el)
        for ci, cp in enumerate(cell_paras):
            sec = _identify_section_lxml(cp)
            if sec:
                cell_sections.append((ci, sec, cp))

        if not cell_sections:
            continue

        # Process each section in reverse order (so index shifts don't matter)
        for si in range(len(cell_sections) - 1, -1, -1):
            sec_idx, section_name, heading_el = cell_sections[si]

            # Content = paragraphs between this heading and the next (or end of cell)
            if si + 1 < len(cell_sections):
                next_sec_idx = cell_sections[si + 1][0]
            else:
                next_sec_idx = len(cell_paras)

            content_paras = cell_paras[sec_idx + 1: next_sec_idx]

            new_content = _build_section_content(section_name, employee, preferred_language)
            if new_content is None:
                # No employee data — remove existing content
                for elem in content_paras:
                    try:
                        tc.remove(elem)
                    except ValueError:
                        pass
                logger.info(
                    "  [layout-table] section='%s' heading=%r: removed %d content paragraph(s) because employee data is empty",
                    section_name,
                    _paragraph_plain_text(heading_el),
                    len(content_paras),
                )
                replaced += 1
                continue

            rendered_paras = _render_section_paragraphs(
                new_content,
                content_paras,
                heading_elem=heading_el,
            )

            # Remove old content paragraphs
            for elem in content_paras:
                try:
                    tc.remove(elem)
                except ValueError:
                    pass

            # Insert new content after heading
            insert_after = heading_el
            for new_p in rendered_paras:
                insert_after.addnext(new_p)
                insert_after = new_p

            replaced += 1
            logger.info(
                "  [layout-table] section='%s' heading=%r: inserted %d item(s)",
                section_name,
                _paragraph_plain_text(heading_el),
                len(rendered_paras),
            )

    return replaced


# ═══════════════════════════════════════════════════════════════════════════
#  Phase 1 — Paragraph-level text extraction (joining split runs)
# ═══════════════════════════════════════════════════════════════════════════

def _get_paragraph_texts(xml_bytes: bytes) -> List[str]:
    """
    Parse an OOXML file and return one string per paragraph,
    built by joining <w:t> / <a:t> runs inside each <w:p> / <a:p>.

    CRITICAL: Only collects OWN-level text for each paragraph — does NOT
    descend into nested <w:p> (textbox content) or mc:Fallback (VML
    duplicates).  This prevents body paragraphs from grabbing text that
    belongs to embedded textboxes and avoids counting VML fallback copies.
    """
    root = etree.fromstring(xml_bytes)
    paragraphs = []

    WP = f'{{{NS_W}}}p'
    WT = f'{{{NS_W}}}t'
    WR = f'{{{NS_W}}}r'
    MC_FALLBACK = f'{{{NS_MC}}}Fallback'

    def _own_texts_w(para):
        """Yield text strings from <w:t> at THIS paragraph level only.

        Stops descending at nested <w:p> (textbox content) and mc:Fallback
        (VML duplicate layer) to avoid double-counting.  For <w:r> elements,
        only direct <w:t> children are collected (not <w:t> buried inside
        <w:drawing>/<wps:txbx>).
        """
        def _walk(elem):
            for child in elem:
                tag = child.tag
                if tag == WP or tag == MC_FALLBACK:
                    continue          # nested paragraph or VML fallback — skip
                if tag == WR:
                    # Only direct <w:t> children of this run (not nested ones)
                    for sub in child:
                        if sub.tag == WT and sub.text:
                            yield sub.text
                else:
                    yield from _walk(child)
        yield from _walk(para)

    def _is_in_fallback(elem) -> bool:
        """Check if element is inside mc:Fallback (VML duplicate)."""
        parent = elem.getparent()
        while parent is not None:
            if parent.tag == MC_FALLBACK:
                return True
            parent = parent.getparent()
        return False

    # Word paragraphs (<w:p>)
    for wp in root.iter(WP):
        if _is_in_fallback(wp):
            continue                  # Skip VML fallback paragraphs entirely
        texts = list(_own_texts_w(wp))
        if texts:
            paragraphs.append(''.join(texts))

    # DrawingML / textbox paragraphs (<a:p>)
    # Skip <a:p> inside mc:AlternateContent (already covered by WPS <w:p> above)
    AP = f'{{{NS_A}}}p'
    AT = f'{{{NS_A}}}t'
    MC_AC = f'{{{NS_MC}}}AlternateContent'
    for ap in root.iter(AP):
        parent = ap.getparent()
        in_mc = False
        while parent is not None:
            if parent.tag == MC_AC or parent.tag == MC_FALLBACK:
                in_mc = True
                break
            parent = parent.getparent()
        if in_mc:
            continue
        texts = [t.text for t in ap.iter(AT) if t.text]
        if texts:
            paragraphs.append(''.join(texts))

    return paragraphs


def _extract_all_text(docx_path: str) -> Tuple[str, List[str]]:
    """
    Extract ALL text from a DOCX at paragraph level.
    Returns (full_text, list_of_paragraph_strings).
    Handles textboxes, shapes, headers, footers — everything.
    """
    all_paragraphs: List[str] = []
    temp_dir = tempfile.mkdtemp()

    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            validate_zip_members(zf)
            zf.extractall(temp_dir)

        for root_dir, _dirs, files in os.walk(temp_dir):
            for fname in files:
                if not fname.endswith('.xml'):
                    continue
                fpath = os.path.join(root_dir, fname)
                try:
                    with open(fpath, 'rb') as f:
                        xml_bytes = f.read()
                    paras = _get_paragraph_texts(xml_bytes)
                    all_paragraphs.extend(paras)
                except etree.XMLSyntaxError as exc:
                    # Log malformed XML at warning level — not just debug
                    logger.warning(f"Malformed XML in {fname}: {exc}")
                except Exception as exc:
                    logger.warning(f"Skipping {fname}: {exc}")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    full = '\n'.join(all_paragraphs)
    logger.debug(
        f"Extracted {len(all_paragraphs)} paragraphs ({len(full)} chars) from template"
    )
    return full, all_paragraphs


# ═══════════════════════════════════════════════════════════════════════════
#  Phase 2 — Detect personal info in the JOINED paragraph text
# ═══════════════════════════════════════════════════════════════════════════

def _detect_personal_info(
    full_text: str, paragraphs: List[str]
) -> Dict[str, str]:
    """
    Detect personal information in template text.

    Improvements over naïve approach:
    1. Clean-email scan  — find the shortest paragraph that IS just an email.
       Avoids the greedy regex picking up garbage like nom.prenomEmailfoo@bar.com
       when labels and values are concatenated in a single textbox paragraph.
    2. Wide name scan    — scan ALL paragraphs (not just ±5 around email) so that
       names like PAULINE TROTTIER at para[59] are found even when the email is
       at para[34].
    3. Placeholder patterns — detect common French/English CV template placeholders
       (PRÉNOM NOM, Ville pays, /nom.prenom, Poste Occupé / Recherché …) and map
       them to the corresponding employee fields.
    4. Name-from-email   — last resort: parse the email local part (firstname.lastname)
       into a name candidate.
    """
    detected: Dict[str, str] = {}

    # ── Step 0: Textbox-fragment reassembly ─────────────────────────
    # Infographic templates (e.g. Canadian CV) split contact info across
    # many tiny textbox paragraphs: "LUCAS" / "LEBLANC" / "555" / "555" /
    # "5555" / "lucas.leblanc" / "@courriel.ca" — each in its OWN <w:p>.
    # No single paragraph contains a full email, phone, or name.
    # We reassemble adjacent fragments to create synthetic paragraphs that
    # the downstream steps can detect normally.
    _assembled_email = ''
    _assembled_phone = ''
    _assembled_name = ''
    _assembled_linkedin = ''
    _fragment_email_idx: Optional[int] = None  # index of '@' paragraph in originals

    for i, p in enumerate(paragraphs):
        ps = p.strip()
        # Email: paragraph starts with "@" → local part is a nearby previous paragraph
        if ps.startswith('@') and not _assembled_email:
            # Look back up to 3 paragraphs (there may be empty/whitespace paras in between)
            for back in range(1, min(4, i + 1)):
                local = paragraphs[i - back].strip()
                if local and re.fullmatch(r'[\w.+\-]+', local) and '@' not in local:
                    _assembled_email = local + ps
                    _fragment_email_idx = i
                    logger.info(f"Reassembled [email] from fragments: {_assembled_email}")
                    break
        # LinkedIn: paragraph is "linkedin.com/" → slug follows
        # Only reassemble when the URL is INCOMPLETE (no slug after /in/).
        _li_m = re.match(r'^(?:https?://)?(?:www\.)?linkedin\.com/(?:in/)?(.*)$', ps, re.I)
        if _li_m and i + 1 < len(paragraphs):
            existing_slug = _li_m.group(1).strip()
            # If URL already has a full slug (3+ chars), no need to scan forward
            if len(existing_slug) < 3:
                slug_parts = []
                for j in range(i, min(i + 6, len(paragraphs))):
                    sp = paragraphs[j].strip()
                    if not sp:
                        # Empty paragraph = boundary, stop scanning
                        if j > i:
                            break
                        continue
                    # Stop if paragraph looks like content (long, sentence-like)
                    if j > i and (len(sp) > 40 or ' ' in sp):
                        break
                    slug_parts.append(sp)
                    if len(''.join(slug_parts)) > 60:
                        break
                combined = ''.join(slug_parts)
                if 'linkedin.com' in combined.lower():
                    _assembled_linkedin = combined
                    logger.info(f"Reassembled [linkedin] from fragments: {_assembled_linkedin}")

    # Phone: find runs of paragraphs that are only digits (3+ consecutive,
    # allowing empty/whitespace/separator ("-", ".", " ") paragraphs in between
    # — common in textbox templates where "555" / "-" / "555" / "-" / "5555")
    digit_run: List[Tuple[int, str]] = []
    gap_count = 0
    for i, p in enumerate(paragraphs):
        ps = p.strip()
        if ps and re.fullmatch(r'\d+', ps):
            digit_run.append((i, ps))
            gap_count = 0
        elif not ps or ps in ('-', '.', '–', '—', ' ', '(', ')'):
            # Allow separators and empty paragraphs between digit groups
            gap_count += 1
            if gap_count > 3 and digit_run:
                combined_digits = ''.join(d for _, d in digit_run)
                if 7 <= len(combined_digits) <= 15:
                    _assembled_phone = '-'.join(d for _, d in digit_run)
                    logger.info(f"Reassembled [phone] from fragments: {_assembled_phone}")
                    break
                digit_run = []
                gap_count = 0
        else:
            if len(digit_run) >= 2:
                combined_digits = ''.join(d for _, d in digit_run)
                if 7 <= len(combined_digits) <= 15:
                    _assembled_phone = '-'.join(d for _, d in digit_run)
                    logger.info(f"Reassembled [phone] from fragments: {_assembled_phone}")
                    break
            digit_run = []
            gap_count = 0
    # Check leftover digit_run at end of loop
    if not _assembled_phone and len(digit_run) >= 2:
        combined_digits = ''.join(d for _, d in digit_run)
        if 7 <= len(combined_digits) <= 15:
            _assembled_phone = '-'.join(d for _, d in digit_run)
            logger.info(f"Reassembled [phone] from fragments: {_assembled_phone}")

    # Name: find adjacent short ALL-CAPS or Capitalized word paragraphs
    # that together look like "FIRST" + "LAST" (common in textbox layouts)
    _assembled_address = ''
    if not _assembled_email:
        pass  # only try name assembly when we know we have fragmented contact info
    else:
        # Address: look for ", Country" paragraph preceded by "City"
        for i, p in enumerate(paragraphs):
            ps = p.strip()
            if ps.startswith(',') and len(ps) < 30 and i > 0:
                city = paragraphs[i - 1].strip()
                if city and len(city) < 30 and city[0].isupper() and city.replace(' ', '').replace('-', '').replace("'", '').isalpha():
                    _assembled_address = city + ps
                    logger.info(f"Reassembled [address] from fragments: {_assembled_address}")
                    break

        # Build synthetic paragraphs from reassembled fragments
        # so downstream Steps 1-6 can detect them
        if _assembled_email and _assembled_email not in '\n'.join(paragraphs):
            paragraphs = list(paragraphs) + [_assembled_email]
        if _assembled_phone and _assembled_phone not in '\n'.join(paragraphs):
            paragraphs = list(paragraphs) + [_assembled_phone]
        if _assembled_linkedin:
            # Pre-set detected linkedin so Step 2 doesn't miss it
            detected['linkedin'] = _assembled_linkedin.rstrip('/')
            if _assembled_linkedin not in '\n'.join(paragraphs):
                paragraphs = list(paragraphs) + [_assembled_linkedin]
        if _assembled_address:
            # Pre-set detected address so Step 2 doesn't miss it
            detected['address'] = _assembled_address
            if _assembled_address not in '\n'.join(paragraphs):
                paragraphs = list(paragraphs) + [_assembled_address]
        full_text = '\n'.join(paragraphs)

        # Also try to reassemble name from short adjacent paragraphs near
        # the email fragment.  Look for 2 adjacent short ALL-CAPS or
        # Capitalized paragraphs near the domain paragraph.
        at_idx = None
        for i, p in enumerate(paragraphs):
            if p.strip().startswith('@'):
                at_idx = i
                break
        if at_idx is not None:
            # Scan backwards from the email to find name candidates
            window_start = max(0, at_idx - 20)
            for j in range(window_start, at_idx):
                p1 = paragraphs[j].strip()
                if not p1 or len(p1) > 20 or not p1.replace("'", '').replace('-', '').isalpha():
                    continue
                # Look ahead for a second name part
                for k in range(j + 1, min(j + 3, at_idx)):
                    p2 = paragraphs[k].strip()
                    if not p2 or len(p2) > 20 or not p2.replace("'", '').replace('-', '').isalpha():
                        continue
                    # Skip whitespace-only or short non-alpha
                    if len(p2) < 2:
                        continue
                    combined_name = f"{p1} {p2}"
                    words = combined_name.split()
                    if len(words) == 2 and all(w[0].isupper() for w in words):
                        _assembled_name = combined_name
                        logger.info(f"Reassembled [name] from fragments: {_assembled_name}")
                        # Inject as synthetic paragraph
                        paragraphs = list(paragraphs) + [_assembled_name]
                        full_text = '\n'.join(paragraphs)
                        # Pre-set detected name so downstream steps don't
                        # misidentify another fragment (e.g. job title) as name
                        detected['name'] = _assembled_name
                        detected['first_name_text'] = p1
                        detected['last_name_text'] = p2
                        break
                if _assembled_name:
                    break

    # ── Common placeholder patterns used by French/English CV template sites ──
    _PH_NAME = re.compile(
        r'^(?:PRÉNOM\s+NOM|PRENOM\s+NOM|PRÉNOM\s+PRÉNOM\s+NOM|'
        r'FIRST\s+LAST|FirstName\s+LastName|Prénom\s+Nom|'
        r'prénom\s+nom|NOM\s+Prénom|PRÉNOM\s+PRÉNOM\sSurname)$', re.I
    )
    _PH_TITLE = re.compile(
        r'^(?:Poste\s+Occup[eé]\s*/?\s*Recherch[eé]|'
        r'POSTE\s+OCCUP[EÉ]\s*/?\s*RECHERCH[EÉ]|'
        r'Intitul[eé]\s+du\s+poste|Titre\s+du\s+poste|'
        r'Votre\s+poste|Job\s+Title|Your\s+Title|'
        r'Poste\s+souhait[eé])$', re.I
    )
    _PH_ADDRESS = re.compile(
        r'^(?:Ville,?\s*[Pp]ays|City,?\s*Country|Localisation|'
        r'Location|Votre\s+adresse|Adresse\s+complète|'
        r'City,?\s*State|City\s+Country|Ville\s+pays)$', re.I
    )
    _PH_LINKEDIN_PATH = re.compile(
        r'^/?(?:nom\.prenom|firstname\.lastname|prenom\.nom|'
        r'your[-.]?name|votre[-.]?nom)$|^/linkedin$', re.I
    )
    _PH_PHONE = re.compile(
        r'^(?:T[eé]l[eé]phone|T[eé]l\.?|Phone|Mobile|Mob\.|Num[eé]ro)$', re.I
    )

    # ── Step 1: Clean-email scan ──────────────────────────────────────
    # First pass: look for a paragraph that looks like JUST an email address.
    # This is more reliable than running the greedy regex on a massive
    # concatenated paragraph that contains labels + values.
    _clean_email_re = re.compile(
        r'^[a-zA-Z0-9][a-zA-Z0-9._%+\-]*@[a-zA-Z0-9][\w\-]*'
        r'(?:\.[a-zA-Z0-9][\w\-]*)*\.[a-zA-Z]{2,}$'
    )
    email_idx: Optional[int] = None
    for i, p in enumerate(paragraphs):
        ps = p.strip()
        if '@' in ps and len(ps) < 80:
            # Normalize stray spaces around '@' (common in textbox templates)
            ps_norm = re.sub(r'\s*@\s*', '@', ps)
            if _clean_email_re.match(ps_norm):
                detected['email'] = ps_norm
                email_idx = i
                logger.info(f"Detected [email] (clean scan): {ps_norm}")
                break

    # If email was found via a synthetic paragraph injected at the end,
    # prefer the original fragment index so proximity-based scans (title,
    # name) work correctly with the actual template layout.
    if _fragment_email_idx is not None and email_idx is not None:
        if email_idx >= len(paragraphs) - 5:  # synthetic paragraphs live near end
            email_idx = _fragment_email_idx
            logger.info(f"Using fragment email_idx={email_idx} for proximity scans")

    # ── Step 1b: If no clean paragraph found, build a contact block ──
    contact_block = ''
    if 'email' not in detected:
        # First try: long paragraph with @ + 3-digit group (joined textbox)
        for i, p in enumerate(paragraphs):
            stripped = p.strip()
            if '@' in stripped and re.search(r'\d{3}', stripped) and len(stripped) > 80:
                contact_block = stripped
                # Find email idx for later name scan
                m = re.search(r'[\w.+-]+\s*@\s*[\w-]+\.[\w.-]+', stripped)
                if m:
                    # Validate: local part should not be a keyword+email concatenation
                    local = m.group().split('@')[0]
                    # If local part ends with common label words, it's garbage
                    if not re.search(r'(?:Email|Mobile|Phone|Linkedin|LinkedIn)$', local, re.I):
                        detected['email'] = m.group()
                        email_idx = i
                        logger.info(f"Detected [email] (contact block): {detected['email']}")
                break

        # Fallback: vicinity search around first paragraph containing @
        if not contact_block:
            for i, p in enumerate(paragraphs):
                if '@' in p and re.search(r'[\w.+-]+\s*@\s*[\w-]+\.[\w.-]+', p):
                    email_idx = i
                    start = max(0, i - 4)
                    end = min(len(paragraphs), i + 5)
                    short_vicinity = [
                        para for para in paragraphs[start:end]
                        if len(para.strip()) <= 150
                    ]
                    vicinity = '\n'.join(short_vicinity)
                    # Section-heading cut: only match STANDALONE heading
                    # lines (≤5 words) to avoid false positives on job
                    # titles like "CHARGÉ DE PROJETS TI".
                    _sec_heading_re = re.compile(
                        r'^\s*(?:professional\s+summary|summary|profile|objective|'
                        r'experience|expérience|education|formation|skills|'
                        r'compétences|projects|projets|certifications|languages|'
                        r'langues|interests)\s*:?\s*$', re.I | re.M
                    )
                    _sec_cut = _sec_heading_re.search(vicinity)
                    if _sec_cut:
                        vicinity = vicinity[:_sec_cut.start()]
                    if vicinity.strip():
                        contact_block = vicinity.strip()
                    break

        # Extract email from contact block if not yet found
        if 'email' not in detected and contact_block:
            m = re.search(r'[\w.+-]+\s*@\s*[\w-]+\.[\w.-]+', contact_block)
            if m:
                local = m.group().split('@')[0]
                if not re.search(r'(?:Email|Mobile|Phone|LinkedIn)$', local, re.I):
                    detected['email'] = m.group()
                    logger.info(f"Detected [email] (fallback): {detected['email']}")

    # Use contact block or vicinity for remaining field extraction
    if not contact_block:
        # Build vicinity around email_idx when Step 1 found email directly
        if email_idx is not None:
            start = max(0, email_idx - 10)
            end = min(len(paragraphs), email_idx + 10)
            short_vicinity = [
                para for para in paragraphs[start:end]
                if len(para.strip()) <= 150
            ]
            vicinity_text = '\n'.join(short_vicinity).strip()
            # Cut at the first STANDALONE section heading line to avoid
            # mixing in experience/education data.  Must be a whole line
            # to prevent false positives on job titles containing section
            # keywords (e.g. "CHARGÉ DE PROJETS TI").
            _sec_heading_re = re.compile(
                r'^\s*(?:professional\s+summary|summary|profile|objective|'
                r'experience|expérience|expérience\s+professionnelle|'
                r'education|formation|skills|compétences|projects|projets|'
                r'certifications|languages|langues|interests|activités|'
                r'loisirs|centres)\s*:?\s*$', re.I | re.M
            )
            _sec_cut = _sec_heading_re.search(vicinity_text)
            if _sec_cut:
                vicinity_text = vicinity_text[:_sec_cut.start()]
            contact_block = vicinity_text.strip()
        if not contact_block:
            contact_block = full_text

    logger.info(f"Contact block ({len(contact_block)} chars): {contact_block[:120]}...")

    # ── Step 2: Extract phone, linkedin, address from contact block ───
    def _looks_like_address_candidate(value: str) -> bool:
        candidate = (value or '').strip()
        if not candidate:
            return False
        if ':' in candidate:
            return False
        if candidate.count(',') > 2:
            return False
        if re.search(
            r'\b(sql|python|react|docker|hadoop|spark|mongodb|mongo|linux|api|apis|javascript|java|node|android|scikit|fastapi)\b',
            candidate,
            re.I,
        ):
            return False
        return True

    phone_pats = [
        r'\+\d{1,3}(?:[-.\s]?\(?\d{1,4}\)?){2,8}',
        r'\d{3}[-.\s]\d{3}[-.\s]\d{4}',
        r'\d{2}[-.\s]\d{2}[-.\s]\d{2}[-.\s]\d{2}[-.\s]\d{2}',
        r'\d{8,}',
    ]
    for pat in phone_pats:
        m = re.search(pat, contact_block)
        if m and len(re.sub(r'\D', '', m.group())) >= 7:
            detected['phone'] = m.group().strip()
            break

    m = re.search(r'(?:https?://)?(?:www\.)?linkedin\.com/[\w/.\-]+', contact_block, re.I)
    if m:
        detected['linkedin'] = m.group().rstrip('/')

    _addr_zone = contact_block[:500]

    # Priority 1: street-format addresses (e.g., "47 rue des Écoles, 92000 Nanterre")
    _street_m = re.search(
        r'\d+[,\s]+(?:rue|avenue|av\.|boulevard|blvd|chemin|allée|place|impasse|'
        r'passage|cours|quai|route|street|st\.|road|rd\.|drive|dr\.)\b[^\n@]{3,80}',
        _addr_zone, re.I,
    )
    if _street_m:
        detected['address'] = _street_m.group().strip()
    else:
        # Priority 2: Title-Case "City, Country" pattern (same line only — no \n crossing)
        m = re.search(
            r'[A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)?, *[A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)*',
            _addr_zone,
        )
        if m:
            addr = m.group().strip()
            city_part = addr.split(',')[0].strip()
            if len(city_part.split()) <= 2 and '\n' not in addr and _looks_like_address_candidate(addr):
                detected['address'] = addr

        # Priority 3: US/international "City, ST ZIP" or "City, ST" spanning one paragraph
        # Handles patterns like "Madison, WI 12131" that the word-only regex above misses
        if 'address' not in detected:
            us_m = re.search(
                r'(?<!\d)([A-Za-zÀ-ÿ][\w\s\-\']{2,30}),\s*([A-Z]{2,3})\b(?:\s*\d{4,6})?',
                _addr_zone,
            )
            if us_m:
                # Walk back to start of this line in _addr_zone for the complete paragraph
                match_start = us_m.start()
                line_start = _addr_zone.rfind('\n', 0, match_start)
                line_start = 0 if line_start == -1 else line_start + 1
                line_end = _addr_zone.find('\n', match_start)
                line_end = len(_addr_zone) if line_end == -1 else line_end
                full_line = _addr_zone[line_start:line_end].strip()
                if full_line and len(full_line) < 100 and _looks_like_address_candidate(full_line):
                    detected['address'] = full_line
                    # Also record the preceding line (street) for clearing
                    if line_start > 0:
                        prev_end = line_start - 1  # before the \n
                        prev_start = _addr_zone.rfind('\n', 0, prev_end)
                        prev_start = 0 if prev_start == -1 else prev_start + 1
                        prev_line = _addr_zone[prev_start:prev_end].strip()
                        if prev_line and len(prev_line) < 80:
                            detected['address_preceding_line'] = prev_line

    short_paragraphs = [p.strip() for p in paragraphs if 0 < len(p.strip()) <= 120]

    if 'phone' not in detected:
        for para in short_paragraphs:
            for pat in phone_pats:
                m = re.search(pat, para)
                if m and len(re.sub(r'\D', '', m.group())) >= 7:
                    detected['phone'] = m.group().strip()
                    break
            if 'phone' in detected:
                break

    if 'linkedin' not in detected:
        for para in short_paragraphs:
            m = re.search(r'(?:https?://)?(?:www\.)?linkedin\.com/[\w/.\-]+', para, re.I)
            if m:
                detected['linkedin'] = m.group().rstrip('/')
                break

    if 'address' not in detected:
        for para in short_paragraphs:
            _street_m = re.search(
                r'\d+[,\s]+(?:rue|avenue|av\.|boulevard|blvd|chemin|allée|place|impasse|'
                r'passage|cours|quai|route|street|st\.|road|rd\.|drive|dr\.)\b[^\n@]{3,80}',
                para,
                re.I,
            )
            if _street_m:
                detected['address'] = _street_m.group().strip()
                break

            city_country = re.search(
                r'^[A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)?, *[A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)*$',
                para,
            )
            if city_country and len(city_country.group().split(',')[0].split()) <= 2 and _looks_like_address_candidate(city_country.group()):
                detected['address'] = city_country.group().strip()
                break

            us_m = re.search(
                r'(?<!\d)([A-Za-zÀ-ÿ][\w\s\-\']{2,30}),\s*([A-Z]{2,3})\b(?:\s*\d{4,6})?',
                para,
            )
            if us_m and _looks_like_address_candidate(para):
                detected['address'] = para
                break

    for key in ('phone', 'linkedin', 'address'):
        if detected.get(key):
            logger.info("Detected [%s]: %s", key, detected[key])

    # ── Step 3: Extract name + title from contact block ───────────────
    block = contact_block
    sec_m = re.search(
        r'\b(OBJECTIF|EXPÉRIENCE|COMPÉTENCES|FORMATION|LANGUES|'
        r'EXPERIENCE|EDUCATION|SKILLS|SUMMARY|PROFILE)\b', block, re.I
    )
    if sec_m:
        block = block[:sec_m.start()]

    for key in ('email', 'phone', 'linkedin', 'address'):
        if key in detected:
            block = block.replace(detected[key], '')

    # Split on newlines OR 2+ whitespace — after the extraction fix, each
    # paragraph is on its own line, so \n is the primary separator.
    segments = [s.strip() for s in re.split(r'\n|\s{2,}', block) if s.strip()]
    logger.info(f"Contact block segments: {segments}")

    # ── Name utility definitions (used by Steps 3a, 5, and 6) ────────
    _NAME_PARTICLES = frozenset({
        'de', 'd', 'du', 'la', 'le', 'les', 'l', 'von', 'van', 'da', 'di',
        'del', 'della', 'los', 'las', 'al', 'ben', 'bin', 'ibn', 'el', 'y',
        'den', 'ter', 'te', 'der',
    })
    # Common brand/software/tech terms that are never person names
    _NOT_NAMES = frozenset({
        'facebook', 'google', 'wordpress', 'youtube', 'linkedin', 'twitter',
        'instagram', 'tiktok', 'snapchat', 'microsoft', 'apple', 'adobe',
        'ads', 'seo', 'html', 'css', 'pack', 'office', 'php', 'sql', 'api',
        'java', 'python', 'react', 'angular', 'node', 'swift', 'kotlin',
        'tableau', 'excel', 'word', 'powerpoint', 'outlook', 'photoshop',
        'illustrator', 'indesign', 'figma', 'sketch', 'canva', 'wordpress',
    })
    # Section heading keywords — these are NEVER person names
    _HEADING_KEYWORDS = frozenset()
    for _sec_kws in _SECTION_MAP.values():
        _HEADING_KEYWORDS = _HEADING_KEYWORDS | frozenset(_sec_kws)

    def _candidate_looks_like_name(words: List[str]) -> bool:
        if any(w.lower() in _NOT_NAMES for w in words):
            return False
        upper_count = sum(1 for w in words if w[0].isupper())
        bad_lower   = sum(
            1 for w in words
            if not w[0].isupper() and w.lower() not in _NAME_PARTICLES
        )
        return upper_count >= 2 and bad_lower == 0

    _JOB_TITLE_WORDS = frozenset({
        'chargé', 'chargée', 'chef', 'directeur', 'directrice',
        'manager', 'ingénieur', 'ingénieure', 'développeur', 'développeuse',
        'consultant', 'consultante', 'analyste', 'assistant', 'assistante',
        'responsable', 'coordinateur', 'coordinatrice', 'technicien',
        'technicienne', 'architecte', 'designer', 'project', 'senior',
        'junior', 'lead', 'head', 'vp', 'cto', 'ceo', 'cfo',
        'administrateur', 'administratrice', 'spécialiste', 'expert',
        'gestionnaire', 'contrôleur', 'comptable', 'auditeur', 'developer',
        'engineer', 'scientist', 'officer', 'coordinator', 'specialist',
    })

    def _candidate_looks_like_job_title(words: List[str]) -> bool:
        lower_words = [w.lower() for w in words]
        meaningful_words = [w for w in lower_words if w not in _NAME_PARTICLES]
        return any(w in _JOB_TITLE_WORDS for w in meaningful_words)

    def _is_section_heading_text(text: str) -> bool:
        """Return True if text matches a known section heading keyword."""
        t = text.lower().strip()
        if t in _HEADING_KEYWORDS:
            return True
        # Also check multi-word headings (e.g. 'professional summary')
        for kw in _HEADING_KEYWORDS:
            if t == kw or t.startswith(kw + ' ') or t.startswith(kw + ':'):
                return True
        return False

    # ── Step 3a: Extract name from contact block segments ─────────────
    # The contact block often contains the name as a segment (e.g. after
    # removing email/phone).  This is more reliable than the paragraph
    # scan (Step 5) for templates where the name is embedded in a
    # multi-field contact paragraph rather than a standalone paragraph.
    if 'name' not in detected and segments:
        for seg in segments:
            seg_s = seg.strip()
            if not seg_s or len(seg_s) > 55:
                continue
            words = seg_s.split()
            # CamelCase split: "JeanneGarnier" → ["Jeanne", "Garnier"]
            # (handles templates where first/last name runs join without space)
            if len(words) == 1 and len(seg_s) >= 4:
                cc_parts = re.findall(r'[A-ZÀ-Ÿ][a-zà-ÿ]+', seg_s)
                if len(cc_parts) >= 2 and ''.join(cc_parts) == seg_s:
                    words = cc_parts
            if not (2 <= len(words) <= 4):
                continue
            if not all(w.replace("'", '').replace('-', '').isalpha() for w in words):
                continue
            if _PH_NAME.match(seg_s):
                continue
            if _is_section_heading_text(seg_s):
                continue
            if _candidate_looks_like_job_title(words):
                continue
            if _candidate_looks_like_name(words):
                display_name = ' '.join(words)
                detected['name'] = display_name
                if seg_s != display_name:
                    detected['_name_raw'] = seg_s
                else:
                    detected.pop('_name_raw', None)
                detected['first_name_text'] = words[0]
                detected['last_name_text'] = ' '.join(words[1:])
                logger.info(f"Detected [name] (contact segment): {' '.join(words)}")
                break

    # ── Step 4: Individual name paragraph lookup ──────────────────────
    if detected.get('first_name_text') and detected.get('last_name_text'):
        for p in paragraphs:
            ps = p.strip()
            if ps == detected['first_name_text']:
                detected['first_name'] = ps
            if ps == detected['last_name_text']:
                detected['last_name'] = ps

    # ── Step 5: Wide name scan — all paragraphs, scored by proximity ─
    # Scan EVERY paragraph for short alphabetic 2-4 word strings.
    # Score by distance to email paragraph and pick the closest
    # candidate that looks like a real name.
    # Always runs: if Step 3a already set a name, Step 5 can override it
    # when it finds an ALL-CAPS candidate closer to the email (Step 3a
    # may have picked a job title or school name from the contact block).
    _step3a_name = detected.get('name')
    _name_cands: List[Tuple[Tuple[int, int], str, List[str], str]] = []
    for i, p in enumerate(paragraphs):
        ps = p.strip()
        if not ps or len(ps) > 55:
            continue
        words = ps.split()
        # CamelCase split for single-word strings: "ItaiGerbi" → ["Itai", "Gerbi"]
        if len(words) == 1 and len(ps) >= 4:
            cc_parts = re.findall(r'[A-ZÀ-Ÿ][a-zà-ÿ]+', ps)
            if len(cc_parts) >= 2 and ''.join(cc_parts) == ps:
                words = cc_parts
        if not (2 <= len(words) <= 4):
            continue
        if not all(w.replace("'", '').replace('-', '').isalpha() for w in words):
            continue
        # Reject pure placeholder patterns (handled in step 7)
        if _PH_NAME.match(ps):
            continue
        # Reject strings that match known section headings
        if _is_section_heading_text(ps):
            continue
        # Reject strings that contain well-known non-name keywords
        t = ps.lower()
        if any(kw in t for kw in (
            'expérience', 'formation', 'compétence', 'langues',
            'experience', 'education', 'skills', 'profile', 'résumé',
            'linkedin', 'email', 'mobile', 'adresse',
            'summary', 'professional', 'objective', 'certifications',
            'hackathons', 'projects', 'interests', 'references',
            'hobbies', 'loisirs', 'activités', 'activities',
            'projets', 'objectif', 'profil',
            # Document-type labels that look like 2-word names
            'curriculum', 'vitae', 'resume', 'lettre', 'motivation',
            'candidature', 'sous-titre', 'subtitle',
        )):
            continue
        if _candidate_looks_like_job_title(words):
            continue
        # Apply name-particle heuristic
        if not _candidate_looks_like_name(words):
            continue
        dist = abs(i - email_idx) if email_idx is not None else i
        # Bonus: ALL_CAPS names (typical for French template person names)
        all_caps_bonus = 0 if all(w.isupper() for w in words) else 1
        # Use spaced version when CamelCase split was applied
        display_name = ' '.join(words) if ' '.join(words) != ps else ps
        _name_cands.append(((all_caps_bonus, dist), display_name, words, ps))

    if _name_cands:
        _name_cands.sort(key=lambda x: x[0])
        _, best_name, best_words, best_raw_name = _name_cands[0]
        # Override Step 3a if Step 5 found a better candidate
        if not _step3a_name or best_name != _step3a_name:
            detected['name'] = best_name
            if best_raw_name != best_name:
                detected['_name_raw'] = best_raw_name
            else:
                detected.pop('_name_raw', None)
            detected['first_name_text'] = best_words[0]
            detected['last_name_text'] = ' '.join(best_words[1:])
            logger.info(f"Detected [name] (wide scan): {best_name}")

    # ── Step 6: Name from email local part ───────────────────────────
    # Last resort: parse firstname.lastname@domain.com → "Firstname Lastname"
    if 'name' not in detected and detected.get('email'):
        local_part = detected['email'].split('@')[0].strip()
        # Split on dot, dash, underscore
        parts = re.split(r'[._\-]', local_part)
        parts = [p for p in parts if p.isalpha() and len(p) >= 2]
        if len(parts) >= 2:
            name_from_email = ' '.join(p.capitalize() for p in parts[:3])
            detected['name'] = name_from_email
            detected['first_name_text'] = parts[0].capitalize()
            detected['last_name_text'] = ' '.join(p.capitalize() for p in parts[1:3])
            logger.info(f"Detected [name] (email local part): {name_from_email}")

    # ── Step 6b: Title from nearby short paragraph ────────────────────
    # After name is found, look for a short paragraph near the contact
    # area that contains common job-title words (chargé, ingénieur, chef,
    # développeur…).  This fills the 'title' field which is needed so that
    # experience-company extraction can match TITLE + COMPANY patterns.
    if 'title' not in detected and detected.get('name') and email_idx is not None:
        det_name_val = detected['name']
        _title_cands: List[Tuple[Tuple[int, int], str]] = []
        for i, p in enumerate(paragraphs):
            ps = p.strip()
            if not ps or ps == det_name_val or len(ps) > 65:
                continue
            words = ps.split()
            if not (2 <= len(words) <= 7):
                continue
            if not all(
                w.replace("'", '').replace('-', '').replace("\u2019", '').isalpha()
                for w in words
            ):
                continue
            dist = abs(i - email_idx)
            if dist > 20:
                continue
            # Skip section headings
            lower = ps.lower()
            # Skip EXACT section headings (e.g. "EXPÉRIENCE", "FORMATION")
            # Use word-level match so "CHARGÉ DE PROJETS TI" (contains
            # "projets") is NOT skipped — only pure section headings.
            _sec_heading_re = re.compile(
                r'^(?:expérience|formation|compétence[s]?|langues?|'
                r'experience|education|skills|profile|résumé|'
                r'objectif|linkedin|centres\s+d|intérêt|loisirs|'
                r'projets?|certifications?|summary)(?:\s|$)',
                re.I,
            )
            if _sec_heading_re.match(lower):
                continue
            lower_words = [w.lower() for w in words]
            has_title_word = any(w in _JOB_TITLE_WORDS for w in lower_words)
            if has_title_word:
                _title_cands.append(((0, dist), ps))

        if _title_cands:
            _title_cands.sort(key=lambda x: x[0])
            detected['title'] = _title_cands[0][1]
            logger.info(f"Detected [title] (near contact): {_title_cands[0][1]}")

    # ── Step 7: Placeholder pattern detection ────────────────────────
    # Detects generic template placeholders that couldn't be found by other means.
    for i, p in enumerate(paragraphs):
        ps = p.strip()
        if not ps:
            continue

        # Name placeholders — collect first and all variants
        if _PH_NAME.match(ps):
            if 'name' not in detected and '_ph_name' not in detected:
                detected['_ph_name'] = ps
                logger.info(f"Detected [placeholder_name]: {ps}")
            ph_variants = detected.setdefault('_all_ph_names', [])
            if ps not in ph_variants:
                ph_variants.append(ps)

        # Title placeholders — collect ALL variants (body + header may differ in case/spacing)
        if _PH_TITLE.match(ps):
            if 'title' not in detected:
                detected['title'] = ps
                logger.info(f"Detected [title] (placeholder): {ps}")
            # Always accumulate extra variants; used by _build_replacements to cover headers
            variants = detected.setdefault('_all_ph_titles', [])
            if ps not in variants:
                variants.append(ps)

        # Address placeholders — only if we have no address yet
        if 'address' not in detected and _PH_ADDRESS.match(ps):
            detected['address'] = ps
            logger.info(f"Detected [address] (placeholder): {ps}")

        # LinkedIn partial path — /nom.prenom, /LinkedIn or similar
        if 'linkedin' not in detected and '_ph_linkedin' not in detected and _PH_LINKEDIN_PATH.match(ps):
            detected['_ph_linkedin'] = ps
            logger.info(f"Detected [placeholder_linkedin]: {ps}")

        # Phone label placeholders — e.g. 'Telephone', 'Téléphone' (no actual digits)
        if 'phone' not in detected and '_ph_phone' not in detected and _PH_PHONE.match(ps):
            detected['_ph_phone'] = ps
            logger.info(f"Detected [placeholder_phone]: {ps}")

    # Also scan individual short paragraphs for clean phone numbers not yet found
    if 'phone' not in detected:
        for p in paragraphs:
            ps = p.strip()
            if not ps or len(ps) > 30:
                continue
            for pat in phone_pats:
                m = re.fullmatch(pat.lstrip('^').rstrip('$'), ps) or re.search(pat, ps)
                if m and len(re.sub(r'\D', '', m.group())) >= 7:
                    detected['phone'] = m.group().strip()
                    logger.info(f"Detected [phone] (standalone): {detected['phone']}")
                    break
            if 'phone' in detected:
                break

    for k, v in detected.items():
        if not k.startswith('_'):
            logger.debug(f"Detected [{k}]: {v}")

    return detected


# ═══════════════════════════════════════════════════════════════════════════
#  Phase 3 — Build replacement map
# ═══════════════════════════════════════════════════════════════════════════

def _build_replacements(
    detected: Dict[str, str],
    employee: Dict[str, Any],
) -> List[Tuple[str, str]]:
    """
    Build (old_text, new_text) pairs from detected template values
    mapped onto the employee data.
    Order matters: longer strings first to avoid partial replacements.
    """
    pairs: List[Tuple[str, str]] = []
    emp_name = (employee.get('name') or '').strip()
    if not emp_name:
        fn = (employee.get('firstName') or '').strip()
        ln = (employee.get('lastName') or '').strip()
        emp_name = f"{fn} {ln}".strip()
    emp_parts = emp_name.split() if emp_name else []
    emp_first = emp_parts[0] if emp_parts else ''
    emp_last = ' '.join(emp_parts[1:]) if len(emp_parts) > 1 else ''
    use_header_title = not bool(employee.get('_title_derived'))

    # Full name replacement (for contact block paragraphs)
    if detected.get('name') and emp_name:
        pairs.append((detected['name'], emp_name))
        # Also add no-space concatenated variant (handles templates where
        # first/last name runs join without space, e.g. "JeanneGarnier")
        raw_name = (detected.get('_name_raw') or '').strip()
        if raw_name and raw_name != detected['name']:
            normalized_raw = re.sub(r"[\s'\-\u2019]+", '', raw_name).casefold()
            normalized_name = re.sub(r"[\s'\-\u2019]+", '', detected['name']).casefold()
            if normalized_raw != normalized_name:
                raw_name = ''
        if raw_name:
            pairs.append((raw_name, emp_name))

    # Placeholder-only name (e.g. "PRÉNOM NOM") — no real name was detected
    if emp_name:
        added_ph_names: set = set()
        if detected.get('_ph_name') and not detected.get('name'):
            ph = detected['_ph_name']
            pairs.append((ph, emp_name))
            added_ph_names.add(ph)
        # ALL_CAPS / title-case variants collected from headers etc.
        for variant in detected.get('_all_ph_names', []):
            if variant not in added_ph_names and variant != detected.get('name'):
                pairs.append((variant, emp_name))
                added_ph_names.add(variant)

    # Individual first/last name paragraphs
    if detected.get('first_name') and emp_first:
        pairs.append((detected['first_name'], emp_first))
    if detected.get('last_name') and emp_last:
        pairs.append((detected['last_name'], emp_last))
    # Fallback: add first/last name TEXT pairs when they exist as runs
    # within a single paragraph (no standalone paragraph match in Step 4).
    if not detected.get('first_name') and detected.get('first_name_text') and emp_first:
        if detected['first_name_text'] != emp_first:
            pairs.append((detected['first_name_text'], emp_first))
    if not detected.get('last_name') and detected.get('last_name_text') and emp_last:
        if detected['last_name_text'] != emp_last:
            pairs.append((detected['last_name_text'], emp_last))

    # Title / position — cover all placeholder variants (body + header may differ)
    if use_header_title and employee.get('title'):
        added_titles: set = set()
        if detected.get('title'):
            pairs.append((detected['title'], employee['title']))
            added_titles.add(detected['title'])
        for variant in detected.get('_all_ph_titles', []):
            if variant not in added_titles:
                pairs.append((variant, employee['title']))
                added_titles.add(variant)

    # Email (may contain space before @, need to replace exactly as detected)
    if detected.get('email') and employee.get('email'):
        det_email = detected['email']
        emp_email = employee['email']
        pairs.append((det_email, emp_email))

        # Fragment pairs: infographic templates split email across TXBX
        # paragraphs (e.g. "lucas.leblanc" and "@courriel.ca" in separate <w:p>).
        # Add local-part and domain pairs so both fragments get replaced.
        det_local, det_domain = '', ''
        emp_local, emp_domain = '', ''
        if '@' in det_email:
            # Handle space before @ (e.g. "lucas.leblanc @courriel.ca")
            clean = det_email.replace(' ', '')
            det_local = clean.split('@')[0]
            det_domain = '@' + clean.split('@')[1]
        if '@' in emp_email:
            emp_local = emp_email.split('@')[0]
            emp_domain = '@' + emp_email.split('@')[1]
        if det_local and emp_local and det_local != emp_local:
            pairs.append((det_local, emp_local))
        if det_domain and emp_domain and det_domain != emp_domain:
            pairs.append((det_domain, emp_domain))

    # Phone — replace with employee's, or clear if employee has none
    if detected.get('phone'):
        if employee.get('phone'):
            pairs.append((detected['phone'], employee['phone']))

            # Fragment pairs: TXBX templates split phone digits across paragraphs.
        # The last digit group (≥4 chars, usually unique) is safe to replace.
        # Shorter groups (area code etc.) risk false matches so we skip them.
        det_phone = detected['phone']
        emp_phone = employee['phone']
        det_digits = re.sub(r'\D', '', det_phone)
        emp_digits = re.sub(r'\D', '', emp_phone)
        if det_digits and emp_digits and det_digits != emp_digits:
            # Full concatenated digits (for paragraphs that glue all digits)
            pairs.append((det_digits, emp_digits))
            # Last digit group: usually 4 digits, unique in a phone number
            det_groups = re.findall(r'\d+', det_phone)
            if det_groups:
                last_g = det_groups[-1]
                if len(last_g) >= 4:
                    emp_groups = re.findall(r'\d+', emp_phone)
                    emp_last = emp_groups[-1] if emp_groups else ''
                    if last_g != emp_last:
                        pairs.append((last_g, emp_last))
        else:
            # Employee has no phone — erase the template's phone so it
            # doesn't appear in the generated CV as someone else's number.
            det_phone = detected['phone']
            pairs.append((det_phone, ''))
            logger.debug("Clearing template phone (employee has none): %r", det_phone)
            # Also clear common inline separators that precede the phone
            # (e.g. "email • phone" → "email " when phone is cleared).
            # The replacement engine silently skips pairs not found in text.
            for _sep in (' • ', ' | ', ' · ', ' / ', '• ', '| '):
                pairs.append((_sep + det_phone, ''))

    # Placeholder phone label (e.g. 'Telephone', 'Téléphone') — no real number detected
    if detected.get('_ph_phone') and not detected.get('phone') and employee.get('phone'):
        pairs.append((detected['_ph_phone'], employee['phone']))

    # LinkedIn — generate from employee name if not provided
    if detected.get('linkedin'):
        det_li = detected['linkedin']
        new_li = (employee.get('linkedin') or '').strip()
        if not new_li:
            emp_parts = (employee.get('name') or '').split()
            if len(emp_parts) >= 2:
                slug = f"{emp_parts[0].lower()}-{emp_parts[-1].lower()}"
                new_li = f"linkedin.com/in/{slug}"
        pairs.append((det_li, new_li))

        # Fragment pairs: TXBX templates may split linkedin.com/name-slug across
        # "linkedin.com/" and "name" "-" "slug" paragraphs.
        # Extract the name slug and replace with the employee's slug.
        det_slug = ''
        new_slug = ''
        m = re.search(r'linkedin\.com/(?:in/)?(.+)', det_li, re.I)
        if m:
            det_slug = m.group(1)
        m2 = re.search(r'linkedin\.com/(?:in/)?(.+)', new_li, re.I)
        if m2:
            new_slug = m2.group(1)
        if det_slug and new_slug and det_slug != new_slug:
            # Add the full slug (e.g. "lucas-leblanc" → "jazil-gafsi")
            pairs.append((det_slug, new_slug))
            # Add the slug parts individually (e.g. "lucas" → "jazil")
            # These handle TXBX paragraphs where the slug is split across
            # separate <w:p> elements.
            det_slug_parts = det_slug.split('-')
            new_slug_parts = new_slug.split('-')
            for j, dp in enumerate(det_slug_parts):
                np = new_slug_parts[j] if j < len(new_slug_parts) else ''
                # Skip overly short parts (≤ 1 char) — they cause catastrophic
                # replacements across the entire document (e.g. 'j' → 'jazil')
                if dp and dp != np and len(dp) >= 2:
                    pairs.append((dp, np))

    # Placeholder LinkedIn path (e.g. '/nom.prenom') — replace with full URL or clear
    if detected.get('_ph_linkedin'):
        ph_li = detected['_ph_linkedin']
        new_li = (employee.get('linkedin') or '').strip()
        if not detected.get('linkedin'):  # only if real URL not already handled
            pairs.append((ph_li, new_li))

    def _split_emp_address_for_two_lines(addr: str) -> Optional[Tuple[str, str]]:
        parts = [p.strip() for p in addr.split(',') if p and p.strip()]
        if len(parts) < 2:
            return None
        if len(parts) >= 3 and re.fullmatch(r'\d+[A-Za-z]?', parts[0]):
            first = f"{parts[0]}, {parts[1]}".strip()
            second = ', '.join(parts[2:]).strip()
            return (first, second) if first and second else None
        first = parts[0]
        second = ', '.join(parts[1:]).strip()
        return (first, second) if first and second else None

    # Address / location — replace with employee's, or clear if employee has none
    if detected.get('address'):
        det_addr = detected['address']
        emp_addr = (employee.get('address') or '').strip()
        prec_line = (detected.get('address_preceding_line') or '').strip()
        if emp_addr:
            addr_for_det = emp_addr
            if prec_line:
                split_addr = _split_emp_address_for_two_lines(emp_addr)
                if split_addr:
                    first_line, second_line = split_addr
                    pairs.append((prec_line, first_line))
                    addr_for_det = second_line
                else:
                    # Keep previous behavior when we can't split cleanly:
                    # erase stale template street line.
                    pairs.append((prec_line, ''))
            pairs.append((det_addr, addr_for_det))

            # Fragment pairs: TXBX templates split "City, Country" into
            # "City" and ", Country" paragraphs.
            # SAFETY: only generate fragments when BOTH addresses follow a simple
            # 2-part "City, Country" pattern.  Skip when the employee address is
            # a complex multi-part street address (3+ commas) or when the mapped
            # city-part is not a recognisable place name (e.g. just a number).
            det_comma_count = det_addr.count(',')
            emp_comma_count = addr_for_det.count(',')
            _simple_addr = (det_comma_count == 1 and emp_comma_count <= 1)
            if _simple_addr and ',' in det_addr:
                det_parts = [p.strip() for p in det_addr.split(',', 1)]
                emp_parts_addr = [p.strip() for p in addr_for_det.split(',', 1)] if ',' in addr_for_det else [addr_for_det.strip(), '']
                # Only create city fragment if the employee city looks like a name (has letters)
                emp_city_has_alpha = bool(re.search(r'[A-Za-zÀ-ÿ]{2,}', emp_parts_addr[0]))
                if det_parts[0] and emp_parts_addr[0] and det_parts[0] != emp_parts_addr[0] and emp_city_has_alpha:
                    pairs.append((det_parts[0], emp_parts_addr[0]))
                if len(det_parts) > 1 and len(emp_parts_addr) > 1 and emp_parts_addr[1]:
                    det_suffix = ', ' + det_parts[1]
                    emp_suffix = ', ' + emp_parts_addr[1]
                    if det_suffix != emp_suffix:
                        pairs.append((det_suffix, emp_suffix))
                    # Also handle " Country" alone (no comma prefix in paragraph)
                    if det_parts[1] != emp_parts_addr[1]:
                        pairs.append((det_parts[1], emp_parts_addr[1]))
        else:
            # Employee has no address — erase every address fragment so
            # the previous employee's address does not bleed through.
            pairs.append((det_addr, ''))
            logger.debug("Clearing template address (employee has none): %r", det_addr)
            if prec_line:
                pairs.append((prec_line, ''))
            # Also clear fragment parts if simple City, Country format
            if det_addr.count(',') == 1:
                det_parts = [p.strip() for p in det_addr.split(',', 1)]
                if det_parts[0]:
                    pairs.append((det_parts[0], ''))
                if det_parts[1]:
                    pairs.append((', ' + det_parts[1], ''))
                    pairs.append((det_parts[1], ''))
            else:
                # Clear comma-separated fragments for complex addresses too.
                for frag in [f.strip() for f in det_addr.split(',') if f.strip()]:
                    if len(frag) >= 3:
                        pairs.append((frag, ''))

    # Clear preceding street line (e.g. "234 5th Ave,") when the address
    # was detected from a US-format "City, ST ZIP" on the next paragraph.
    if detected.get('address_preceding_line') and employee.get('address'):
        prec_line = detected['address_preceding_line']
        existing_olds = {old for old, _ in pairs}
        if prec_line not in existing_olds:
            pairs.append((prec_line, ''))

    # Sort: longer replacements first to avoid partial matches
    pairs.sort(key=lambda x: len(x[0]), reverse=True)

    logger.info(f"Built {len(pairs)} replacement pairs:")
    for old, new in pairs:
        logger.info(f"  '{old}' → '{new}'")

    return pairs


# ═══════════════════════════════════════════════════════════════════════════
#  Phase 4 — Apply replacements (paragraph-aware, handles split runs)
# ═══════════════════════════════════════════════════════════════════════════

def _is_mega_contact_para(text: str) -> bool:
    """Return True if this paragraph contains 3+ contact fields merged together.

    Infographic / two-column templates (e.g. Lucas Leblanc) embed the full
    header block — name, title, email, phone, address, LinkedIn — as one
    very long paragraph with no paragraph breaks between fields.  Replacing
    every field individually in this paragraph creates a single-line blob
    that overlaps visually in LibreOffice.  The standalone contact paragraphs
    (email-only, phone-only, address-only) are the canonical render source;
    the mega-paragraph is a mirror / shadow that LibreOffice renders from the
    standalone ones.  We detect it and restrict replacements accordingly.
    """
    if len(text) < 100:
        return False
    markers = 0
    if re.search(r'[\w.+\-]+@[\w.]+\.\w+', text):
        markers += 1
    if re.search(r'\d{3}[-.]\d{3}[-.]\d{4}|\+\d{1,3}[\s\d]', text):
        markers += 1
    if re.search(r'linkedin\.com', text, re.I):
        markers += 1
    if re.search(r'[A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)?,\s*[A-ZÀ-Ú][a-zà-ú]', text):
        markers += 1
    return markers >= 3


def _is_contact_field_value(old: str) -> bool:
    """Return True if 'old' looks like a contact field value (email, phone, address).

    Used to skip these replacements inside mega-paragraphs where the template
    packs all contact fields into one paragraph without line separators.
    """
    ol = old.strip()
    if not ol:
        return False
    # Email
    if re.match(r'^[\w.+\-]+@[\w.]+\.\w+$', ol):
        return True
    # Phone: 7+ digits with common separators
    if re.match(r'^[\+\d][\d\s()\-./]{5,}$', ol) and len(re.sub(r'\D', '', ol)) >= 7:
        return True
    # Address: contains comma and is long enough to be "City, Country"
    if ',' in ol and len(ol) > 12 and re.match(r'^[A-ZÀ-Üa-zà-ü0-9]', ol):
        return True
    return False


def _replace_in_paragraph(para_el, ns_prefix: str, replacements: List[Tuple[str, str]]) -> int:
    """
    Given a paragraph element (<w:p> or <a:p>), join all text runs,
    apply replacements on the joined string, then redistribute:
      - first <*:t> gets the full new text
      - remaining <*:t> elements are emptied

    IMPORTANT: outer body <w:p> elements that CONTAIN <wps:txbx> shapes are
    skipped here — they are handled by _replace_in_txbx_shapes() instead,
    which preserves each shape's individual text position.

    MEGA-PARAGRAPH RULE: if the paragraph contains 3+ contact-field markers
    (email + phone + linkedin + address all in one paragraph), only  apply
    replacements where 'old' is ≥12 chars AND not a contact field value.
    Short tokens like 'LUCAS' or 'LEBLANC' are skipped so they can't
    accidentally mangle the email/linkedin URLs still present in the paragraph.
    """
    ns = NS_W if ns_prefix == 'w' else NS_A
    t_tag = f'{{{ns}}}t'

    # If this paragraph CONTAINS wps:txbx shapes, skip at the outer level.
    # The inner <w:p> elements of each shape are reached by tree.iter separately.
    if ns_prefix == 'w' and para_el.find(f'.//{_WPS_TXBX}') is not None:
        return 0

    t_elements = list(para_el.iter(t_tag))
    if not t_elements:
        return 0

    joined = ''.join(t.text or '' for t in t_elements)
    if not joined.strip():
        return 0

    # Detect mega-contact paragraphs (all contact fields merged into one line)
    is_mega_para = _is_mega_contact_para(joined)
    # Minimum 'old' length for mega-paragraphs to avoid token collisions in URLs
    _MEGA_MIN_LEN = 12

    new_text = joined
    count = 0
    for old, new in replacements:
        if not old or old not in new_text:
            continue
        # ── Mega-paragraph guard ─────────────────────────────────────────
        # For infographic-template header paragraphs that pack all contact
        # fields (email, phone, address, linkedin) into one paragraph:
        # - Skip short token replacements (< 12 chars) to avoid accidental
        #   matches inside email addresses or linkedin slugs still in the text.
        # - Skip contact-field values (email, phone, address) entirely —
        #   standalone paragraphs are the canonical render source for these.
        if is_mega_para:
            if len(old) < _MEGA_MIN_LEN or _is_contact_field_value(old):
                continue
        # ── Label-value concatenation fix ────────────────────────────────
        # Some templates store "EmailValue" (no space) instead of "Email Value".
        # When we replace Value→NewValue, insert the missing space so the result
        # is "Email NewValue" rather than "EmailNewValue".
        replaced_via_label = False
        for _lbl in ('Email', 'Mail', 'E-mail', 'Courriel', 'Mobile',
                     'Tél', 'Tel', 'Phone', 'Adresse', 'Address',
                     'LinkedIn', 'Web', 'Site', 'Fax'):
            if (_lbl + old) in new_text:
                new_text = new_text.replace(_lbl + old, _lbl + ' ' + new)
                count += 1
                replaced_via_label = True
                break
        if not replaced_via_label:
            new_text = new_text.replace(old, new)
            count += 1

    if count == 0:
        return 0

    # Sanitise replacement text for XML safety
    new_text = _xml_safe_text(new_text)

    # Redistribute: put everything in first <t>, blank the rest
    t_elements[0].text = new_text
    t_elements[0].set(_XML_SPACE, 'preserve')
    for t in t_elements[1:]:
        t.text = ''

    return count


def _get_shape_off_x(elem: Any) -> int:
    """Return the x offset (EMUs) from the nearest ancestor shape's <a:xfrm><a:off>."""
    parent = elem.getparent()
    while parent is not None:
        xfrm = parent.find(f'.//{{{NS_A}}}xfrm')
        if xfrm is not None:
            off = xfrm.find(f'{{{NS_A}}}off')
            if off is not None:
                try:
                    return int(off.get('x', 0))
                except (ValueError, TypeError):
                    return 0
        parent = parent.getparent()
    return 0


def _get_shape_off_y(elem: Any) -> int:
    """Return the y offset (EMUs) from the nearest ancestor shape's <a:xfrm><a:off>."""
    parent = elem.getparent()
    while parent is not None:
        xfrm = parent.find(f'.//{{{NS_A}}}xfrm')
        if xfrm is not None:
            off = xfrm.find(f'{{{NS_A}}}off')
            if off is not None:
                try:
                    return int(off.get('y', 0))
                except (ValueError, TypeError):
                    return 0
        parent = parent.getparent()
    return 0


def _set_shape_off_y(elem: Any, y_val: int) -> None:
    """Set the y offset on the nearest ancestor shape's <a:xfrm><a:off>."""
    parent = elem.getparent()
    while parent is not None:
        xfrm = parent.find(f'.//{{{NS_A}}}xfrm')
        if xfrm is not None:
            off = xfrm.find(f'{{{NS_A}}}off')
            if off is not None:
                off.set('y', str(y_val))
                return
        parent = parent.getparent()


def _get_group_child_width(elem: Any) -> int:
    """Return the parent wpg:wgp group's child coordinate width (chExt cx)."""
    p = elem.getparent()
    while p is not None:
        tag = p.tag
        if '}wgp' in tag and 'wordprocessingGroup' in tag:
            # Found the group — look for grpSpPr / a:xfrm / a:chExt
            for child in p:
                if 'grpSpPr' in child.tag:
                    xfrm = child.find(f'{{{NS_A}}}xfrm')
                    if xfrm is not None:
                        ch_ext = xfrm.find(f'{{{NS_A}}}chExt')
                        if ch_ext is not None:
                            try:
                                return int(ch_ext.get('cx', 0))
                            except (ValueError, TypeError):
                                return 0
            return 0
        p = p.getparent()
    return 0


def _get_shape_cx(txbx_elem: Any) -> int:
    """Return the cx (width in EMUs) of a <wps:txbx> by navigating to <a:ext>."""
    parent = txbx_elem.getparent()
    while parent is not None:
        ext = parent.find(f'.//{{{NS_A}}}ext')
        if ext is not None:
            try:
                return int(ext.get('cx', 0))
            except (ValueError, TypeError):
                return 0
        parent = parent.getparent()
    return 0


def _set_shape_cx(txbx_elem: Any, cx_val: int) -> None:
    """Set the cx width on a <wps:txbx> element's own <a:ext>.

    For shapes that live inside a <wpg:wgp> Word Processing Group the anchor's
    <wp:extent> belongs to the WHOLE GROUP CONTAINER and must not be overwritten
    with a single shape's width.  Only update <wp:extent> for standalone shapes
    (i.e. shapes that are NOT nested inside a wpg group).
    """
    NS_WPG = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup'

    # Detect if this shape is inside a wpg group (any ancestor has local='wgp')
    in_group = False
    probe = txbx_elem.getparent()
    while probe is not None:
        tag = probe.tag
        ns, _, local = tag[1:].partition('}') if tag.startswith('{') else ('', '', tag)
        if local == 'wgp' and 'wordprocessingGroup' in ns:
            in_group = True
            break
        probe = probe.getparent()

    parent = txbx_elem.getparent()
    while parent is not None:
        ext = parent.find(f'.//{{{NS_A}}}ext')
        if ext is not None:
            ext.set('cx', str(cx_val))
            # Only update the anchor's <wp:extent> for standalone (non-grouped) shapes.
            # For grouped shapes the anchor belongs to the group container.
            if not in_group:
                p = parent
                while p is not None:
                    local = p.tag.split('}')[-1] if '}' in p.tag else p.tag
                    if local == 'anchor':
                        wp_extent = p.find(f'{{{NS_WP}}}extent')
                        if wp_extent is not None:
                            wp_extent.set('cx', str(cx_val))
                        break
                    p = p.getparent()
            return
        parent = parent.getparent()


def _get_shape_cy(txbx_elem: Any) -> int:
    """Return the cy (height in EMUs) of a <wps:txbx> by navigating to <a:ext>."""
    parent = txbx_elem.getparent()
    while parent is not None:
        ext = parent.find(f'.//{{{NS_A}}}ext')
        if ext is not None:
            try:
                return int(ext.get('cy', 0))
            except (ValueError, TypeError):
                return 0
        parent = parent.getparent()
    return 0


def _set_shape_cy(txbx_elem: Any, cy_val: int) -> None:
    """Set the cy height on a <wps:txbx>, updating both <a:ext> and <wp:extent> (group-safe)."""
    NS_WPG = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup'

    # Detect if this shape is inside a wpg group (same guard as _set_shape_cx)
    in_group = False
    probe = txbx_elem.getparent()
    while probe is not None:
        tag = probe.tag
        _, _, local = tag[1:].partition('}') if tag.startswith('{') else ('', '', tag)
        if local == 'wgp' and 'wordprocessingGroup' in tag:
            in_group = True
            break
        probe = probe.getparent()

    parent = txbx_elem.getparent()
    while parent is not None:
        ext = parent.find(f'.//{{{NS_A}}}ext')
        if ext is not None:
            ext.set('cy', str(cy_val))
            # Also update <wp:extent> for standalone (non-grouped) shapes
            if not in_group:
                p = parent
                while p is not None:
                    local = p.tag.split('}')[-1] if '}' in p.tag else p.tag
                    if local == 'anchor':
                        wp_extent = p.find(f'{{{NS_WP}}}extent')
                        if wp_extent is not None:
                            wp_extent.set('cy', str(cy_val))
                        break
                    p = p.getparent()
            return
        parent = parent.getparent()


def _replace_in_txbx_shapes(
    body_p: Any, replacements: List[Tuple[str, str]]
) -> int:
    """
    For a body <w:p> that embeds multiple <wps:txbx> shapes (e.g. the
    contact sidebar), apply replacements SHAPE-BY-SHAPE.

    Each <wps:txbx> holds its own absolutely-positioned text box on the
    page.  We must NOT merge text across shapes; instead, we use a
    sliding-window scan over consecutive shapes to match values that Word
    split across several boxes (e.g. phone "555"-"-"-"555"-"-"-"5555").

    When a match spans N consecutive shapes, the new value is placed in
    the FIRST NON-EMPTY shape of the span.  The target shape's cx width
    is expanded to the SUM of all merged shapes' cx values so the new
    (potentially longer) text is never clipped.

    Two text arrays are maintained:
      orig_texts  — original template values, never modified
                    (used for the boundary check to prevent a previously
                     replaced value from absorbing the next replacement)
      curr_texts  — updated as each replacement is applied
    """
    W_T = f'{{{NS_W}}}t'

    raw_shapes: List[Any] = list(body_p.iter(_WPS_TXBX))
    if not raw_shapes:
        return 0

    shapes = [{'txbx': txbx, 't_elems': list(txbx.iter(W_T)), 'cx': _get_shape_cx(txbx)}
              for txbx in raw_shapes]

    n = len(shapes)
    orig_texts = [''.join(t.text or '' for t in s['t_elems']) for s in shapes]
    curr_texts  = list(orig_texts)

    def _write(i: int, new_text: str) -> None:
        if shapes[i]['t_elems']:
            shapes[i]['t_elems'][0].text = new_text
            if new_text and new_text != new_text.strip():
                shapes[i]['t_elems'][0].set(_XML_SPACE, 'preserve')
            for t in shapes[i]['t_elems'][1:]:
                t.text = ''
        curr_texts[i] = new_text

    def _expand_cx(target: int, span_start: int, span_end: int) -> None:
        """Give target shape the total cx of all shapes in [span_start, span_end]."""
        total_cx = sum(shapes[k]['cx'] for k in range(span_start, span_end + 1))
        if total_cx > shapes[target]['cx']:
            _set_shape_cx(shapes[target]['txbx'], total_cx)
            shapes[target]['cx'] = total_cx

    total = 0
    for old, new in replacements:
        if not old:
            continue
        matched = False

        # ── 1. Single-shape match (current state) ────────────────────
        for i in range(n):
            if old in curr_texts[i]:
                _write(i, curr_texts[i].replace(old, new))
                # Expand shape width when new text is longer than old text to
                # prevent line-wrapping (e.g. "LEBLANC" → "BEN JEMAA" at 36pt).
                if len(new) > len(old):
                    ratio = len(new) / len(old)
                    expanded_cx = int(shapes[i]['cx'] * ratio)
                    if expanded_cx > shapes[i]['cx']:
                        _set_shape_cx(shapes[i]['txbx'], expanded_cx)
                        shapes[i]['cx'] = expanded_cx
                    # Also expand height with safety margin to avoid after-spacing clip.
                    old_cy = _get_shape_cy(shapes[i]['txbx'])
                    if old_cy > 0:
                        new_cy = int(old_cy * max(ratio, 1.3))
                        if new_cy > old_cy:
                            _set_shape_cy(shapes[i]['txbx'], new_cy)
                total += 1
                matched = True
                break

        if matched:
            continue

        # ── 2. Multi-shape sliding window ────────────────────────────
        # Accumulate curr_texts so we see the post-substitution state,
        # but gate on orig_texts to prevent a prior replacement value
        # from swallowing the next match.
        for start in range(n):
            cumulative = ''
            for end in range(start, n):
                cumulative += curr_texts[end]
                if old in cumulative:
                    match_pos = cumulative.find(old)
                    # Reject if match starts inside previously-replaced content
                    if match_pos <= len(orig_texts[start]):
                        # Place new value at the first originally non-empty shape
                        first_nonempty = start
                        for fne in range(start, end + 1):
                            if orig_texts[fne].strip():
                                first_nonempty = fne
                                break
                        # Expand target cx to prevent text clipping
                        _expand_cx(first_nonempty, start, end)
                        _write(first_nonempty, new)
                        for mid in range(start, end + 1):
                            if mid != first_nonempty:
                                _write(mid, '')
                        total += 1
                        matched = True
                    break
                if len(cumulative) > len(old) + 10:
                    break
            if matched:
                break

    return total


def _replace_in_vml_fallback(tree: Any, replacements: List[Tuple[str, str]]) -> int:
    """
    Apply sliding-window replacements to VML <v:textbox> elements inside
    <mc:AlternateContent><mc:Fallback> blocks.

    LibreOffice renders the VML fallback rather than the WPS shapes when the
    wpg feature is not fully supported.  This function mirrors the sliding-
    window logic of _replace_in_txbx_shapes so that contact-sidebar data is
    also correct in the rendered output.

    Multi-part values (e.g. phone "555"-"-"-"555"-"-"-"5555" across five
    separate <v:rect> elements) are matched by concatenating consecutive
    textbox texts, then the replacement is placed in the first non-empty
    shape and the remaining shapes in the span are cleared.  The VML rect
    style width is summed for the merged shapes so text is never clipped.
    """
    W_T   = f'{{{NS_W}}}t'
    AC_FB = f'{{{NS_MC}}}Fallback'
    AC    = f'{{{NS_MC}}}AlternateContent'
    VTXBX = f'{{{NS_V}}}textbox'

    total = 0

    for ac in tree.iter(AC):
        fallback = ac.find(AC_FB)
        if fallback is None:
            continue

        vtextboxes = list(fallback.iter(VTXBX))
        if not vtextboxes:
            continue

        n = len(vtextboxes)

        # ── helpers ──────────────────────────────────────────────

        def _vml_text(tb: Any) -> str:
            return ''.join(t.text or '' for t in tb.iter(W_T))

        def _vml_write(tb: Any, new_text: str) -> None:
            t_elems = list(tb.iter(W_T))
            if t_elems:
                t_elems[0].text = new_text
                if new_text and new_text != new_text.strip():
                    t_elems[0].set(_XML_SPACE, 'preserve')
                for t in t_elems[1:]:
                    t.text = ''

        def _vml_get_w(tb: Any) -> int:
            rect = tb.getparent()
            if rect is None:
                return 0
            for part in (rect.get('style') or '').split(';'):
                k, _, v = part.strip().partition(':')
                if k.strip() == 'width':
                    try:
                        return int(v.strip())
                    except (ValueError, TypeError):
                        return 0
            return 0

        def _vml_set_w(tb: Any, width: int) -> None:
            rect = tb.getparent()
            if rect is None:
                return
            old_style = rect.get('style') or ''
            parts = old_style.split(';')
            new_parts = [
                f'width:{width}' if p.strip().startswith('width:') else p
                for p in parts
            ]
            rect.set('style', ';'.join(new_parts))

        def _vml_get_h(tb: Any) -> int:
            rect = tb.getparent()
            if rect is None:
                return 0
            for part in (rect.get('style') or '').split(';'):
                k, _, v = part.strip().partition(':')
                if k.strip() == 'height':
                    try:
                        return int(v.strip())
                    except (ValueError, TypeError):
                        return 0
            return 0

        def _vml_set_h(tb: Any, height: int) -> None:
            rect = tb.getparent()
            if rect is None:
                return
            old_style = rect.get('style') or ''
            parts = old_style.split(';')
            new_parts = [
                f'height:{height}' if p.strip().startswith('height:') else p
                for p in parts
            ]
            rect.set('style', ';'.join(new_parts))

        # ── state ────────────────────────────────────────────────

        orig_texts = [_vml_text(tb) for tb in vtextboxes]
        curr_texts = list(orig_texts)

        def _write(i: int, new_text: str) -> None:
            _vml_write(vtextboxes[i], new_text)
            curr_texts[i] = new_text

        def _expand_w(target: int, span_start: int, span_end: int) -> None:
            total_w = sum(_vml_get_w(vtextboxes[k]) for k in range(span_start, span_end + 1))
            if total_w > _vml_get_w(vtextboxes[target]):
                _vml_set_w(vtextboxes[target], total_w)

        # ── replacement loop ──────────────────────────────────────

        for old, new in replacements:
            if not old:
                continue
            matched = False

            # 1. Single-shape match
            for i in range(n):
                if old in curr_texts[i]:
                    _write(i, curr_texts[i].replace(old, new))
                    # Expand VML rect width when new text is longer to prevent wrapping
                    if len(new) > len(old):
                        ratio = len(new) / len(old)
                        cur_w = _vml_get_w(vtextboxes[i])
                        expanded_w = int(cur_w * ratio)
                        if expanded_w > cur_w:
                            _vml_set_w(vtextboxes[i], expanded_w)
                        # Also expand height with a safety margin to prevent line
                        # clipping when paragraph after-spacing fills the box.
                        cur_h = _vml_get_h(vtextboxes[i])
                        if cur_h > 0:
                            expanded_h = int(cur_h * max(ratio, 1.3))
                            _vml_set_h(vtextboxes[i], expanded_h)
                    total += 1
                    matched = True
                    break

            if matched:
                continue

            # 2. Multi-shape sliding window
            for start in range(n):
                cumulative = ''
                for end in range(start, n):
                    cumulative += curr_texts[end]
                    if old in cumulative:
                        if cumulative.find(old) <= len(orig_texts[start]):
                            first_nonempty = start
                            for fne in range(start, end + 1):
                                if orig_texts[fne].strip():
                                    first_nonempty = fne
                                    break
                            _expand_w(first_nonempty, start, end)
                            _write(first_nonempty, new)
                            for mid in range(start, end + 1):
                                if mid != first_nonempty:
                                    _write(mid, '')
                            total += 1
                            matched = True
                        break
                    if len(cumulative) > len(old) + 10:
                        break
                if matched:
                    break

    return total


def _apply_paragraph_replacements(
    docx_path: str, replacements: List[Tuple[str, str]]
) -> int:
    """
    Apply text replacements to ALL word/*.xml files (document, headers, footers)
    in a single zip read/write cycle.

    Handles two paragraph types:
    - <w:p> (WordprocessingML) — uses _para_own_runs to avoid nested textbox merging
    - <a:p> (DrawingML) — handles text inside shapes rendered via the drawing layer

    CRITICAL: uses ``_para_own_runs`` to avoid descending into nested
    <w:txbxContent>/<w:p> elements.  Without this, processing a BODY paragraph
    that embeds a textbox would wipe the textbox's text.
    """
    if not replacements:
        return 0

    total     = 0
    W         = NS_W
    A         = NS_A
    WP        = f'{{{W}}}p'
    WR        = f'{{{W}}}r'
    WR_PR     = f'{{{W}}}rPr'
    WT        = f'{{{W}}}t'
    AP        = f'{{{A}}}p'
    AR        = f'{{{A}}}r'
    AT        = f'{{{A}}}t'
    MC_FB     = f'{{{NS_MC}}}Fallback'
    XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space'
    temp_dir  = tempfile.mkdtemp()

    def _para_own_runs(para):
        """Yield <w:r> elements belonging to THIS paragraph level only.

        Walks the subtree of *para* but stops recursion at any nested <w:p>
        (which lives inside <w:txbxContent> shapes) and at mc:Fallback
        (VML duplicate layer).  This ensures that textbox paragraphs keep
        their own runs intact and VML runs are not double-counted.
        """
        def _walk(elem):
            for child in elem:
                if child.tag == WP or child.tag == MC_FB:
                    continue          # nested paragraph or VML fallback — skip
                if child.tag == WR:
                    yield child
                else:
                    yield from _walk(child)
        yield from _walk(para)

    def _runs_have_mixed_styles(runs):
        style_keys = set()
        for run in runs:
            text_elem = run.find(WT)
            if text_elem is None or not (text_elem.text or '').strip():
                continue
            rpr = run.find(WR_PR)
            style_keys.add(etree.tostring(rpr, encoding='unicode') if rpr is not None else '')
        return len(style_keys) > 1

    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)

        word_dir = os.path.join(temp_dir, 'word')
        if not os.path.isdir(word_dir):
            return 0

        any_changed = False

        # Process ALL xml files under word/ (document, headers, footers, etc.)
        for xml_root, _dirs, xml_files in os.walk(word_dir):
            for xml_name in xml_files:
                if not xml_name.endswith('.xml'):
                    continue
                xml_path = os.path.join(xml_root, xml_name)
                with open(xml_path, 'rb') as f:
                    raw = f.read()
                try:
                    tree = etree.fromstring(raw)
                except etree.XMLSyntaxError:
                    continue

                file_changed = False
                file_count = 0
                rel_name = os.path.relpath(xml_path, temp_dir)

                # --- Cross-textbox sliding window: handle fragmented contacts ---
                # MUST run BEFORE per-paragraph replacement, otherwise short
                # fragment pairs (e.g. "5555"→"432") destroy the joined text
                # before the cross-textbox window can match the full string.
                W_TXBX_CONTENT = f'{{{W}}}txbxContent'
                all_txbx = list(tree.iter(W_TXBX_CONTENT))
                if len(all_txbx) >= 2:
                    txbx_texts = []
                    for tx in all_txbx:
                        t_elems = list(tx.iter(WT))
                        txt = ''.join(t.text or '' for t in t_elems)
                        txbx_texts.append(txt.strip())

                    for old, new in replacements:
                        if not old:
                            continue
                        # Keep scanning for ALL occurrences (templates may
                        # have multiple copies: mc:Choice page1+2, mc:Fallback page1+2)
                        scan_from = 0
                        while scan_from < len(txbx_texts):
                            found = False
                            for win_size in range(2, min(12, len(txbx_texts) - scan_from + 1)):
                                if found:
                                    break
                                for si in range(scan_from, len(txbx_texts) - win_size + 1):
                                    joined = ''.join(txbx_texts[si:si + win_size])
                                    if old == joined:
                                        first_ne = si
                                        for fne in range(si, si + win_size):
                                            if txbx_texts[fne].strip():
                                                first_ne = fne
                                                break
                                        t_el = list(all_txbx[first_ne].iter(WT))
                                        if t_el:
                                            t_el[0].text = str(new) if new else ''
                                            t_el[0].set(XML_SPACE, 'preserve')
                                            for te in t_el[1:]:
                                                te.text = ''
                                        txbx_texts[first_ne] = str(new) if new else ''
                                        for bi in range(si, si + win_size):
                                            if bi != first_ne:
                                                for te in all_txbx[bi].iter(WT):
                                                    te.text = ''
                                                txbx_texts[bi] = ''

                                        # ── Expand first textbox width to span the full group ──
                                        if win_size >= 2 and new:
                                            first_x = _get_shape_off_x(all_txbx[first_ne])
                                            last_bi = si + win_size - 1
                                            last_x = _get_shape_off_x(all_txbx[last_bi])
                                            last_cx = _get_shape_cx(all_txbx[last_bi])
                                            if first_x > 0 and last_x >= first_x and last_cx > 0:
                                                group_right = last_x + last_cx
                                                # Try to extend to the group's child width
                                                grp_w = _get_group_child_width(all_txbx[first_ne])
                                                if grp_w > first_x:
                                                    group_right = max(group_right, grp_w)
                                                new_cx = group_right - first_x
                                                cur_cx = _get_shape_cx(all_txbx[first_ne])
                                                if new_cx > cur_cx:
                                                    _set_shape_cx(all_txbx[first_ne], new_cx)

                                        file_count += 1
                                        file_changed = True
                                        scan_from = si + win_size
                                        found = True
                                        break
                            if not found:
                                break

                # --- VML fallback sliding window ---
                vml_count = _replace_in_vml_fallback(tree, replacements)
                if vml_count > 0:
                    file_count += vml_count
                    file_changed = True

                # --- Process <w:p> paragraphs ---
                for para in tree.iter(WP):
                    runs = list(_para_own_runs(para))
                    if not runs:
                        continue

                    # Gather per-run text
                    run_texts = []
                    paragraph_parts = []
                    for r in runs:
                        t = r.find(WT)
                        run_texts.append(t.text or '' if t is not None else '')
                        for child in r:
                            if child.tag == WT:
                                paragraph_parts.append(child.text or '')
                            elif child.tag == f'{{{W}}}br':
                                paragraph_parts.append('\n')
                    full_text = ''.join(run_texts)
                    paragraph_text = ''.join(paragraph_parts)
                    if not full_text.strip():
                        continue

                    # Check which replacements apply to this paragraph
                    active_repls = [(old, new) for old, new in replacements
                                    if old and old in full_text]
                    if not active_repls:
                        continue

                    # Strategy: try per-run replacement first (preserves bold/italic/font)
                    # Only fall back to full-text collapse when a replacement spans runs
                    all_fit_in_runs = True
                    for old, new in active_repls:
                        if not any(old in rt for rt in run_texts):
                            all_fit_in_runs = False
                            break

                    if all_fit_in_runs and _runs_have_mixed_styles(runs):
                        paragraph_len = len((paragraph_text or full_text).strip())
                        has_long_generated_text = any(
                            len(str(new or '').strip()) >= 40 for _old, new in active_repls
                        )
                        if paragraph_len >= 60 and (len(active_repls) > 1 or has_long_generated_text):
                            # Long generated prose should inherit a single body style,
                            # not preserve arbitrary template run-level font changes.
                            all_fit_in_runs = False

                    if all_fit_in_runs:
                        # Per-run replacement — preserves formatting of each run
                        runs_changed = False
                        for ri, r in enumerate(runs):
                            t_elem = r.find(WT)
                            if t_elem is None:
                                continue
                            rtext = t_elem.text or ''
                            modified_rtext = rtext
                            for old, new in active_repls:
                                if old in modified_rtext:
                                    safe_new = _xml_safe_text(str(new)) if new is not None else ''
                                    modified_rtext = modified_rtext.replace(old, safe_new)
                            if modified_rtext != rtext:
                                t_elem.text = modified_rtext
                                t_elem.set(XML_SPACE, 'preserve')
                                runs_changed = True
                        if runs_changed:
                            file_count += 1
                            file_changed = True
                    else:
                        # Full-text collapse fallback for cross-run replacements
                        modified = paragraph_text or full_text
                        for old, new in replacements:
                            if old and old in modified:
                                safe_new = _xml_safe_text(str(new)) if new is not None else ''
                                modified = modified.replace(old, safe_new)
                        if modified != (paragraph_text or full_text):
                            first_run = runs[0]
                            first_rpr = first_run.find(WR_PR)
                            for child in list(first_run):
                                if child is not first_rpr:
                                    first_run.remove(child)

                            segments = re.split(r'\r\n|\r|\n', modified)
                            if not segments:
                                segments = ['']
                            for idx, segment in enumerate(segments):
                                if idx > 0:
                                    etree.SubElement(first_run, f'{{{W}}}br')
                                t_elem = etree.SubElement(first_run, WT)
                                t_elem.text = segment
                                t_elem.set(XML_SPACE, 'preserve')

                            for r in runs[1:]:
                                rpr = r.find(WR_PR)
                                for child in list(r):
                                    if child is not rpr:
                                        r.remove(child)
                            file_count += 1
                            file_changed = True

                # --- Process <a:p> paragraphs (DrawingML text in shapes) ---
                for ap in tree.iter(AP):
                    t_elems = list(ap.iter(AT))
                    if not t_elems:
                        continue
                    joined = ''.join(t.text or '' for t in t_elems)
                    if not joined.strip():
                        continue
                    modified = joined
                    for old, new in replacements:
                        if old and old in modified:
                            modified = modified.replace(old, str(new) if new is not None else '')
                    if modified != joined:
                        t_elems[0].text = modified
                        t_elems[0].set(XML_SPACE, 'preserve')
                        for t in t_elems[1:]:
                            t.text = ''
                        file_count += 1
                        file_changed = True

                if file_changed:
                    logger.info(f"  {rel_name}: {file_count} paragraph(s) modified")
                    with open(xml_path, 'wb') as f:
                        f.write(etree.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True))
                    any_changed = True
                    total += file_count

        if any_changed:
            with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for root_dir, _dirs, files in os.walk(temp_dir):
                    for fname in files:
                        fpath = os.path.join(root_dir, fname)
                        arcname = os.path.relpath(fpath, temp_dir)
                        zout.write(fpath, arcname)

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    logger.info(f"Total paragraph-level replacements: {total}")
    return total


# ═══════════════════════════════════════════════════════════════════════════
#  Phase 5 — Section-based body content replacement
#
#  CV templates have predictable sections (Summary, Experience, Education…).
#  We detect each section heading, wipe its content paragraphs, then insert
#  the employee's structured data — preserving the heading's own formatting.
# ═══════════════════════════════════════════════════════════════════════════

# ─── Section keyword catalog ─────────────────────────────────────────────
# This dict used to duplicate the section synonyms already maintained in
# cv_section_taxonomy.SECTION_KEYWORDS.  We now derive it from that single
# source of truth so a synonym added in one place applies everywhere.
#
# The previous dict mixed certifications + awards under one key; the
# taxonomy keeps them separate.  Callers that scan ``_SECTION_MAP.values()``
# still see all keywords, so behaviour is preserved.  Callers that switch
# on ``section`` get a more accurate label (e.g. an "Awards" heading no
# longer falsely classifies as a certifications block).
from app.services.cv_section_taxonomy import (
    SECTION_KEYWORDS as _CANONICAL_SECTION_KEYWORDS,
    classify_heading as _classify_taxonomy_heading,
    normalize_text as _normalize_taxonomy_heading,
)

_SECTION_MAP: Dict[str, List[str]] = {
    section: sorted(_CANONICAL_SECTION_KEYWORDS[section])
    for section in _CANONICAL_SECTION_KEYWORDS
    if section in {
        'summary', 'experience', 'education', 'skills', 'projects',
        'certifications', 'awards', 'languages', 'interests',
        'references', 'volunteer',
    }
}


_EMPLOYEE_SECTION_FIELD_ALIASES: Dict[str, Tuple[str, ...]] = {
    'summary': ('summary', 'professional_summary', 'profile', 'objective', 'about'),
    'experience': ('experience', 'work_experiences', 'workExperiences', 'employment', 'experiences'),
    'education': ('education', 'educations', 'academic_history', 'academicHistory'),
    'skills': ('skills', 'competencies', 'competences', 'technicalSkills', 'technical_skills'),
    'projects': ('projects', 'key_projects', 'keyProjects', 'portfolio'),
    'certifications': ('certifications', 'licenses', 'licences', 'credentials'),
    'languages': ('languages', 'langues', 'languageSkills', 'language_skills'),
    'awards': ('awards', 'honors', 'honours', 'achievements'),
    'interests': ('interests', 'hobbies', 'activities', 'personal_interests'),
    'references': ('references', 'referees'),
    'volunteer': ('volunteer', 'volunteering', 'volunteer_experience', 'community_service'),
    'contact': ('contact', 'name', 'email', 'phone', 'address', 'linkedin'),
}


def _canonicalize_section_label(text: str, *, allow_partial: bool = True) -> Optional[str]:
    """Return the canonical section name for a visible heading label."""
    canonical = _classify_taxonomy_heading(
        text,
        allow_partial=allow_partial,
        max_extra_words=2 if allow_partial else 0,
    )
    if canonical is not None:
        return canonical

    normalized_text = _normalize_heading_label(text)
    for optional_canonical, keywords in _AUTO_CLEAR_SECTION_KEYWORDS.items():
        if allow_partial:
            matched = any(_is_heading_label_match(text, kw) for kw in keywords)
        else:
            matched = any(normalized_text == _normalize_heading_label(kw) for kw in keywords)
        if matched:
            return optional_canonical
    return None


def _canonicalize_section_label_for_clearing(text: str) -> Optional[str]:
    """Return a conservative section label safe to use for content removal."""
    canonical = _classify_taxonomy_heading(
        text,
        allow_partial=False,
        max_extra_words=0,
    )
    if canonical is not None:
        return canonical

    normalized_text = _normalize_heading_label(text)
    for optional_canonical, keywords in _AUTO_CLEAR_SECTION_KEYWORDS.items():
        matched = any(normalized_text == _normalize_heading_label(kw) for kw in keywords)
        if matched:
            return optional_canonical
    return None


def _employee_has_section_content(employee: Dict[str, Any], canonical: Optional[str]) -> bool:
    """Return True when the employee payload can fill the canonical section."""
    if not canonical:
        return False
    if canonical in _NEVER_CLEAR_SECTIONS:
        return True
    if canonical in _AUTO_CLEAR_SECTION_KEYWORDS:
        return _has_optional_section_data(employee, canonical)

    keys = _EMPLOYEE_SECTION_FIELD_ALIASES.get(canonical, ())
    for key in keys:
        value = employee.get(key)
        if isinstance(value, str) and value.strip():
            return True
        if isinstance(value, (list, tuple, dict)) and len(value) > 0:
            return True
        if value not in (None, '', [], {}, ()):  # bool/int fallbacks
            return True

    if canonical == 'summary':
        return bool(employee.get('experience') or employee.get('work_experiences') or employee.get('title'))
    return False


def _section_label_matches_text(text: str, label: str) -> bool:
    """Compare two heading labels using the shared canonical classifier first."""
    text_canonical = _canonicalize_section_label(text, allow_partial=False)
    label_canonical = _canonicalize_section_label(label, allow_partial=False)
    if text_canonical and label_canonical:
        return text_canonical == label_canonical

    t = _normalize_heading_label(text)
    l = _normalize_heading_label(label)
    if not t or not l:
        return False
    return t == l


def _looks_like_label_value_content_row(
    run_parts: List[Tuple[str, bool]],
    strong_heading_signal: bool,
) -> bool:
    """Return True for inline content rows such as 'Languages: French...'.

    Direct CV templates often format sub-items as a bold label in the first run
    followed by a normal-text value in later runs. Those rows are content, not
    section headings, even if the bold label starts with a known section keyword.
    """
    if strong_heading_signal:
        return False

    non_empty_parts = [(text, is_bold) for text, is_bold in run_parts if text.strip()]
    if len(non_empty_parts) < 2:
        return False

    first_text, first_bold = non_empty_parts[0]
    if not first_bold or not first_text.rstrip().endswith(':'):
        return False

    if not any(not is_bold for _text, is_bold in non_empty_parts[1:]):
        return False

    suffix = ''.join(text for text, _is_bold in non_empty_parts[1:]).strip()
    if not suffix:
        return False

    return (
        len(suffix) >= 12
        or len(suffix.split()) >= 2
        or any(token in suffix for token in (',', ';', '(', ')', '/', '•'))
        or bool(re.search(r'\d', suffix))
    )


def _identify_section_lxml(p_elem: Any) -> Optional[str]:
    """Return the section name if this <w:p> looks like a CV section heading.

    Detects heading paragraphs from formatting signals (bold run, heading
    style, ALL-CAPS short text, large font, underline) and matches the
    trimmed text against ``_SECTION_MAP``.


    IMPORTANT: paragraphs that ARE CONTAINERS for <wps:txbx> shapes (sidebar
    label paragraphs in infographic templates) are explicitly excluded.  Those
    paragraphs' textbox descendants also contain section-label text (EXPÉRIENCE,
    FORMATION…) that would cause false matches.  The actual section heading in
    infographic templates lives INSIDE the textbox — _replace_cv_sections_in_textboxes
    handles those separately.
    """
    W = NS_W

    # Skip textbox-container paragraphs: they hold positioned shapes (sidebar labels),
    # not inline section heading text.  Their textbox descendants' text MUST NOT
    # be used for heading detection here.
    if p_elem.find(f'.//{_WPS_TXBX}') is not None:
        return None
    # NOTE: we intentionally do NOT skip paragraphs that merely contain a
    # mc:AlternateContent graphical decoration (e.g. a colored bar behind a heading).
    # Those paragraphs still carry a real <w:t> section heading (like "FORMATION")
    # and MUST be detected.  Only paragraphs with wps:txbx (a full textbox shape)
    # need to be skipped — they are handled by _replace_cv_sections_in_textboxes.

    # Collect plain text from ALL <w:t> descendants (safe now: no textboxes above)
    texts = [t.text for t in p_elem.iter(f'{{{W}}}t') if t.text]
    text = ''.join(texts).strip()
    if not text or len(text) > 65:
        return None

    # Check bold: any <w:r> with non-empty text that has <w:b> in its <w:rPr>
    is_bold = False
    for r in p_elem.iter(f'{{{W}}}r'):
        r_text = ''.join(t.text for t in r.findall(f'{{{W}}}t') if t.text)
        if r_text.strip():
            rpr = r.find(f'{{{W}}}rPr')
            if rpr is not None and rpr.find(f'{{{W}}}b') is not None:
                is_bold = True
                break
    # Also check paragraph-level rPr bold inheritance (pPr/rPr/b)
    if not is_bold:
        ppr = p_elem.find(f'{{{W}}}pPr')
        if ppr is not None:
            prpr = ppr.find(f'{{{W}}}rPr')
            if prpr is not None and prpr.find(f'{{{W}}}b') is not None:
                is_bold = True

    # Check heading style — covers English (Heading1) and localised styles:
    # FR=Titre1, DE=Überschrift1, IT=Titolo1, ES=Título1, PT=Título1
    has_heading_style = False
    ppr = p_elem.find(f'{{{W}}}pPr')
    if ppr is not None:
        pstyle = ppr.find(f'{{{W}}}pStyle')
        if pstyle is not None:
            style_val = (pstyle.get(f'{{{W}}}val') or '').lower()
            if (
                'heading' in style_val
                or 'titre' in style_val
                or 'überschrift' in style_val
                or 'titolo' in style_val
                or 'título' in style_val
                or re.match(r'^(titre|titolo|título|überschrift)\d', style_val)
            ):
                has_heading_style = True

    is_caps = (text.upper() == text and len(text.split()) <= 6 and text.replace(' ', '').isalpha())

    # Font-size detection: run with <w:sz> ≥ 26 half-points (= 13pt) on short text.
    # Most body text is 10–12pt; section headings are often 13–18pt in modern templates.
    # Only tested when not already identified as bold/heading to avoid double work.
    is_large_font = False
    if not is_bold and not has_heading_style:
        for r in p_elem.iter(f'{{{W}}}r'):
            r_text = ''.join(t.text for t in r.findall(f'{{{W}}}t') if t.text)
            if r_text.strip():
                rpr = r.find(f'{{{W}}}rPr')
                if rpr is not None:
                    sz = rpr.find(f'{{{W}}}sz')
                    if sz is not None:
                        try:
                            if int(sz.get(f'{{{W}}}val', '0')) >= 26:
                                is_large_font = True
                                break
                        except ValueError:
                            pass

    # Underline detection: <w:u> in run properties (not val="none")
    is_underlined = False
    if not (is_bold or has_heading_style or is_caps or is_large_font):
        for r in p_elem.iter(f'{{{W}}}r'):
            r_text = ''.join(t.text for t in r.findall(f'{{{W}}}t') if t.text)
            if r_text.strip():
                rpr = r.find(f'{{{W}}}rPr')
                if rpr is not None:
                    u = rpr.find(f'{{{W}}}u')
                    if u is not None and u.get(f'{{{W}}}val', 'single') != 'none':
                        is_underlined = True
                        break

    has_any_formatting = is_bold or has_heading_style or is_caps or is_large_font or is_underlined

    run_parts = [
        (_run_plain_text(r), _run_is_bold(r))
        for r in _direct_paragraph_runs(p_elem)
    ]
    if _looks_like_label_value_content_row(
        run_parts,
        strong_heading_signal=has_heading_style or is_caps or is_large_font or is_underlined,
    ):
        return None

    t_lower = text.lower().strip().replace('\u2019', "'").replace('\u2018', "'").replace('\u00a0', ' ')

    # Separators that are valid between keyword and rest of heading text,
    # e.g. "EXPÉRIENCE PROFESSIONNELLE", "Skills – Technical", "Formation :"
    _KW_SEP = frozenset(' \t:-–—/|•·()[]{}')

    if has_any_formatting:
        canonical = _canonicalize_section_label(text, allow_partial=False)
        if canonical is not None:
            return canonical
    elif len(text.split()) <= 4:
        # No formatting signal but short standalone paragraph: exact canonical
        # heading match only. This still accepts punctuation-only suffixes such
        # as "Skills:" because the shared taxonomy strips trailing punctuation.
        canonical = _canonicalize_section_label(text, allow_partial=False)
        if canonical is not None:
            return canonical
    return None


def _normalize_language_code(language: Optional[str]) -> str:
    """Normalize a language hint to 'fr', 'en', or 'original'."""
    lang = (language or "original").strip().lower()
    if lang in {"fr", "fr-fr", "french", "francais", "français"}:
        return "fr"
    if lang in {"en", "en-us", "en-gb", "english"}:
        return "en"
    return "original"


def _infer_template_language(template_path: str) -> str:
    """Infer a French/English template language from visible template text."""
    try:
        full_text, paragraphs = _extract_all_text(template_path)
    except Exception as exc:
        logger.warning("Template language inference failed for %s: %s", template_path, exc)
        return "original"

    sample_parts = [p.strip() for p in paragraphs if p and p.strip()]
    if not sample_parts and full_text:
        sample_parts = [full_text]
    if not sample_parts:
        return "original"

    sample = ' '.join(sample_parts[:120])
    normalized = unicodedata.normalize('NFKD', sample)
    normalized = normalized.encode('ascii', 'ignore').decode('ascii').lower()

    marker_map = {
        'fr': {
            'profil', 'resume', 'competences', 'experience professionnelle',
            'formation', 'formations', 'langues', 'centre d interet',
            'centres d interet', 'telephone', 'courriel', 'adresse',
        },
        'en': {
            'profile', 'summary', 'skills', 'experience', 'education',
            'languages', 'interests', 'phone', 'email', 'address', 'objective',
        },
    }

    scores = {'fr': 0, 'en': 0}
    for lang, markers in marker_map.items():
        for marker in markers:
            pattern = r'(?<![a-z])' + re.escape(marker) + r'(?![a-z])'
            if re.search(pattern, normalized):
                scores[lang] += 1

    if scores['fr'] > scores['en']:
        return 'fr'
    if scores['en'] > scores['fr']:
        return 'en'
    return 'original'


def _resolve_generation_language(template_path: str, requested_language: Optional[str]) -> str:
    """Resolve the effective generation language from the request and template."""
    normalized = _normalize_language_code(requested_language)
    if normalized != 'original':
        return normalized

    inferred = _infer_template_language(template_path)
    return inferred if inferred in {'fr', 'en'} else 'original'


def _language_instruction(language: Optional[str]) -> str:
    """Return a strict language instruction for LLM prompts."""
    lang = _normalize_language_code(language)
    if lang == "fr":
        return "Write strictly in French. Do not output English."
    if lang == "en":
        return "Write strictly in English. Do not output French."
    return "Write in the same language as the profile/template data."


def _normalize_employee_language_for_generation(
    employee_data: Dict[str, Any],
    preferred_language: Optional[str],
) -> Dict[str, Any]:
    """Return employee data normalized to the requested output language.

    This keeps summary, experience, education, projects, and other visible text
    in the same target language before either placeholder-mode or fallback
    replacement-mode rendering starts.
    """
    lang = _normalize_language_code(preferred_language)
    if lang not in {"fr", "en"}:
        return employee_data

    try:
        translated = translate_cv_best_effort(employee_data, lang)
        if isinstance(translated, dict) and translated:
            logger.info("Normalized employee content to target language: %s", lang)
            return translated
    except Exception as exc:
        logger.warning("Employee language normalization failed for %s: %s", lang, exc)

    return employee_data


def _groq_with_retry(fn, max_attempts: int = 3, base_delay: float = 2.0):
    """Call fn() with exponential back-off on Groq transient errors.

    Retries on rate-limit (429), gateway (502/503), and connection errors.
    Raises immediately for auth errors (401) and invalid-request (400).
    """
    import time
    global _GROQ_RATE_LIMIT_COOLDOWN_UNTIL, _GROQ_RATE_LIMIT_REASON

    now = time.monotonic()
    if now < _GROQ_RATE_LIMIT_COOLDOWN_UNTIL:
        remaining = max(0.0, _GROQ_RATE_LIMIT_COOLDOWN_UNTIL - now)
        raise RuntimeError(
            f"Groq rate-limit cooldown active for {remaining:.1f}s: {_GROQ_RATE_LIMIT_REASON}"
        )

    last_exc: Exception = RuntimeError("no attempts made")
    for attempt in range(max_attempts):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            msg = str(exc).lower()
            if _is_groq_rate_limit_error(exc):
                retry_after = max(_groq_retry_after_seconds(str(exc)), 60.0)
                _GROQ_RATE_LIMIT_COOLDOWN_UNTIL = time.monotonic() + retry_after
                _GROQ_RATE_LIMIT_REASON = str(exc)
                logger.warning(
                    "Groq quota/rate limit reached; using deterministic fallback for %.1fs: %s",
                    retry_after,
                    exc,
                )
                raise
            is_transient = any(
                x in msg
                for x in ("rate_limit", "rate limit", "429", "503", "502",
                           "timeout", "timed out", "connection", "network")
            )
            if is_transient and attempt < max_attempts - 1:
                delay = base_delay * (2 ** attempt)
                logger.warning(
                    "Groq transient error (attempt %d/%d): %s — retrying in %.1fs",
                    attempt + 1, max_attempts, exc, delay,
                )
                time.sleep(delay)
            else:
                raise
    raise last_exc


def _trim_employee_for_groq(
    employee: Dict[str, Any],
    max_exp: int = 5,
    max_edu: int = 3,
    max_skills: int = 20,
) -> Dict[str, Any]:
    """Return a size-capped copy of employee for Groq prompts.

    Strips binary photo data and caps list fields so the serialised JSON
    stays well within Groq's context limit on every request.
    """
    trimmed = dict(employee)
    if isinstance(trimmed.get("experience"), list):
        trimmed["experience"] = trimmed["experience"][:max_exp]
    if isinstance(trimmed.get("education"), list):
        trimmed["education"] = trimmed["education"][:max_edu]
    if isinstance(trimmed.get("skills"), list):
        trimmed["skills"] = trimmed["skills"][:max_skills]
    if isinstance(trimmed.get("certifications"), list):
        trimmed["certifications"] = trimmed["certifications"][:10]
    if isinstance(trimmed.get("projects"), list):
        trimmed["projects"] = trimmed["projects"][:5]
    if trimmed.get('_title_derived'):
        trimmed['title'] = ''
    trimmed.pop("photo", None)
    return trimmed


def _groq_generate_skills(
    employee: Dict[str, Any],
    api_key: str,
    preferred_language: Optional[str] = None,
) -> Optional[str]:
    """
    Ask Groq to synthesize a concise skills paragraph from the employee's
    full profile (skills array, certifications, education, projects).
    Returns a single comma-separated string, or None on failure.
    """
    def _as_list(value: Any) -> List[Any]:
        if value is None:
            return []
        if isinstance(value, list):
            return value
        if isinstance(value, tuple):
            return list(value)
        return [value]

    def _extract_text(value: Any, *keys: str) -> str:
        if isinstance(value, dict):
            for key in keys:
                text = str(value.get(key) or '').strip()
                if text:
                    return text
            return ''
        return str(value).strip() if value is not None else ''

    skills = [
        _extract_text(skill, 'name', 'label', 'skill', 'skillName')
        for skill in _as_list(employee.get('skills'))
    ]
    certs = [
        _extract_text(cert, 'name', 'title', 'label')
        for cert in _as_list(employee.get('certifications'))
    ]
    edus = [
        _extract_text(edu, 'degree', 'institution', 'school', 'university')
        for edu in _as_list(employee.get('education'))
    ]
    projs = [
        _extract_text(project, 'description', 'name', 'title', 'role')
        for project in _as_list(employee.get('projects'))
    ]

    profile = {
        'skills': [skill for skill in skills if skill][:30],
        'certifications': [c for c in certs if c][:10],
        'education': [e for e in edus if e][:4],
        'projects_summary': [p for p in projs if p][:5],
    }

    lang_rule = _language_instruction(preferred_language)
    prompt = (
        "Based on this employee profile, produce a single short paragraph "
        "(max 60 words) of technical skills and competencies, "
        "written as a comma-separated list suitable for a CV skills section. "
        f"{lang_rule} "
        "Do NOT include certifications verbatim — extract only skill keywords. "
        "Return ONLY the skills text, no commentary.\n\n"
        f"Profile:\n{json.dumps(profile, ensure_ascii=False)}"
    )

    try:
        client = Groq(api_key=api_key, timeout=settings.GROQ_TIMEOUT_SECONDS)
        resp = _groq_with_retry(lambda: client.chat.completions.create(
            model=settings.GROQ_CV_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=settings.GROQ_PAIRS_TEMPERATURE,
            max_tokens=200,
        ))
        text = (resp.choices[0].message.content or '').strip()
        text = re.sub(r'^```[^\n]*\n?', '', text)
        text = re.sub(r'\n?```$', '', text).strip()
        if text:
            logger.info(f"Groq skills synthesis: {text[:120]}")
            return text
    except Exception as exc:
        logger.warning(f"Groq skills synthesis failed: {exc}")
    return None


def _groq_generate_summary(
    employee: Dict[str, Any],
    api_key: str,
    preferred_language: Optional[str] = None,
) -> Optional[str]:
    """
    Ask Groq to generate a professional summary paragraph for the employee.

    Used when the template contained a summary/objective block but the employee
    record has no pre-written summary.  Returns a short paragraph (3–4 sentences,
    max ~80 words) or None on failure.
    """
    exp    = employee.get('experience') or []
    edu    = employee.get('education') or []
    skills = employee.get('skills') or []
    title  = employee.get('title', '')

    profile = {
        'title': title,
        'skills': skills[:15],
        'experience': [
            {
                'title':   e.get('title', ''),
                'company': e.get('company', ''),
                'dates':   e.get('dates') or e.get('start_date', ''),
            }
            for e in exp[:3]
        ],
        'education': [
            {'degree': e.get('degree', ''), 'institution': e.get('institution', '')}
            for e in edu[:2]
        ],
    }

    lang_rule = _language_instruction(preferred_language)
    prompt = (
        "Based on this employee profile, write a professional CV summary paragraph "
        "(3–4 sentences, max 80 words). Use a confident, professional tone. "
        f"{lang_rule} "
        "Return ONLY the summary text — no title, no labels, no commentary.\n\n"
        f"Profile:\n{json.dumps(profile, ensure_ascii=False)}"
    )

    try:
        client = Groq(api_key=api_key, timeout=settings.GROQ_TIMEOUT_SECONDS)
        resp = _groq_with_retry(lambda: client.chat.completions.create(
            model=settings.GROQ_CV_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=settings.GROQ_SUMMARY_TEMPERATURE,
            max_tokens=200,
        ))
        text = (resp.choices[0].message.content or '').strip()
        text = re.sub(r'^```[^\n]*\n?', '', text)
        text = re.sub(r'\n?```$', '', text).strip()
        if text:
            logger.info(f"Groq summary generation: {text[:120]}")
            return text
    except Exception as exc:
        logger.warning(f"Groq summary generation failed: {exc}")
    # Deterministic fallback: build summary from structured data when Groq is unavailable.
    # Language-aware: English when preferred_language starts with "en", French otherwise.
    title     = (employee.get('title') or '').strip()
    exp       = employee.get('experience') or []
    companies = [
        (e.get('company') or e.get('companyName') or '')
        for e in exp[:3]
        if (e.get('company') or e.get('companyName') or '').strip()
    ]
    fb_parts: List[str] = []
    is_english = preferred_language and preferred_language.lower().startswith("en")
    if is_english:
        if title:
            fb_parts.append(f"Professional specialising in {title}")
        if companies:
            fb_parts.append(f"with experience at {', '.join(companies)}")
        if len(exp) > 1:
            fb_parts.append(f"across {len(exp)} roles")
    else:
        if title:
            fb_parts.append(f"Professionnel spécialisé en {title}")
        if companies:
            fb_parts.append(f"avec une expérience chez {', '.join(companies)}")
        if len(exp) > 1:
            fb_parts.append(f"fort d'un parcours de {len(exp)} postes")
    fallback = (' '.join(fb_parts) + '.').strip() if fb_parts else ''
    if fallback:
        logger.info(f"[summary_fallback] Built from structured data: {fallback[:80]}")
        return fallback
    return None


def build_structured_cv_sections_payload(employee: Dict[str, Any]) -> Dict[str, Any]:
    """
    Build a canonical, section-structured payload for CV rendering.

    Output schema:
      {
        "sections": {
          "summary": str,
          "education": [{"degree": str, "institution": str, "dates": str}],
          "experience": [{"title": str, "company": str, "dates": str}],
          "skills": [str],
          "certifications": [str],
          "projects": [str]
        }
      }
    """
    _YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")
    _PRESENT_RE = re.compile(
        r"\b(present|current|ongoing|now|en cours|actuel|actuelle|pr[ée]sent)\b",
        re.IGNORECASE,
    )

    def _strip(v: Any) -> str:
        if v is None:
            return ""
        return str(v).strip()

    def _is_current(value: Any) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if value is None:
            return False
        return str(value).strip().lower() in {"true", "1", "yes", "y"}

    def _year_only(value: Any) -> str:
        text = _strip(value)
        if not text:
            return ""
        m = _YEAR_RE.search(text)
        return m.group(0) if m else ""

    def _normalize_dates(
        dates: Any = None,
        start_date: Any = None,
        end_date: Any = None,
        is_current: Any = None,
    ) -> str:
        start_year = _year_only(start_date)
        end_year = _year_only(end_date)
        raw = _strip(dates)

        if raw and not start_year:
            years = [m.group(0) for m in _YEAR_RE.finditer(raw)]
            if years:
                start_year = years[0]
                if len(years) > 1 and not end_year:
                    end_year = years[1]
        if _is_current(is_current) or (raw and _PRESENT_RE.search(raw)):
            end_year = "Present"

        if start_year and end_year:
            return f"{start_year} - {end_year}"
        if start_year and _is_current(is_current):
            return f"{start_year} - Present"
        return start_year or end_year

    # Accept both normalized fallback payload and raw backend payload shapes.
    raw_experience = employee.get("experience")
    if not isinstance(raw_experience, list):
        raw_experience = employee.get("workExperiences")
    if not isinstance(raw_experience, list):
        raw_experience = []

    experience: List[Dict[str, str]] = []
    for exp in raw_experience:
        if not isinstance(exp, dict):
            continue
        title = _strip(exp.get("title") or exp.get("jobTitle"))
        company = _strip(exp.get("company") or exp.get("companyName"))
        if not title or not company:
            continue
        dates = _normalize_dates(
            dates=exp.get("dates") or exp.get("date_range") or exp.get("period"),
            start_date=exp.get("startDate") or exp.get("start_date"),
            end_date=exp.get("endDate") or exp.get("end_date"),
            is_current=exp.get("isCurrent") or exp.get("is_current"),
        )
        experience.append({
            "title": title,
            "company": company,
            "dates": dates,
        })

    raw_education = employee.get("education")
    if not isinstance(raw_education, list):
        raw_education = employee.get("educations")
    if not isinstance(raw_education, list):
        raw_education = []

    education: List[Dict[str, str]] = []
    for edu in raw_education:
        if not isinstance(edu, dict):
            continue
        degree = _strip(
            edu.get("degree") or edu.get("fieldOfStudy") or edu.get("field_of_study")
        )
        institution = _strip(
            edu.get("institution") or edu.get("school") or edu.get("university")
        )
        # Keep entry if at least one of degree / institution is present
        if not degree and not institution:
            continue
        dates = _normalize_dates(
            dates=edu.get("dates") or edu.get("date") or edu.get("graduationDate"),
            start_date=edu.get("startDate") or edu.get("start_date"),
            end_date=edu.get("endDate") or edu.get("end_date"),
        )
        education.append({
            "degree": degree,
            "institution": institution,
            "dates": dates,
        })

    raw_skills = employee.get("skills") or []
    if isinstance(raw_skills, str):
        raw_skills = [s.strip() for s in raw_skills.split(",") if s.strip()]
    elif not isinstance(raw_skills, list):
        raw_skills = []
    skills: List[str] = []
    for skill in raw_skills:
        text = _strip(skill)
        if text:
            skills.append(text)

    raw_certs = employee.get("certifications") or []
    if not isinstance(raw_certs, list):
        raw_certs = []
    certifications: List[str] = []
    for cert in raw_certs:
        if isinstance(cert, dict):
            name = _strip(cert.get("name"))
        else:
            name = _strip(cert)
        if name:
            certifications.append(name)

    raw_projects = employee.get("projects") or []
    if not isinstance(raw_projects, list):
        raw_projects = []
    projects: List[str] = []
    for proj in raw_projects:
        if isinstance(proj, dict):
            name = _strip(proj.get("name") or proj.get("title"))
            role = _strip(proj.get("role"))
            desc = _strip(proj.get("description"))
            text = name or role or desc
        else:
            text = _strip(proj)
        if text:
            projects.append(text)

    summary_text = _strip(
        employee.get("summary")
        or employee.get("professionalSummary")
        or employee.get("professional_summary")
    )

    return {
        "sections": {
            "summary": summary_text,
            "education": education,
            "experience": experience,
            "skills": skills,
            "certifications": certifications,
            "projects": projects,
        }
    }


def _build_section_content(
    section: str,
    employee: Dict[str, Any],
    preferred_language: Optional[str] = None,
) -> Optional[List[Dict]]:
    """
    Return a list of {text, bold, bullet} dicts for a CV section,
    built from the employee's structured data.
    Returns None if no data is available for that section.

    Every returned dict is guaranteed to have 'text' (str), 'bold' (bool),
    and 'bullet' (bool) keys.
    """
    def _strip(v: Any) -> str:
        if v is None:
            return ''
        return str(v).strip()

    def _as_list(value: Any) -> List[Any]:
        if value is None:
            return []
        if isinstance(value, list):
            return value
        if isinstance(value, tuple):
            return list(value)
        return [value]

    def _extract_named_text(value: Any, *keys: str) -> str:
        if isinstance(value, dict):
            for key in keys:
                text = _strip(value.get(key))
                if text:
                    return text
            return ''
        return _strip(value)

    def _entry_meta_line(*parts: Any) -> str:
        values = [_strip(part) for part in parts if _strip(part)]
        return '  —  '.join(values)

    sections_payload = build_structured_cv_sections_payload(employee).get("sections", {})

    if section == 'summary':
        text = _strip(sections_payload.get('summary'))
        if not text:
            # Attempt Groq generation when no pre-written summary is in the profile
            api_key = settings.GROQ_API_KEY
            if api_key:
                generated = _groq_generate_summary(employee, api_key, preferred_language)
                if generated:
                    text = generated
                    logger.info("[_build_section_content] Groq summary injected")
        return [{'text': text, 'bold': False, 'bullet': False}] if text else None

    elif section == 'experience':
        exps = sections_payload.get('experience') or []
        if not exps:
            return None

        # Preserve optional descriptions from source entries when available.
        source_desc: Dict[Tuple[str, str], str] = {}
        for src in _as_list(employee.get('experience')):
            if not isinstance(src, dict):
                continue
            src_title = _strip(src.get('title') or src.get('jobTitle'))
            src_company = _strip(src.get('company') or src.get('companyName'))
            if not src_title or not src_company:
                continue
            src_desc = _strip(
                src.get('description') or
                src.get('responsibilities') or
                src.get('tasks') or
                src.get('duties') or
                src.get('achievements') or
                src.get('role') or
                ''
            )
            if src_desc:
                source_desc[(src_title, src_company)] = src_desc

        lines: List[Dict] = []
        for exp in exps:
            title = _strip(exp.get('title'))
            company = _strip(exp.get('company'))
            dates = _strip(exp.get('dates'))
            desc = source_desc.get((title, company), '')
            # Cap description length to prevent textbox overflow
            if len(desc) > 1500:
                desc = desc[:1500].rsplit(' ', 1)[0] + '…'
            if title:
                lines.append({'text': title, 'bold': True, 'bullet': False})
            meta = _entry_meta_line(company, dates)
            if meta:
                lines.append({'text': meta, 'bold': False, 'bullet': False, 'compact': True})
            for dl in desc.split('\n'):
                dl = dl.strip().lstrip('•●-– ').strip()
                if dl:
                    lines.append({'text': dl, 'bold': False, 'bullet': True, 'compact': True})
        return lines or None

    elif section == 'education':
        edus = sections_payload.get('education') or []
        if not edus:
            return None
        lines = []
        for edu in edus:
            degree      = _strip(edu.get('degree'))
            institution = _strip(edu.get('institution'))
            dates = _strip(edu.get('dates'))
            if degree:
                lines.append({'text': degree, 'bold': True, 'bullet': False})
            meta = _entry_meta_line(institution, dates)
            if meta:
                lines.append({'text': meta, 'bold': False, 'bullet': False, 'compact': True})
        return lines or None

    elif section == 'skills':
        # Gather all skill-related data from the employee record
        skills = _as_list(employee.get('skills'))
        certs = _as_list(employee.get('certifications'))
        projs = _as_list(employee.get('projects'))
        if not skills and not certs and not projs:
            return None
        # Try Groq synthesis first; fall back to formatted list
        api_key = settings.GROQ_API_KEY
        if api_key and (certs or projs):
            synthesized = _groq_generate_skills(employee, api_key, preferred_language)
            if synthesized:
                return [{'text': synthesized, 'bold': False, 'bullet': False}]
        # Fallback: build from skills array + tech keywords extracted from cert names
        skill_list = []
        for skill in skills:
            text = _extract_named_text(skill, 'name', 'label', 'skill', 'skillName')
            if text:
                skill_list.append(text)
        cert_names = [
            _extract_named_text(c, 'name', 'title', 'label')
            for c in certs
        ]
        cert_names = [c for c in cert_names if c]
        # Extract technology/product keywords from cert names (CamelCase, brand names,
        # or abbreviated identifiers that are recognisably technical)
        _TECH_KW_RE = re.compile(
            r'\b(DELL|HP|IBM|VMware|Microsoft|Compellent|PowerVault|PowerEdge|'
            r'FluidFS|Hyper-V|StorageWorks|BladeCenter|MCSA|MCSE|Cisco|Linux|'
            r'Windows|Server|Storage|Blade|Cloud|NAS|SAN|vSphere|ESXi|'
            r'SQL|Exchange|SharePoint|Azure|AWS|Docker|Kubernetes|Python|Java|'
            r'React|Angular|Node)\b',
            re.I,
        )
        seen: set = set(s.lower() for s in skill_list)
        for cn in cert_names:
            for m in _TECH_KW_RE.finditer(cn):
                kw = m.group()
                if kw.lower() not in seen:
                    skill_list.append(kw)
                    seen.add(kw.lower())
        text = ', '.join(skill_list) if skill_list else None
        return [{'text': text, 'bold': False, 'bullet': False}] if text else None

    elif section == 'projects':
        projects = _as_list(employee.get('projects'))
        if not projects:
            return None
        lines = []
        for proj in projects:
            if isinstance(proj, dict):
                name = _strip(proj.get('name') or proj.get('title'))
                client = _strip(proj.get('client') or proj.get('company') or proj.get('clientName'))
                period = _strip(
                    proj.get('year') or proj.get('dates') or proj.get('period')
                    or proj.get('startDate') or proj.get('start_date')
                )
                project_skills = []
                for skill in _as_list(proj.get('skills')):
                    text = _extract_named_text(skill, 'name', 'label', 'skill', 'skillName')
                    if text:
                        project_skills.append(text)
                skill_list = ', '.join(project_skills)
                desc = _strip(proj.get('description'))
                role = _strip(proj.get('role'))
                header = name or role or skill_list
                meta_parts = []
                if client:
                    meta_parts.append(client)
                if skill_list and skill_list != header:
                    meta_parts.append(skill_list)
                if period:
                    meta_parts.append(period)
                meta = _entry_meta_line(*meta_parts)
                body = desc or role
            else:
                header = _strip(proj)
                meta = ''
                body = ''
            if not header and not body:
                continue
            if header:
                lines.append({'text': header, 'bold': True, 'bullet': False})
            if meta:
                lines.append({'text': meta, 'bold': False, 'bullet': False, 'compact': True})
            if body:
                for dl in body.split('\n'):
                    dl = dl.strip().lstrip('•●-– ').strip()
                    if dl:
                        lines.append({'text': dl, 'bold': False, 'bullet': True})
        return lines or None

    elif section == 'certifications':
        certs = _as_list(employee.get('certifications'))
        if not certs:
            return None
        names = [_extract_named_text(c, 'name', 'title', 'label') for c in certs]
        names = [n for n in names if n]
        if not names:
            return None
        return [{'text': n, 'bold': False, 'bullet': True} for n in names]

    elif section == 'languages':
        langs = _as_list(employee.get('languages'))
        if not langs:
            return None
        lang_names = [
            _extract_named_text(l, 'name', 'language', 'label', 'lang')
            for l in langs
        ]
        lang_names = [name for name in lang_names if name]
        if not lang_names:
            return None
        text = ', '.join(lang_names)
        return [{'text': text, 'bold': False, 'bullet': False}] if text else None

    elif section == 'interests':
        interests = _as_list(employee.get('interests'))
        if not interests:
            return None
        items_list = [
            _extract_named_text(i, 'name', 'label', 'title')
            for i in interests
        ]
        items_list = [i for i in items_list if i]
        return [{'text': i, 'bold': False, 'bullet': True} for i in items_list] if items_list else None

    return None


def _build_section_table_rows(
    section: str,
    employee: Dict[str, Any],
) -> Optional[List[List[str]]]:
    """
    Build table row data for table-based section replacement.
    Each row is a list of cell text strings.
    Returns None when no employee data is available for that section.
    """
    _YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")
    _PRESENT_RE = re.compile(
        r"\b(present|current|ongoing|now|en cours|actuel|actuelle|pr[ée]sent)\b",
        re.IGNORECASE,
    )

    def _s(v: Any) -> str:
        return (v or '').strip() if v is not None else ''

    def _is_current(value: Any) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if value is None:
            return False
        return str(value).strip().lower() in {"true", "1", "yes", "y"}

    def _year_only(value: Any) -> str:
        txt = _s(value)
        if not txt:
            return ''
        m = _YEAR_RE.search(txt)
        return m.group(0) if m else ''

    def _norm_dates(
        dates: Any = None,
        start_date: Any = None,
        end_date: Any = None,
        is_current: Any = None,
    ) -> str:
        start_year = _year_only(start_date)
        end_year = _year_only(end_date)
        raw = _s(dates)
        if raw and not start_year:
            years = [m.group(0) for m in _YEAR_RE.finditer(raw)]
            if years:
                start_year = years[0]
                if len(years) > 1 and not end_year:
                    end_year = years[1]
        if _is_current(is_current) or (raw and _PRESENT_RE.search(raw)):
            end_year = "Present"

        if start_year and end_year:
            return f"{start_year} - {end_year}"
        if start_year and _is_current(is_current):
            return f"{start_year} - Present"
        return start_year or end_year

    sections_payload = build_structured_cv_sections_payload(employee).get("sections", {})

    if section == 'experience':
        exps = sections_payload.get('experience') or []
        if not exps:
            return None
        rows = []
        for exp in exps:
            dates = _s(exp.get('dates'))
            company = _s(exp.get('company'))
            title = _s(exp.get('title'))
            rows.append([dates, company, title])
        return rows or None

    elif section == 'certifications':
        certs = employee.get('certifications') or []
        if not certs:
            return None
        rows = []
        for c in certs:
            if isinstance(c, str):
                name, date = c, ''
            else:
                name = _s(c.get('name'))
                date = _s(c.get('date_obtained') or c.get('date'))
            if name:
                rows.append([name, date])
        return rows or None

    elif section == 'education':
        edus = sections_payload.get('education') or []
        if not edus:
            return None
        rows = []
        for edu in edus:
            dates = _s(edu.get('dates'))
            institution = _s(edu.get('institution'))
            degree = _s(edu.get('degree'))
            rows.append([dates, institution, degree])
        return rows or None

    elif section == 'projects':
        projects = employee.get('projects') or []
        if not projects:
            return None
        rows = []
        for proj in projects:
            # Year/dates: try explicit 'year', then 'dates', then build from startDate/endDate
            year = _norm_dates(
                dates=proj.get('year') or proj.get('dates'),
                start_date=proj.get('startDate') or proj.get('start_date'),
                end_date=proj.get('endDate') or proj.get('end_date'),
                is_current=proj.get('isCurrent') or proj.get('is_current'),
            )
            client = _s(proj.get('client') or proj.get('company') or proj.get('clientName'))
            name = _s(proj.get('name') or proj.get('title'))
            desc = _s(proj.get('description'))
            proj_text = f"{name} \u2014 {desc}" if name and desc else (name or desc)
            rows.append([year, client, proj_text])
        return rows or None

    return None


def _fill_table_section(
    tbl_elem,
    rows_data: List[List[str]],
) -> int:
    """
    Replace data rows in a DOCX table element with new rows_data.
    Keeps the first row (assumed header) intact.
    Returns the count of data rows inserted.
    """
    W = NS_W
    trs = tbl_elem.findall(f'{{{W}}}tr')
    if not trs:
        return 0

    header_row = trs[0]
    template_row = trs[-1] if len(trs) > 1 else header_row
    # Use DIRECT children only — .//{W}tc finds nested merged cells too
    num_cols = len(header_row.findall(f'./{{{W}}}tc'))

    # Remove all rows after the header
    for tr in trs[1:]:
        tbl_elem.remove(tr)

    prev_row = header_row
    for row_data in rows_data:
        new_tr = copy.deepcopy(template_row)
        cells = new_tr.findall(f'./{{{W}}}tc')  # direct children only
        padded = (list(row_data) + [''] * num_cols)[:num_cols]
        for i, tc in enumerate(cells):
            text = padded[i] if i < len(padded) else ''
            paras = tc.findall(f'{{{W}}}p')
            target_p = paras[0] if paras else etree.SubElement(tc, f'{{{W}}}p')
            for extra_p in paras[1:]:
                tc.remove(extra_p)
            runs = target_p.findall(f'{{{W}}}r')
            ref_rPr = None
            if runs:
                rpr_el = runs[0].find(f'{{{W}}}rPr')
                if rpr_el is not None:
                    ref_rPr = copy.deepcopy(rpr_el)
                    for _bold_tag in (f'{{{W}}}b', f'{{{W}}}bCs'):
                        _b = ref_rPr.find(_bold_tag)
                        if _b is not None:
                            ref_rPr.remove(_b)
                for r in runs:
                    target_p.remove(r)
            new_r = etree.SubElement(target_p, f'{{{W}}}r')
            if ref_rPr is not None:
                new_r.insert(0, ref_rPr)
            t_elem = etree.SubElement(new_r, f'{{{W}}}t')
            t_elem.text = text
            if text and (text[0] == ' ' or text[-1] == ' '):
                t_elem.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
        prev_row.addnext(new_tr)
        prev_row = new_tr

    return len(rows_data)


def _is_docxtpl_scaffold_table(tbl_elem: Any) -> bool:
    """Return True when a table is only a docxtpl row-loop scaffold."""
    W = NS_W
    rows = tbl_elem.findall(f'{{{W}}}tr')
    if not rows:
        return False

    max_cols = 0
    for row in rows:
        max_cols = max(max_cols, len(row.findall(f'./{{{W}}}tc')))

    raw = etree.tostring(tbl_elem)
    return max_cols <= 1 and (b'{%' in raw or b'{{' in raw)


def _get_ref_rpr(content_elems: list) -> Optional[Any]:
    """Extract <w:rPr> from content paragraphs, preferring body-text runs.

    Skips runs that are bold AND have a large font size (>14pt / sz>28) so
    that heading-style formatting from template skill-chips or section titles
    is not accidentally inherited by inserted body content.  Falls back to
    the first run found if no body-text run exists.
    """
    W = NS_W
    first_found = None
    for p_elem in content_elems:
        for r in p_elem.iter(f'{{{W}}}r'):
            rprs = r.findall(f'{{{W}}}rPr')
            if not rprs:
                continue
            rpr = rprs[0]
            if first_found is None:
                first_found = rpr
            is_bold = rpr.find(f'{{{W}}}b') is not None
            sz_elem = rpr.find(f'{{{W}}}sz')
            sz_val = int(sz_elem.get(f'{{{W}}}val', '0')) if sz_elem is not None else 0
            if not is_bold and sz_val <= 28:  # 28 half-points = 14pt
                return copy.deepcopy(rpr)
    if first_found is None:
        return None
    result = copy.deepcopy(first_found)
    # Fallback path: strip oversized font so body text doesn't inherit
    # heading/chip sizing. Keep font face and colour; only drop size.
    sz_el = result.find(f'{{{W}}}sz')
    if sz_el is not None:
        try:
            if int(sz_el.get(f'{{{W}}}val', '0')) > 24:  # > 12pt
                result.remove(sz_el)
                szcs = result.find(f'{{{W}}}szCs')
                if szcs is not None:
                    result.remove(szcs)
        except (ValueError, TypeError):
            pass
    return result


def _get_ref_ppr_spacing(content_elems: list) -> Optional[Any]:
    """Extract <w:spacing> from the <w:pPr> of the first non-empty content paragraph.

    Used to copy line/paragraph spacing into injected paragraphs so they do not
    collapse visually (stacking text on top of each other).
    """
    W = NS_W
    for p_elem in content_elems:
        if p_elem.tag != f'{{{W}}}p':
            continue
        ppr = p_elem.find(f'{{{W}}}pPr')
        if ppr is None:
            continue
        sp = ppr.find(f'{{{W}}}spacing')
        if sp is not None:
            return copy.deepcopy(sp)
    return None


def _spacing_line_only(spacing_elem: Any) -> Optional[Any]:
    """Return a new <w:spacing> element that keeps only w:line/w:lineRule.

    Used for paragraphs that sit *inside* an entry (immediately after a
    compact date/company line).  Dropping w:before prevents the large
    entry-separation gap from appearing between the date line and the
    job-title line that belongs to the same entry.
    """
    if spacing_elem is None:
        return None
    W = NS_W
    line = spacing_elem.get(f'{{{W}}}line')
    line_rule = spacing_elem.get(f'{{{W}}}lineRule')
    if not line:
        return None
    sp = etree.Element(f'{{{W}}}spacing')
    sp.set(f'{{{W}}}line', line)
    if line_rule:
        sp.set(f'{{{W}}}lineRule', line_rule)
    return sp


def _para_has_drawing_or_textbox(p_elem: Any) -> bool:
    """Return True if this paragraph embeds a drawing, shape, or textbox.

    Such paragraphs are visual layout elements (sidebars, header panels, etc.)
    and must never be removed when wiping section content.
    """
    raw = etree.tostring(p_elem)
    return (
        b'txbxContent' in raw
        or b'mc:AlternateContent' in raw
        or b'w:drawing' in raw
        or b'<w:pict' in raw
    )


def _para_is_textbox(p_elem: Any) -> bool:
    """Return True if this paragraph contains an actual text-holding textbox.

    Uses `txbxContent` as the definitive marker — this element is present only
    inside real textboxes (`<wps:txbx>` or VML `<v:textbox>`) and not in plain
    drawings, decorative shapes, or `<mc:AlternateContent>` wrappers around
    `<w:drawing>`/`<w:pict>` alternative renderings.
    """
    return b'txbxContent' in etree.tostring(p_elem)


def _para_is_drawing_only(p_elem: Any) -> bool:
    """Return True if this paragraph contains a drawing but NOT a real textbox."""
    raw = etree.tostring(p_elem)
    has_draw = b'w:drawing' in raw or b'<w:pict' in raw
    has_txbx = b'txbxContent' in raw   # only real textbox marker
    return has_draw and not has_txbx


def _collect_removable(content_children: List[Any]) -> List[Any]:
    """
    Walk content_children and build the list of elements to remove.

    Rules:
    - Textbox / drawing paragraphs are always skipped (preserved).
    - If a drawing-only paragraph appears AFTER at least one textbox paragraph,
      it is a column-separator in two-column templates (e.g. the visual divider
      between the left sidebar and the right experience column). Stop scanning
      at that point to avoid deleting experience entries.
    - Drawing-only paragraphs that appear before any textbox are just visual
      decorations within the section (borders, etc.) — skip them but continue.
    """
    removable: List[Any] = []
    saw_textbox = False

    for c in content_children:
        if _para_is_textbox(c):
            saw_textbox = True
            # don't add — it's a protected layout element
        elif _para_is_drawing_only(c):
            if saw_textbox:
                # Drawing after a textbox = column separator → stop here
                break
            # Drawing before any textbox = section decorative border → skip, continue
        else:
            # Plain element (<w:p>, <w:tbl>, etc.) — safe to remove
            removable.append(c)

    return removable


def _extract_content_styles(removable_elems: list) -> Dict[str, Optional[str]]:
    """Extract named paragraph style IDs from removable content paragraphs.

    Categorises styles by their likely role so that replacement paragraphs can
    reuse the correct template style:

    * ``compact`` – style for date / period lines (short text containing a year)
    * ``bold``    – style for job-title / heading lines
    * ``normal``  – style for plain body / description lines

    Returns ``{compact: id_or_None, bold: id_or_None, normal: id_or_None}``.
    """
    W = NS_W
    styles: Dict[str, Optional[str]] = {'compact': None, 'bold': None, 'normal': None}

    for p in removable_elems:
        if p.tag != f'{{{W}}}p':
            continue
        texts = [t.text for t in p.iter(f'{{{W}}}t') if t.text]
        text = ''.join(texts).strip()
        if not text:
            continue
        pPr = p.find(f'{{{W}}}pPr')
        style_id = None
        if pPr is not None:
            ps = pPr.find(f'{{{W}}}pStyle')
            if ps is not None:
                style_id = ps.get(f'{{{W}}}val')
        if not style_id:
            continue

        # Classify using style name heuristics and text content
        sval = style_id.lower()
        has_year = bool(re.search(r'\d{4}', text))
        is_short = len(text) < 30
        is_date_style = any(kw in sval for kw in ('date', 'period', 'année'))

        if (is_date_style or (has_year and is_short)) and styles['compact'] is None:
            styles['compact'] = style_id
        elif styles['bold'] is None:
            styles['bold'] = style_id
        elif styles['normal'] is None and style_id not in (styles['compact'], styles['bold']):
            styles['normal'] = style_id

    return styles


def _content_item_reference_key(item: Dict[str, Any]) -> str:
    if item.get('compact') and not item.get('bullet'):
        return 'compact'
    if item.get('bullet'):
        return 'bullet'
    if item.get('bold'):
        return 'bold'
    return 'normal'


def _paragraph_has_numbering(p_elem: Any) -> bool:
    W = NS_W
    ppr = p_elem.find(f'{{{W}}}pPr')
    return ppr is not None and ppr.find(f'{{{W}}}numPr') is not None


def _paragraph_is_bullet_like(p_elem: Any) -> bool:
    text = _paragraph_plain_text(p_elem)
    return _paragraph_has_numbering(p_elem) or text.startswith(('•', '●', '-', '–'))


def _paragraph_has_bold_content(p_elem: Any) -> bool:
    return any(
        _run_is_bold(run)
        for run in _direct_paragraph_runs(p_elem)
        if _run_plain_text(run).strip()
    )


def _reference_paragraph_kind(p_elem: Any) -> str:
    text = _paragraph_plain_text(p_elem)
    if _paragraph_is_bullet_like(p_elem):
        return 'bullet'
    if re.search(r'\d{4}', text) and len(text) < 40:
        return 'compact'
    if _paragraph_has_bold_prefix_pattern(p_elem) or _paragraph_has_bold_content(p_elem):
        return 'bold'
    return 'normal'


def _build_reference_paragraph_map(reference_paras: List[Any]) -> Dict[str, Any]:
    reference_map: Dict[str, Any] = {}
    for para in reference_paras:
        if para.tag != f'{{{NS_W}}}p' or not _paragraph_plain_text(para):
            continue
        reference_map.setdefault('first', para)
        reference_map.setdefault(_reference_paragraph_kind(para), para)
    return reference_map


def _clone_paragraph_properties(
    ref_para: Any,
    *,
    spacing_override: Optional[Any] = None,
    keep_bullet: bool = True,
) -> Optional[Any]:
    W = NS_W
    ppr = ref_para.find(f'{{{W}}}pPr')
    if ppr is None and spacing_override is None:
        return None

    cloned = copy.deepcopy(ppr) if ppr is not None else etree.Element(f'{{{W}}}pPr')
    if not keep_bullet:
        num_pr = cloned.find(f'{{{W}}}numPr')
        if num_pr is not None:
            cloned.remove(num_pr)
    if spacing_override is not None:
        existing = cloned.find(f'{{{W}}}spacing')
        if existing is not None:
            cloned.remove(existing)
        cloned.append(copy.deepcopy(spacing_override))
    return cloned if len(cloned) > 0 else None


def _reference_run_properties(ref_para: Any, *, prefer_bold: Optional[bool]) -> Optional[Any]:
    W = NS_W
    fallback = None
    for run in _direct_paragraph_runs(ref_para):
        if not _run_plain_text(run).strip():
            continue
        rpr = run.find(f'{{{W}}}rPr')
        if rpr is None:
            continue
        is_bold = _run_is_bold(run)
        if prefer_bold is None or is_bold == prefer_bold:
            return copy.deepcopy(rpr)
        if fallback is None:
            fallback = copy.deepcopy(rpr)
    return fallback


def _make_para_from_reference(
    ref_para: Any,
    text: str,
    *,
    bold: bool = False,
    bullet: bool = False,
    spacing_override: Optional[Any] = None,
) -> Any:
    W = NS_W
    XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space'

    paragraph = etree.Element(f'{{{W}}}p')
    ppr = _clone_paragraph_properties(
        ref_para,
        spacing_override=spacing_override,
        keep_bullet=bullet,
    )
    if ppr is not None:
        paragraph.append(ppr)

    run = etree.SubElement(paragraph, f'{{{W}}}r')
    rpr = _reference_run_properties(ref_para, prefer_bold=bold if not bullet else None)
    if rpr is None and bold:
        rpr = etree.Element(f'{{{W}}}rPr')
        etree.SubElement(rpr, f'{{{W}}}b')
        etree.SubElement(rpr, f'{{{W}}}bCs')
    if rpr is not None and not bold:
        for tag in (f'{{{W}}}b', f'{{{W}}}bCs'):
            bold_elem = rpr.find(tag)
            if bold_elem is not None:
                rpr.remove(bold_elem)
    if rpr is not None:
        run.append(rpr)

    display_text = text if bullet and _paragraph_has_numbering(ref_para) else (f'\u2022 {text}' if bullet else text)
    parts = display_text.split('\n')
    for idx, part in enumerate(parts):
        text_elem = etree.SubElement(run, f'{{{W}}}t')
        text_elem.text = part
        if part != part.strip() or part == '':
            text_elem.set(XML_SPACE, 'preserve')
        if idx < len(parts) - 1:
            etree.SubElement(run, f'{{{W}}}br')

    return paragraph


def _render_section_paragraphs(
    items: List[Dict[str, Any]],
    reference_paras: List[Any],
    *,
    heading_elem: Optional[Any] = None,
    txbx_target: Optional[Any] = None,
) -> List[Any]:
    paragraphs = [
        para for para in reference_paras
        if para.tag == f'{{{NS_W}}}p' and _paragraph_plain_text(para)
    ]
    reference_map = _build_reference_paragraph_map(paragraphs)
    fallback_ref = reference_map.get('first')
    if fallback_ref is None:
        fallback_ref = heading_elem

    fallback_rpr = _get_ref_rpr(paragraphs)
    if fallback_rpr is None and heading_elem is not None:
        fallback_rpr = _get_ref_rpr([heading_elem])
    fallback_spacing = _get_ref_ppr_spacing(paragraphs)
    if fallback_spacing is None and heading_elem is not None:
        fallback_spacing = _get_ref_ppr_spacing([heading_elem])
    fallback_styles = _extract_content_styles(paragraphs)

    rendered_items = items
    if txbx_target is not None:
        rendered_items = _reflow_textbox_section_items(rendered_items, txbx_target, ref_rpr=fallback_rpr)

    rendered: List[Any] = []
    prev_was_compact = False
    for item in rendered_items:
        is_compact = bool(item.get('compact'))
        eff_spacing = (
            _spacing_line_only(fallback_spacing)
            if not is_compact and prev_was_compact
            else fallback_spacing
        )
        ref_para = reference_map.get(_content_item_reference_key(item))
        if ref_para is None and item.get('bullet'):
            ref_para = reference_map.get('normal')
            if ref_para is None:
                ref_para = reference_map.get('first')
        if ref_para is None and item.get('bold'):
            ref_para = reference_map.get('normal')
            if ref_para is None:
                ref_para = reference_map.get('first')

        if ref_para is not None and (not item.get('bullet') or _paragraph_is_bullet_like(ref_para)):
            rendered.append(
                _make_para_from_reference(
                    ref_para,
                    item['text'],
                    bold=item.get('bold', False),
                    bullet=item.get('bullet', False),
                    spacing_override=eff_spacing,
                )
            )
        elif fallback_ref is not None:
            style_id = None
            if is_compact and not item.get('bullet'):
                style_id = fallback_styles.get('compact')
            elif item.get('bold'):
                style_id = fallback_styles.get('bold')
            else:
                style_id = fallback_styles.get('normal')
            rendered.append(
                _make_para_elem(
                    item['text'],
                    bold=item.get('bold', False),
                    bullet=item.get('bullet', False),
                    ref_rpr=fallback_rpr,
                    ref_spacing=eff_spacing,
                    compact=is_compact,
                    style_id=style_id,
                )
            )
        else:
            rendered.append(
                _make_para_elem(
                    item['text'],
                    bold=item.get('bold', False),
                    bullet=item.get('bullet', False),
                    compact=is_compact,
                )
            )
        prev_was_compact = is_compact

    return rendered


def _make_para_elem(
    text: str,
    bold: bool = False,
    bullet: bool = False,
    ref_rpr=None,
    ref_spacing=None,
    compact: bool = False,
    style_id: Optional[str] = None,
) -> Any:
    """Create a <w:p> lxml element with the given text and formatting.

    ``ref_spacing`` is an optional <w:spacing> element cloned from a reference
    paragraph.  When provided it is inserted into <w:pPr> so the new paragraph
    inherits the same line/before/after spacing as the original content, preventing
    visual stacking (paragraphs rendered on top of each other).

    ``compact`` overrides spacing to a small after-value (80 twips ≈ 4pt) so that
    grouping lines (e.g. date + company) appear visually attached to the line below
    (the job title), instead of having the same large gap as between entries.

    ``style_id`` is an optional named paragraph style (e.g. ``Titre1``, ``Dates``).
    When provided the paragraph inherits spacing from the template's
    ``styles.xml``, so ``ref_spacing`` is skipped.  ``ref_rpr`` is still
    applied — inline run properties (font, color, size) faithfully reproduce the
    template's actual rendering and override style-level run formatting per OOXML
    precedence rules.
    """
    W = NS_W
    XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space'

    p = etree.Element(f'{{{W}}}p')

    # When a named style is provided it carries its own spacing — only fall
    # back to ref_spacing when no style.  ref_rpr is ALWAYS applied: inline
    # run properties (font, color, size) faithfully reproduce the template's
    # actual rendering; in OOXML inline rPr overrides style-level rPr.
    eff_spacing = ref_spacing if style_id is None else None
    eff_rpr = ref_rpr

    # Paragraph properties — spacing always injected when available
    ppr = None
    if style_id or eff_spacing is not None or bullet or compact:
        ppr = etree.SubElement(p, f'{{{W}}}pPr')
        # pStyle must be the first child of pPr per OOXML schema
        if style_id:
            ps = etree.SubElement(ppr, f'{{{W}}}pStyle')
            ps.set(f'{{{W}}}val', style_id)
        if compact and not style_id:
            # Small after-spacing: glues the grouping line to the next (title)
            # Skipped when a named style is set — the style carries its own spacing.
            sp = etree.SubElement(ppr, f'{{{W}}}spacing')
            sp.set(f'{{{W}}}after', '80')
        elif eff_spacing is not None:
            ppr.append(copy.deepcopy(eff_spacing))
        if bullet:
            ind = etree.SubElement(ppr, f'{{{W}}}ind')
            ind.set(f'{{{W}}}left', '360')

    r = etree.SubElement(p, f'{{{W}}}r')

    # Run properties — skip ref_rpr when a named style provides formatting
    rpr: Any = copy.deepcopy(eff_rpr) if eff_rpr is not None else None
    if bold and rpr is None and style_id is None:
        # Only inject <w:b> when there is no template formatting reference at all.
        # When ref_rpr OR a named style_id is available, the template's own
        # formatting is authoritative — adding bold would override the template's
        # deliberate non-bold style.
        rpr = etree.Element(f'{{{W}}}rPr')
        etree.SubElement(rpr, f'{{{W}}}b')
        etree.SubElement(rpr, f'{{{W}}}bCs')
    if rpr is not None and not bold:
        # Safety net: strip bold markers so heading-style ref_rpr doesn't make
        # body-text content (skills, summary, descriptions) appear title-sized.
        for _bold_tag in (f'{{{W}}}b', f'{{{W}}}bCs'):
            _b = rpr.find(_bold_tag)
            if _b is not None:
                rpr.remove(_b)
    if rpr is not None:
        r.insert(0, rpr)

    display_text = f'\u2022 {text}' if bullet else text
    parts = display_text.split('\n')
    for idx, part in enumerate(parts):
        t = etree.SubElement(r, f'{{{W}}}t')
        t.text = part
        if part != part.strip() or part == '':
            t.set(XML_SPACE, 'preserve')
        if idx < len(parts) - 1:
            etree.SubElement(r, f'{{{W}}}br')

    return p


def _reflow_text_to_width(text: str, chars_per_line: int) -> str:
    """Insert soft line breaks for narrow containers without changing styling."""
    raw = (text or '').strip()
    if not raw or chars_per_line <= 0 or len(raw) <= chars_per_line:
        return text

    comma_parts = [part.strip() for part in raw.split(',') if part.strip()]
    if 2 <= len(comma_parts) <= 4 and all(
        re.fullmatch(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ '\-]{0,24}", part)
        for part in comma_parts
    ):
        return text

    lines: List[str] = []
    for source_line in raw.splitlines() or [raw]:
        line = source_line.strip()
        if len(line) <= chars_per_line:
            lines.append(line)
            continue

        chunks: Optional[List[str]] = None
        for sep in ('  |  ', ' | ', '  —  ', ' — ', ', ', ' / ', ' - '):
            if sep not in line:
                continue
            parts = [part.strip() for part in line.split(sep) if part.strip()]
            if len(parts) < 2:
                continue
            built: List[str] = []
            current = parts[0]
            for part in parts[1:]:
                candidate = f"{current}{sep}{part}"
                if len(candidate) <= chars_per_line or len(current) < max(12, int(chars_per_line * 0.55)):
                    current = candidate
                else:
                    built.append(current)
                    current = part
            if current:
                built.append(current)
            if len(built) > 1:
                chunks = built
                break

        if chunks is None:
            chunks = textwrap.wrap(
                line,
                width=max(8, chars_per_line),
                break_long_words=False,
                break_on_hyphens=False,
            ) or [line]
        lines.extend(chunks)

    return '\n'.join(lines)


def _textbox_chars_per_line(txbx_or_content: Any, ref_rpr: Any = None) -> int:
    """Estimate chars per line for a textbox from its width and font size."""
    target = txbx_or_content
    if getattr(target, 'tag', None) != _WPS_TXBX and getattr(target, 'getparent', None):
        parent = target.getparent()
        if getattr(parent, 'tag', None) == _WPS_TXBX:
            target = parent

    curr_cx = _get_shape_cx(target)
    if curr_cx <= 0:
        return 0

    font_pt = 11.0
    if ref_rpr is not None:
        sz = ref_rpr.find(f'{{{NS_W}}}sz')
        if sz is not None:
            try:
                half_pts = int(sz.get(f'{{{NS_W}}}val', '0'))
                if half_pts > 0:
                    font_pt = half_pts / 2.0
            except (TypeError, ValueError):
                pass

    width_inches = curr_cx / 914_400
    chars_per_line = max(10, int(width_inches * 12))
    return max(8, int(chars_per_line * (11.0 / max(font_pt, 7.0))))


def _reflow_textbox_section_items(
    items: List[Dict],
    txbx_or_content: Any,
    ref_rpr: Any = None,
) -> List[Dict]:
    """Apply width-aware soft reflow to items that will be injected in a textbox."""
    chars_per_line = _textbox_chars_per_line(txbx_or_content, ref_rpr=ref_rpr)
    if chars_per_line <= 0:
        return items

    reflowed: List[Dict] = []
    for item in items:
        text = str(item.get('text') or '')
        adjusted = text
        if not item.get('bullet'):
            adjusted = _reflow_text_to_width(text, chars_per_line)
        elif len(text) > int(chars_per_line * 1.35):
            adjusted = _reflow_text_to_width(text, int(chars_per_line * 1.15))

        if adjusted != text:
            clone = dict(item)
            clone['text'] = adjusted
            reflowed.append(clone)
        else:
            reflowed.append(item)
    return reflowed


def _direct_paragraph_runs(p_elem: Any) -> List[Any]:
    W = NS_W
    return [child for child in list(p_elem) if child.tag == f'{{{W}}}r']


def _run_plain_text(run_elem: Any) -> str:
    W = NS_W
    return ''.join(t.text or '' for t in run_elem.iter(f'{{{W}}}t'))


def _paragraph_plain_text(p_elem: Any) -> str:
    W = NS_W
    return ''.join(t.text or '' for t in p_elem.iter(f'{{{W}}}t')).strip()


def _run_is_bold(run_elem: Any) -> bool:
    W = NS_W
    rpr = run_elem.find(f'{{{W}}}rPr')
    if rpr is None:
        return False
    for tag in (f'{{{W}}}b', f'{{{W}}}bCs'):
        bold_elem = rpr.find(tag)
        if bold_elem is None:
            continue
        val = (bold_elem.get(f'{{{W}}}val') or '').strip().lower()
        if val in {'0', 'false', 'off'}:
            return False
        return True
    return False


def _paragraph_has_bold_prefix_pattern(p_elem: Any) -> bool:
    runs = [r for r in _direct_paragraph_runs(p_elem) if _run_plain_text(r).strip()]
    if len(runs) < 2:
        return False
    if not _run_is_bold(runs[0]):
        return False
    return any(not _run_is_bold(r) for r in runs[1:])


def _reference_tail_prefix(p_elem: Any, default: str) -> str:
    runs = [r for r in _direct_paragraph_runs(p_elem) if _run_plain_text(r)]
    if len(runs) < 2:
        return default
    tail_text = ''.join(_run_plain_text(r) for r in runs[1:])
    if not tail_text:
        return default
    match = re.match(r'^[^A-Za-zÀ-ÿ0-9]+', tail_text)
    return match.group(0) if match else default


def _make_para_from_reference_parts(ref_para: Any, parts: List[str]) -> Any:
    W = NS_W
    XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space'

    paragraph = etree.Element(f'{{{W}}}p')
    ppr = ref_para.find(f'{{{W}}}pPr')
    if ppr is not None:
        paragraph.append(copy.deepcopy(ppr))

    ref_runs = [r for r in _direct_paragraph_runs(ref_para) if _run_plain_text(r)]
    if not ref_runs:
        return _make_para_elem(''.join(parts))

    normalized_parts = parts or ['']
    for idx, part in enumerate(normalized_parts):
        ref_run = ref_runs[min(idx, len(ref_runs) - 1)]
        new_run = etree.Element(f'{{{W}}}r')
        rpr = ref_run.find(f'{{{W}}}rPr')
        if rpr is not None:
            new_run.append(copy.deepcopy(rpr))
        text_elem = etree.SubElement(new_run, f'{{{W}}}t')
        text_elem.text = part
        if part != part.strip():
            text_elem.set(XML_SPACE, 'preserve')
        new_run.append(text_elem)
        paragraph.append(new_run)

    return paragraph


def _section_supports_textbox_extra_pairs(section_name: str) -> bool:
    """Return True only for short singleton sections safe to mirror globally."""
    return section_name in {'summary', 'profile', 'objective'}


def _build_template_preserving_section_paragraphs(
    section: str,
    employee: Dict[str, Any],
    style_source_paras: List[Any],
) -> Optional[List[Any]]:
    """Render section paragraphs from the template's own paragraph pattern.

    Some direct-mode templates encode their visible style primarily in inline
    run formatting instead of distinct paragraph styles. When that happens,
    rebuilding sections with generic paragraphs flattens bold prefixes,
    indentation, and spacing. This helper clones the section's own paragraph
    skeletons and swaps only the textual parts.
    """
    W = NS_W

    def _strip(value: Any) -> str:
        if value is None:
            return ''
        return str(value).strip()

    def _as_list(value: Any) -> List[Any]:
        if value is None:
            return []
        if isinstance(value, list):
            return value
        if isinstance(value, tuple):
            return list(value)
        return [value]

    paragraphs = [
        para for para in style_source_paras
        if para.tag == f'{{{W}}}p' and _paragraph_plain_text(para)
    ]
    if not paragraphs:
        return None

    sections_payload = build_structured_cv_sections_payload(employee).get('sections', {})

    if section == 'experience':
        entries = sections_payload.get('experience') or []
        if not entries:
            return None

        header_ref = next((p for p in paragraphs if _paragraph_has_bold_prefix_pattern(p)), None)
        if header_ref is None:
            return None

        body_ref = next(
            (
                p for p in paragraphs
                if p is not header_ref
                and not _paragraph_has_bold_prefix_pattern(p)
                and _paragraph_plain_text(p)
            ),
            None,
        )

        source_desc: Dict[Tuple[str, str], str] = {}
        for src in _as_list(employee.get('experience')):
            if not isinstance(src, dict):
                continue
            src_title = _strip(src.get('title') or src.get('jobTitle'))
            src_company = _strip(src.get('company') or src.get('companyName'))
            if not src_title or not src_company:
                continue
            src_desc = _strip(
                src.get('description') or
                src.get('responsibilities') or
                src.get('tasks') or
                src.get('duties') or
                src.get('achievements') or
                src.get('role') or
                ''
            )
            if src_desc:
                source_desc[(src_title, src_company)] = src_desc

        company_prefix = _reference_tail_prefix(header_ref, ', ')
        rendered: List[Any] = []
        for exp in entries:
            title = _strip(exp.get('title'))
            company = _strip(exp.get('company'))
            dates = _strip(exp.get('dates'))
            if not (title or company or dates):
                continue

            head = title or company or dates
            tail = ''
            if title and company:
                tail = f"{company_prefix}{company}"
            elif not title and company:
                tail = company
            if dates:
                tail = f"{tail}  {dates}" if tail else f"  {dates}"

            parts = [head]
            if tail:
                parts.append(tail)
            rendered.append(_make_para_from_reference_parts(header_ref, parts))

            desc = source_desc.get((title, company), '')
            if body_ref is not None and desc:
                for line in desc.split('\n'):
                    clean_line = line.strip().lstrip('•●-– ').strip()
                    if clean_line:
                        rendered.append(_make_para_from_reference_parts(body_ref, [clean_line]))

        return rendered or None

    if section == 'education':
        entries = sections_payload.get('education') or []
        if not entries:
            return None

        header_ref = next((p for p in paragraphs if _paragraph_has_bold_prefix_pattern(p)), None)
        if header_ref is None:
            return None

        institution_prefix = _reference_tail_prefix(header_ref, ' | ')
        rendered: List[Any] = []
        for edu in entries:
            degree = _strip(edu.get('degree'))
            institution = _strip(edu.get('institution'))
            dates = _strip(edu.get('dates'))
            if not (degree or institution or dates):
                continue

            head = degree or institution or dates
            tail = ''
            if degree and institution:
                tail = f"{institution_prefix}{institution}"
            elif not degree and institution:
                tail = institution
            if dates:
                tail = f"{tail}  {dates}" if tail else f"  {dates}"

            parts = [head]
            if tail:
                parts.append(tail)
            rendered.append(_make_para_from_reference_parts(header_ref, parts))

        return rendered or None

    return None


def _extract_template_structured_data(
    docx_path: str,
    detected: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    Extract experience/education/summary from the template DOCX using
    pattern-based detection rather than section-boundary parsing.

    This avoids the fragile section-range approach which breaks on
    infographic templates where experience/education paragraphs are
    interleaved with TXBX contact blocks and VML duplicates.

    Strategy:
      summary_paras — BODY paragraphs before first section heading (>20 chars),
                      excluding paragraphs that contain email/phone/linkedin
                      (mega-contact blocks).
      experience    — BODY paragraphs containing the detected job title +
                      a trailing company name (ALL CAPS at end of paragraph).
      education     — BODY paragraphs containing degree keywords (LICENCE,
                      BACCALAURÉAT…) or institution keywords (Université,
                      Lycée…).  Split into institution + degree fields.

    Accepts ``detected`` (from _detect_personal_info) to locate experience
    entries via the template's job title.
    """
    result: Dict[str, Any] = {
        'experience': [], 'education': [], 'summary_paras': []
    }
    W = NS_W
    try:
        with zipfile.ZipFile(docx_path, 'r') as z:
            raw = z.read('word/document.xml')
        tree = etree.fromstring(raw)
    except Exception as exc:
        logger.warning(f"_extract_template_structured_data: {exc}")
        return result

    # ── helper: is paragraph inside a <w:txbxContent>? ────────────────
    def _is_in_txbx(elem) -> bool:
        parent = elem.getparent()
        while parent is not None:
            if 'txbxContent' in parent.tag:
                return True
            parent = parent.getparent()
        return False

    # ── helper: is paragraph inside mc:Fallback? (VML duplicate) ─────
    _MC_FB = f'{{{NS_MC}}}Fallback'

    def _is_in_fallback(elem) -> bool:
        parent = elem.getparent()
        while parent is not None:
            if parent.tag == _MC_FB:
                return True
            parent = parent.getparent()
        return False

    # ── helper: own-level paragraph text (no nested textbox / VML) ───
    _WR = f'{{{W}}}r'
    _WT = f'{{{W}}}t'
    _WP = f'{{{W}}}p'

    def _own_text(p_elem):
        """Get text from <w:t> at THIS paragraph level only."""
        parts: List[str] = []
        def _walk(elem):
            for child in elem:
                tag = child.tag
                if tag == _WP or tag == _MC_FB:
                    continue
                if tag == _WR:
                    for sub in child:
                        if sub.tag == _WT and sub.text:
                            parts.append(sub.text)
                else:
                    _walk(child)
        _walk(p_elem)
        return ''.join(parts).strip()

    _contact_re = re.compile(
        r'[\w.+-]+\s*@\s*[\w-]+\.[\w.-]+'
        r'|\d{3}[-.\s]\d{3}[-.\s]\d{4}'
        r'|\+?\d[\d\s\-\.\(\)]{7,20}'  # international phone — capped at 20 to prevent ReDoS
        r'|^(?:t[eé]l|fax|e-?mail|adresse|address|phone|portable|mobile|gsm|linkedin|github|site|url|http|www\.)',
        re.I,
    )

    # ── helper: is paragraph inside a <w:tc>? (table cell) ──────────
    _W_TC = f'{{{W}}}tc'

    def _is_in_table_cell(elem) -> bool:
        parent = elem.getparent()
        while parent is not None:
            if parent.tag == _W_TC:
                return True
            parent = parent.getparent()
        return False

    # ── Collect paragraphs with BODY/TXBX flag ────────────────────────
    # Paragraphs inside <w:tc> (table cells) are excluded — their content
    # would pollute education/summary detection with table column headers
    # (e.g. "Certificat", "Année", "Diplôme") being treated as real data.
    all_paras: List[Tuple[str, bool]] = []   # (text, is_txbx)
    for p in tree.iter(f'{{{W}}}p'):
        if _is_in_fallback(p):
            continue                  # Skip VML fallback copies
        if _is_in_table_cell(p):
            continue                  # Skip table header/data cells
        text = _own_text(p)
        if text:
            all_paras.append((text, _is_in_txbx(p)))

    # ── Layout-table fallback ─────────────────────────────────────────
    # Some templates use a single page-spanning table to create a
    # multi-column layout (left sidebar + right main area).  In those
    # templates, ALL content lives inside <w:tc> cells and the above
    # loop produces an empty/sparse list.  Detect this pattern and
    # collect paragraphs from layout-table cells instead.
    #
    # IMPORTANT: process each cell independently so that section ranges
    # don't cross column boundaries.  Without this, left-column skills
    # content gets indexed between right-column education and experience
    # headings, causing false education matches.
    _layout_tbl = None
    _para_section: Dict[int, str] = {}  # index → section_name (per-cell)
    if len(all_paras) < 3:
        body = tree.find(f'{{{W}}}body')
        if body is None:
            body = tree.find(f'.//{{{W}}}body')
        if body is not None:
            _layout_tbl = _get_layout_table(body)
            if _layout_tbl is not None:
                logger.info("Layout table detected — extracting paragraphs from cells")
                all_paras = []  # reset to only layout-table content
                for tc in _layout_tbl.iter(f'{{{W}}}tc'):
                    cell_start = len(all_paras)
                    for p in tc.findall(f'{{{W}}}p'):
                        if _is_in_fallback(p):
                            continue
                        text = _own_text(p)
                        if text:
                            all_paras.append((text, False))
                    # Detect section headings within THIS cell and map
                    # each paragraph to its section (cell-scoped ranges).
                    cell_secs: List[Tuple[int, str]] = []
                    for idx in range(cell_start, len(all_paras)):
                        sec = _identify_section_from_text(all_paras[idx][0])
                        if sec:
                            cell_secs.append((idx, sec))
                    for si, (sec_idx, sec_name) in enumerate(cell_secs):
                        sec_end = (cell_secs[si + 1][0]
                                   if si + 1 < len(cell_secs)
                                   else len(all_paras))
                        for idx in range(sec_idx, sec_end):
                            _para_section[idx] = sec_name

    # ── Section heading detection (strict) ────────────────────────────
    # Only match short, heading-like paragraphs.  "Formation en gestion
    # de projets :" must NOT match "formation" (education keyword).
    sec_positions: Dict[str, int] = {}
    for i, (text, _) in enumerate(all_paras):
        t = re.sub(r'\s+', ' ', text.strip().lower())
        if not t or len(t) > 50:
            continue
        for sec_name, kws in _SECTION_MAP.items():
            if sec_name in sec_positions:
                continue
            matched = False
            for kw in kws:
                if t == kw:
                    matched = True
                    break
                if t.startswith(kw + ':') and len(t) <= len(kw) + 2:
                    matched = True
                    break
                # startswith(kw + ' ') only if remainder is short
                if t.startswith(kw + ' ') and len(t) <= len(kw) + 22:
                    matched = True
                    break
            if matched:
                sec_positions[sec_name] = i
                break

    # ── Section-range computation (for layout-table filtering) ────────
    # _para_section was already populated per-cell during layout-table
    # paragraph collection above. For non-layout-table templates the dict
    # stays empty and the section-aware filters below become no-ops.

    # ── Summary paragraphs ────────────────────────────────────────────
    # Exclude contact fields (address, name, phone, email, linkedin) from
    # summary paragraphs — only keep genuine profile / objective text.
    _det_addr = ((detected or {}).get('address') or '').strip()
    _det_name = ((detected or {}).get('name') or '').strip()
    _det_name_raw = ((detected or {}).get('_name_raw') or '').strip()
    _det_phone = ((detected or {}).get('phone') or '').strip()
    _det_linkedin = ((detected or {}).get('linkedin') or '').strip()
    _contact_fields = {v for v in (_det_addr, _det_name, _det_name_raw,
                                    _det_phone, _det_linkedin) if v}
    # Also build a street-address regex to catch address formats not in detected
    _addr_line_re = re.compile(
        r'^\d+[,\s]+(?:rue|avenue|av\.|boulevard|blvd|chemin|allée|place|'
        r'impasse|passage|cours|quai|route|street|st\.|road|rd\.)\b',
        re.I,
    )

    # Label-prefixed contact lines: 'Adresse : ...', 'Tél : ...'
    _contact_label_re = re.compile(
        r'^(?:t[eé]l|fax|e-?mail|adresse|address|phone|portable|mobile|gsm|'
        r'linkedin|github|site\s*web|url|http|www\.)\s*[:\-]?\s*',
        re.I,
    )

    if sec_positions:
        first_sec_idx = min(sec_positions.values())
        result['summary_paras'] = [
            text for text, is_txbx in all_paras[:first_sec_idx]
            if text.strip() and len(text.strip()) > 20
            and not is_txbx
            and not _contact_re.search(text)
            and text.strip() not in _contact_fields
            and not _addr_line_re.match(text.strip())
            and not _contact_label_re.match(text.strip())
            and '{{' not in text  # skip Jinja2 placeholder paragraphs (contact/header fields)
        ]

    # ── Experience: pattern-based company extraction ──────────────────
    det_title = ((detected or {}).get('title') or '').strip()
    det_name  = ((detected or {}).get('name') or '').strip()
    det_addr  = ((detected or {}).get('address') or '').strip()

    _MONTH_RE = re.compile(
        r'\b(?:jan|f[eé]v|mar|avr|mai|juin|juil|ao[uû]|sep|oct|nov|d[eé]c|'
        r'january|february|march|april|may|june|july|august|september|'
        r'october|november|december)\w*\.?\s+\d{4}\b',
        re.I,
    )

    companies_found: List[Dict[str, str]] = []
    seen_companies: set = set()

    for _xi, (text, is_txbx) in enumerate(all_paras):
        if is_txbx:
            continue
        # Section-aware filter for layout-table mode: in layout tables
        # we have reliable per-cell section tags, so be strict — only
        # consider paragraphs explicitly tagged as 'experience'.
        if _para_section:
            if _para_section.get(_xi) != 'experience':
                continue
        stripped = text.strip()
        if len(stripped) < 5 or len(stripped) > 120:
            continue
        if _contact_re.search(stripped):
            continue
        # Skip if it equals the detected name or title alone
        if det_name and stripped.upper() == det_name.upper():
            continue
        if det_title and stripped.upper() == det_title.upper():
            continue

        company = ''

        # Pattern A: ALL CAPS paragraph containing TITLE + COMPANY
        # e.g. "CHARGÉ DE PROJETS TI SOBEYS"
        if det_title and stripped.upper() == stripped:
            title_upper = det_title.upper()
            if title_upper in stripped:
                rest = stripped.replace(title_upper, '', 1).strip()
                if rest and len(rest) > 1:
                    company = rest

        # Pattern B: Date-range paragraph with TITLE … COMPANY
        # e.g. "Juil. 2018 – Aujourd'hui CHARGÉ DE PROJETS TI Montréal, Canada DESJARDINS"
        if not company and det_title and _MONTH_RE.search(stripped):
            idx = stripped.upper().find(det_title.upper())
            if idx >= 0:
                after = stripped[idx + len(det_title):].strip()
                # Remove detected address fragment
                if det_addr:
                    after = after.replace(det_addr, '').strip()
                # Trailing ALL CAPS words = company name
                words = after.split()
                comp_words: list = []
                for w in reversed(words):
                    clean = re.sub(r'[,;.()]', '', w)
                    if clean and clean.upper() == clean and re.search(r'[A-ZÀ-Ü]', clean):
                        comp_words.insert(0, clean)
                    else:
                        break
                if comp_words:
                    company = ' '.join(comp_words)

        if company and company not in seen_companies:
            companies_found.append({
                'company': company, 'title': det_title, 'date': '',
            })
            seen_companies.add(company)

    result['experience'] = companies_found[:5]

    # ── Education: keyword-based extraction ───────────────────────────
    _DEGREE_KW = [
        'licence', 'baccalauréat', 'bachelor', 'master', 'maîtrise',
        'diplôme', 'doctorat', 'phd', 'mba', 'ingénieur', 'dut', 'bts',
        'dec', 'certificat',
    ]
    _INST_KW = [
        'université', 'university', 'lycée', 'école', 'college',
        'institut', 'faculté', 'polytechnique', 'conservatoire',
    ]

    # Compile word-boundary regexes to avoid false matches like
    # "master" in "Webmaster" or "certificat" in "Certifications & Hackathons".
    _DEGREE_RE = re.compile(
        r'\b(?:' + '|'.join(re.escape(kw) for kw in _DEGREE_KW) + r')\b', re.I
    )
    _INST_RE = re.compile(
        r'\b(?:' + '|'.join(re.escape(kw) for kw in _INST_KW) + r')\b', re.I
    )

    educations: List[Dict[str, str]] = []
    for _ei, (text, is_txbx) in enumerate(all_paras):
        if is_txbx:
            continue
        # In layout-table mode, only match education keywords in
        # paragraphs explicitly tagged as 'education'.  This prevents
        # untagged skills/subsection content (e.g. "Direction" cell
        # mentioning "université") from being mis-classified.
        if _para_section:
            if _para_section.get(_ei) != 'education':
                continue
        stripped = text.strip()
        lower = stripped.lower()
        if len(stripped) < 10:
            continue
        # Skip paragraphs that match a section heading keyword (e.g.
        # "Certifications & Hackathons" must NOT be treated as education)
        _is_section_heading = False
        _t_norm = re.sub(r'\s+', ' ', lower).strip()
        if len(_t_norm) <= 50:
            for _sec_kws in _SECTION_MAP.values():
                for _kw in _sec_kws:
                    if _t_norm == _kw or _t_norm.startswith(_kw):
                        _is_section_heading = True
                        break
                if _is_section_heading:
                    break
        if _is_section_heading:
            continue
        has_degree = bool(_DEGREE_RE.search(lower))
        has_inst   = bool(_INST_RE.search(lower))
        if not (has_degree or has_inst):
            continue

        # Split "DEGREE … Institution" at the institution keyword
        inst = ''
        degree = ''
        for kw in _INST_KW:
            pos = lower.find(kw)
            if pos >= 0:
                inst = stripped[pos:].strip()
                degree = stripped[:pos].strip()
                break
        if not inst and has_degree:
            degree = stripped
        educations.append({'institution': inst, 'degree': degree, 'date': ''})

    result['education'] = educations[:5]

    logger.info(
        f"Template structured data: {len(result['experience'])} exp, "
        f"{len(result['education'])} edu, "
        f"{len(result['summary_paras'])} summary para(s)"
    )
    for exp in result['experience']:
        logger.info(f"  exp company: {exp['company']}")
    for edu in result['education']:
        logger.info(
            f"  edu: inst={edu.get('institution','')}, "
            f"deg={edu.get('degree','')[:50]}"
        )
    return result


def _build_full_replacement_map(
    detected: Dict[str, str],
    template_data: Dict[str, Any],
    employee: Dict[str, Any],
) -> List[Tuple[str, str]]:
    """
    Build the complete (old, new) replacement list covering:
      • Contact fields  — name, title, email, phone, linkedin, address
      • Experience      — positional: template[i].company/title → employee[i]
      • Education       — positional: template[i].institution/degree → employee[i]
      • Summary paras   — template pre-heading paragraphs → employee summary

    Uses _build_replacements for contact fields and extends with structured
    experience/education mapping derived from _extract_template_structured_data.
    """
    # Start with contact-field pairs (existing function handles name variants etc.)
    pairs: List[Tuple[str, str]] = list(_build_replacements(detected, employee))
    existing_olds: set = {old for old, _ in pairs}

    # Precompute section heading keywords for safety guard below
    _section_heading_texts: set = set()
    for _sec_kws in _SECTION_MAP.values():
        for _kw in _sec_kws:
            _section_heading_texts.add(_kw)

    def _add(old: str, new: str) -> None:
        old_s = (old or '').strip()
        new_s = (new or '').strip()
        if not old_s or old_s in existing_olds or old_s == new_s:
            return
        # Safety: reject overly long old strings (likely wrong extraction)
        if len(old_s) > 500:
            logger.debug(f"  _add: skipped long old ({len(old_s)} chars): {old_s[:60]}…")
            return
        # Safety: never blank text that matches a section heading keyword.
        # Phase 6b needs those headings intact for section detection.
        old_lower = old_s.lower()
        if old_lower in _section_heading_texts:
            logger.debug(f"  _add: skipped section heading text: {old_s[:60]}")
            return
        for _kw in _section_heading_texts:
            if old_lower.startswith(_kw) and len(old_lower) <= len(_kw) + 20:
                logger.debug(f"  _add: skipped section-heading-like text: {old_s[:60]}")
                return
        pairs.append((old_s, new_s))
        existing_olds.add(old_s)

    # Precompute normalised dates from the structured payload so we can look up
    # employee dates by index without re-normalising on every iteration.
    _structured = build_structured_cv_sections_payload(employee).get("sections", {})
    _emp_exp_payload = _structured.get("experience") or []
    _emp_edu_payload = _structured.get("education") or []

    # ── Experience positional mapping ─────────────────────────────────
    tmpl_exps = template_data.get('experience') or []
    emp_exps  = employee.get('experience') or []

    for i, tmpl_exp in enumerate(tmpl_exps):
        emp_exp = emp_exps[i] if i < len(emp_exps) else None
        if emp_exp:
            tmpl_company = (tmpl_exp.get('company') or '').strip()
            emp_company  = (
                emp_exp.get('company') or emp_exp.get('companyName') or ''
            ).strip()
            if tmpl_company:
                _add(tmpl_company, emp_company)

            tmpl_title = (tmpl_exp.get('title') or '').strip()
            emp_title  = (
                emp_exp.get('title') or emp_exp.get('jobTitle') or ''
            ).strip()
            if tmpl_title and emp_title:
                _add(tmpl_title, emp_title)

            # Date replacement: map template dates to employee dates so that
            # old date ranges don't survive when section-level replacement is
            # skipped (e.g. when the template has no detectable section headings).
            tmpl_dates = (tmpl_exp.get('dates') or tmpl_exp.get('date_range') or '').strip()
            emp_dates = ''
            if i < len(_emp_exp_payload):
                emp_dates = (_emp_exp_payload[i].get('dates') or '').strip()
            if not emp_dates:
                emp_dates = (emp_exp.get('dates') or emp_exp.get('date_range') or '').strip()
            if tmpl_dates and emp_dates and tmpl_dates != emp_dates:
                _add(tmpl_dates, emp_dates)
        else:
            # Employee has fewer entries — clear leftover template text
            for field in ('company', 'title', 'dates', 'date_range'):
                val = (tmpl_exp.get(field) or '').strip()
                if val:
                    _add(val, '')

    # ── Education positional mapping ──────────────────────────────────
    tmpl_edus = template_data.get('education') or []
    emp_edus  = employee.get('education') or []

    for i, tmpl_edu in enumerate(tmpl_edus):
        emp_edu = emp_edus[i] if i < len(emp_edus) else None
        if emp_edu:
            tmpl_inst = (tmpl_edu.get('institution') or '').strip()
            emp_inst  = (
                emp_edu.get('institution') or emp_edu.get('school') or
                emp_edu.get('university') or ''
            ).strip()
            if tmpl_inst and emp_inst:
                _add(tmpl_inst, emp_inst)

            tmpl_deg = (tmpl_edu.get('degree') or '').strip()
            emp_deg  = (
                emp_edu.get('degree') or emp_edu.get('fieldOfStudy') or
                emp_edu.get('field_of_study') or ''
            ).strip()
            if tmpl_deg and emp_deg:
                # Deduplicate doubled degree ("Foo Bar Foo Bar" → "Foo Bar")
                words = emp_deg.split()
                half = len(words) // 2
                if half >= 2 and words[:half] == words[half:]:
                    emp_deg = ' '.join(words[:half])
                _add(tmpl_deg, emp_deg)

            # Education date replacement
            tmpl_edu_dates = (tmpl_edu.get('dates') or '').strip()
            emp_edu_dates = ''
            if i < len(_emp_edu_payload):
                emp_edu_dates = (_emp_edu_payload[i].get('dates') or '').strip()
            if not emp_edu_dates:
                emp_edu_dates = (emp_edu.get('dates') or emp_edu.get('date_range') or '').strip()
            if tmpl_edu_dates and emp_edu_dates and tmpl_edu_dates != emp_edu_dates:
                _add(tmpl_edu_dates, emp_edu_dates)
        else:
            for field in ('institution', 'degree', 'dates'):
                val = (tmpl_edu.get(field) or '').strip()
                if val:
                    _add(val, '')

    # ── Summary paragraph replacement ─────────────────────────────────
    # Replace template pre-heading paragraphs (objective/profile text) with
    # the employee's generated summary.  Only the first paragraph carries the
    # full summary; additional paragraphs are cleared to avoid duplication.
    # NOTE: bypasses _add() because summary paras can legitimately exceed the
    #       500-char safety limit (_add rejects long old strings).
    summary = (employee.get('summary') or '').strip()
    tmpl_summary_paras = template_data.get('summary_paras') or []
    if summary and tmpl_summary_paras:
        for j, old_para in enumerate(tmpl_summary_paras):
            old_s = (old_para or '').strip()
            if old_s and old_s not in existing_olds:
                new_s = summary if j == 0 else ''
                pairs.append((old_s, new_s))
                existing_olds.add(old_s)

    pairs.sort(key=lambda x: len(x[0]), reverse=True)
    logger.info(f"Full replacement map: {len(pairs)} pairs")
    for old, new in pairs[:15]:
        logger.info(f"  '{old[:60]}' -> '{(new or '')[:60]}'")
    return pairs


    # Placeholders and Jinja2 tokens are not handled in fallback AI engine.
    # No placeholder replacement logic is included here.
def _final_quality_control_cleanup(docx_path: str):
    """
    Final pass to remove any residual template artifacts, placeholders, or Jinja2 tokens.
    Ensures no {{...}} or similar tokens remain in the output document.
    """
    temp_dir = tempfile.mkdtemp()
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)
        word_dir = os.path.join(temp_dir, 'word')
        for root_dir, _dirs, files in os.walk(word_dir):
            for fname in files:
                if not fname.endswith('.xml'):
                    continue
                xml_path = os.path.join(root_dir, fname)
                arcname = os.path.relpath(xml_path, temp_dir).replace('\\', '/')
                if not _VISIBLE_WORD_PART_RE.match(arcname):
                    continue
                with open(xml_path, 'rb') as f:
                    raw = f.read()
                try:
                    tree = etree.fromstring(raw)
                except Exception:
                    continue
                changed = False
                for t_elem in tree.iter(f'{{{NS_W}}}t', f'{{{NS_A}}}t'):
                    original = t_elem.text or ''
                    if not original:
                        continue
                    updated = original
                    updated = re.sub(r'\{\{.*?\}\}', '', updated)
                    updated = re.sub(r'\{%.*?%\}', '', updated)
                    updated = re.sub(
                        r'\b(?:janv?(?:ier)?|f[ée]vr?(?:ier)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|ao[uû]t|sept(?:embre)?|oct(?:obre)?|nov(?:embre)?|d[ée]c(?:embre)?|january|february|march|april|may|june|july|august|september|october|november|december)\.?\s+(?:20xx|xxxx)\s*[–—-]\s*(?:janv?(?:ier)?|f[ée]vr?(?:ier)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|ao[uû]t|sept(?:embre)?|oct(?:obre)?|nov(?:embre)?|d[ée]c(?:embre)?|january|february|march|april|may|june|july|august|september|october|november|december)\.?\s+(?:20xx|xxxx)\b',
                        '',
                        updated,
                        flags=re.I,
                    )
                    updated = re.sub(r'\b(?:20xx|xxxx)\b', '', updated, flags=re.I)
                    if updated == original:
                        continue
                    updated = re.sub(r'\s{2,}', ' ', updated).strip(' -–—|•·,;:/')
                    if updated != original:
                        t_elem.text = updated
                        changed = True
                if changed:
                    with open(xml_path, 'wb') as f:
                        f.write(etree.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True))
        with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as zout:
            for root_dir, _dirs, files in os.walk(temp_dir):
                for fname in files:
                    fpath = os.path.join(root_dir, fname)
                    arcname = os.path.relpath(fpath, temp_dir)
                    zout.write(fpath, arcname)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


# ── Known language names for textbox blanking ────────────────────────────
_KNOWN_LANGUAGE_NAMES: set = {
    'anglais', 'english', 'français', 'french', 'espagnol', 'spanish',
    'allemand', 'german', 'italien', 'italian',
    'portugais', 'portuguese', 'néerlandais', 'dutch', 'chinois', 'chinese',
    'japonais', 'japanese', 'russe', 'russian', 'coréen', 'korean',
    'turc', 'turkish', 'hindi', 'mandarin', 'cantonais', 'cantonese',
    'polonais', 'polish', 'roumain', 'romanian', 'grec', 'greek',
    'hébreu', 'hebrew', 'suédois', 'swedish', 'danois', 'danish',
    'norvégien', 'norwegian', 'finnois', 'finnish', 'tchèque', 'czech',
    'bulgare', 'bulgarian', 'croate', 'croatian', 'serbe', 'serbian',
    'persan', 'persian', 'farsi', 'swahili', 'bengali', 'thaï', 'thai',
    'vietnamien', 'vietnamese', 'ukrainien', 'ukrainian',
}


def _blank_language_textboxes_in_range(body_elements: list) -> int:
    """
    Blank textboxes containing language names inside the given body elements.
    Also handles fragmented language names across adjacent textboxes (e.g. "Al"+"lemand").

    Only blanks text content — does NOT remove body elements (safe for mixed layouts).
    Returns count of textboxes blanked.
    """
    W = NS_W
    WT = f'{{{W}}}t'
    W_TXBX_CONTENT = f'{{{W}}}txbxContent'
    blanked = 0

    # Collect all txbxContent elements in the body range
    all_txbx: list = []
    for elem in body_elements:
        for tc in elem.iter(W_TXBX_CONTENT):
            all_txbx.append(tc)

    if not all_txbx:
        return 0

    # Extract text from each txbxContent
    txbx_texts = []
    for tc in all_txbx:
        txt = ''.join(t.text or '' for t in tc.iter(WT)).strip()
        txbx_texts.append(txt)

    blanked_set: set = set()

    # Pass 1: exact single-textbox match
    for i, txt in enumerate(txbx_texts):
        if txt.lower() in _KNOWN_LANGUAGE_NAMES:
            blanked_set.add(i)

    # Pass 2: adjacent fragment match (e.g. "Al"+"lemand" → "Allemand")
    for i in range(len(txbx_texts) - 1):
        for win in range(2, min(5, len(txbx_texts) - i + 1)):
            combined = ''.join(txbx_texts[i:i + win]).strip().lower()
            if combined in _KNOWN_LANGUAGE_NAMES:
                for j in range(i, i + win):
                    blanked_set.add(j)
                break

    # Blank matched textboxes
    for idx in blanked_set:
        for t in all_txbx[idx].iter(WT):
            if t.text and t.text.strip():
                t.text = ''
        blanked += 1

    return blanked


def _replace_language_textboxes_in_range(body_elements: list, employee_langs: list) -> int:
    """
    Replace language-label textboxes with the employee's language names.
    Handles fragmented language names (e.g. "Al"+"lemand").

    Maps template language textboxes → employee languages 1:1. Extra template
    languages are blanked; extra employee languages are ignored (they go in the
    body-level section content instead).

    Returns count of textboxes modified.
    """
    W = NS_W
    WT = f'{{{W}}}t'
    W_TXBX_CONTENT = f'{{{W}}}txbxContent'
    modified = 0

    # Collect all txbxContent elements in the body range
    all_txbx: list = []
    for elem in body_elements:
        for tc in elem.iter(W_TXBX_CONTENT):
            all_txbx.append(tc)

    if not all_txbx:
        return 0

    txbx_texts = []
    for tc in all_txbx:
        txt = ''.join(t.text or '' for t in tc.iter(WT)).strip()
        txbx_texts.append(txt)

    # Find language textbox groups (may be fragmented)
    # Each group is a list of indices that form one language label
    lang_groups: list = []  # list of (combined_name, [indices])

    used: set = set()
    # Check fragments first (multi-textbox)
    for i in range(len(txbx_texts)):
        if i in used:
            continue
        for win in range(2, min(5, len(txbx_texts) - i + 1)):
            combined = ''.join(txbx_texts[i:i + win]).strip().lower()
            if combined in _KNOWN_LANGUAGE_NAMES:
                indices = list(range(i, i + win))
                lang_groups.append((combined, indices))
                for j in indices:
                    used.add(j)
                break
    # Then single textbox
    for i, txt in enumerate(txbx_texts):
        if i in used:
            continue
        if txt.lower() in _KNOWN_LANGUAGE_NAMES:
            lang_groups.append((txt.lower(), [i]))
            used.add(i)

    if not lang_groups:
        return 0

    # Extract employee language names
    emp_names = []
    for lang in employee_langs:
        if isinstance(lang, str):
            emp_names.append(lang)
        elif isinstance(lang, dict):
            emp_names.append(lang.get('name', ''))

    # Map: replace template languages with employee languages
    for gi, (template_lang, indices) in enumerate(lang_groups):
        if gi < len(emp_names) and emp_names[gi]:
            # Replace: put employee language in the first textbox, blank the rest
            first_idx = indices[0]
            t_elems = list(all_txbx[first_idx].iter(WT))
            if t_elems:
                t_elems[0].text = emp_names[gi]
                for te in t_elems[1:]:
                    te.text = ''
            for idx in indices[1:]:
                for t in all_txbx[idx].iter(WT):
                    t.text = ''
            modified += 1
        else:
            # No more employee languages — blank this textbox
            for idx in indices:
                for t in all_txbx[idx].iter(WT):
                    if t.text and t.text.strip():
                        t.text = ''
            modified += 1

    return modified



def _replace_cv_sections(
    docx_path: str,
    employee: Dict[str, Any],
    preferred_language: Optional[str] = None,
) -> int:
    """
    Find CV section headings in the document body and replace their content
    with the employee's structured data.

    Uses lxml + zipfile (same pattern as _apply_paragraph_replacements) so that
    textbox / shape XML inside the DOCX is never stripped by python-docx saving.
    Works on body-level paragraphs only (direct children of <w:body>).
    """
    W = NS_W
    temp_dir = tempfile.mkdtemp()
    try:
        # Extract DOCX
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)

        doc_xml_path = os.path.join(temp_dir, 'word', 'document.xml')
        with open(doc_xml_path, 'rb') as f:
            raw = f.read()

        tree = etree.fromstring(raw)

        # Find <w:body> — first try direct path, then anywhere in tree
        body = tree.find(f'{{{W}}}body')
        if body is None:
            body = tree.find(f'.//{{{W}}}body')
        if body is None:
            logger.warning("No <w:body> found in document.xml")
            return 0

        # Collect all direct body children (p AND tbl AND other elements)
        body_children = list(body)

        # Find section headings — only inspect <w:p> children but record their
        # actual position in body_children for range-based removal
        sections_found: List[Tuple[str, Any]] = []
        for child in body_children:
            if child.tag == f'{{{W}}}p':
                section = _identify_section_lxml(child)
                if section:
                    sections_found.append((section, child))

        if not sections_found:
            # ── Layout-table fallback ─────────────────────────────────
            # Templates that use a single table for page layout have no
            # body-level <w:p> headings.  Detect the layout table and
            # process sections within its cells.
            layout_tbl = _get_layout_table(body)
            if layout_tbl is not None:
                logger.info(
                    "No body-level sections but layout table found "
                    "— replacing sections in table cells"
                )
                count = _replace_sections_in_layout_table(
                    layout_tbl, body, employee, preferred_language,
                )
                if count:
                    # Write back
                    with open(doc_xml_path, 'wb') as f:
                        f.write(etree.tostring(
                            tree, xml_declaration=True,
                            encoding='UTF-8', standalone=True,
                        ))
                    with zipfile.ZipFile(docx_path, 'w',
                                        zipfile.ZIP_DEFLATED) as zout:
                        for root_dir, _dirs, files in os.walk(temp_dir):
                            for fname in files:
                                fpath = os.path.join(root_dir, fname)
                                arcname = os.path.relpath(fpath, temp_dir)
                                zout.write(fpath, arcname)
                return count
            logger.info("No CV section headings detected — body content unchanged")
            return 0

        logger.info(f"Detected sections: {[s[0] for s in sections_found]}")

        replaced = 0
        for sec_idx, (section_name, heading_elem) in enumerate(sections_found):
            next_heading = (
                sections_found[sec_idx + 1][1]
                if sec_idx + 1 < len(sections_found)
                else None
            )

            # Find the actual child indices so we capture EVERY element between
            # headings — including <w:tbl>, drawings, spacer paragraphs, etc.
            heading_pos = body_children.index(heading_elem)
            next_pos = (
                body_children.index(next_heading)
                if next_heading is not None
                else len(body_children)
            )
            content_children = body_children[heading_pos + 1 : next_pos]

            new_content = _build_section_content(section_name, employee, preferred_language)
            if new_content is None:
                # No employee data for this section — remove content (but preserve
                # textbox-container heading paragraphs: they are visual layout elements
                # in infographic templates and must never be deleted even when empty).
                is_txbx_heading = _para_is_textbox(heading_elem)

                # Re-read live body children to get correct positions after prior edits
                live_children = list(body)
                if heading_elem not in live_children:
                    continue  # already removed
                live_idx = live_children.index(heading_elem)
                live_next_pos = (
                    live_children.index(next_heading)
                    if next_heading is not None and next_heading in live_children
                    else len(live_children)
                )
                live_content = live_children[live_idx + 1: live_next_pos]

                # Safety guard: if the content range is large (> 12 elements) it
                # likely spans OTHER sections whose headings were not detected (e.g.,
                # because their heading is in a textbox overlay without a body heading).
                # Wiping all of them would destroy content unrelated to this section.
                # Leave the range untouched when it would wipe too much.
                _SAFE_MAX_WIPE = 12
                if len(live_content) > _SAFE_MAX_WIPE:
                    if section_name == 'languages':
                        # Fallback: blank language-label textboxes in range
                        _blanked = _blank_language_textboxes_in_range(live_content)
                        if _blanked:
                            logger.info(
                                f"  '{section_name}': blanked {_blanked} language textbox(es) "
                                f"(safety fallback, {len(live_content)} body elements preserved)"
                            )
                            replaced += 1
                        else:
                            logger.info(
                                f"  '{section_name}': no employee data — {len(live_content)} elements "
                                f"exceeds safety threshold ({_SAFE_MAX_WIPE}), skipping auto-wipe"
                            )
                    else:
                        logger.info(
                            f"  '{section_name}': no employee data — {len(live_content)} elements in range "
                            f"exceeds safety threshold ({_SAFE_MAX_WIPE}), skipping auto-wipe"
                        )
                    continue

                # Remove all content, including textbox paragraphs (language bars etc.)
                for elem in live_content:
                    try:
                        body.remove(elem)
                    except ValueError:
                        pass
                if not is_txbx_heading:
                    # Only remove plain text headings, not sidebar textbox containers
                    try:
                        body.remove(heading_elem)
                    except ValueError:
                        pass
                logger.info(f"  '{section_name}': no employee data — removed {len(live_content)} content elements"
                            + (" (heading kept: textbox container)" if is_txbx_heading else ""))
                replaced += 1
                continue

            # Use smart removable collection — stops at column-separator drawings
            removable = _collect_removable(content_children)

            # Safety guard for multi-column templates: if section spans textboxes
            # use safe mode (skip textbox shapes but continue collecting plain paragraphs).
            has_textboxes_in_range = any(_para_is_textbox(c) for c in content_children)
            if has_textboxes_in_range and len(removable) > 5:
                # Safe mode: collect all non-textbox, non-drawing body paragraphs.
                # Use `continue` (not `break`) at textboxes so that experience/education
                # entries in the right column are still collected even when left-sidebar
                # textboxes appear interleaved in the content range.
                safe_removable = []
                for c in content_children:
                    if _para_is_textbox(c):
                        continue  # skip sidebar textboxes — don't stop searching
                    raw = etree.tostring(c)
                    if b'w:drawing' in raw or b'w:pict' in raw:
                        continue  # skip decoration
                    safe_removable.append(c)
                if not safe_removable:
                    logger.info(
                        f"  '{section_name}': multi-column range, nothing safe to replace — skipping"
                    )
                    continue
                removable = safe_removable
                logger.info(
                    f"  '{section_name}': multi-column safe mode, replacing {len(removable)} elements"
                )

            # --- Table-aware section replacement --------------------------------
            # If the section range contains a table, fill it in-place instead
            # of converting the whole section to plain paragraphs (preserves the
            # column layout defined by the template author).
            tables_in_range = [e for e in removable if e.tag == f'{{{W}}}tbl']
            scaffold_tables = [tbl for tbl in tables_in_range if _is_docxtpl_scaffold_table(tbl)]
            if tables_in_range:
                tbl_rows = _build_section_table_rows(section_name, employee)
                if tbl_rows is not None and not scaffold_tables:
                    n_inserted = _fill_table_section(tables_in_range[0], tbl_rows)
                    # Remove extra tables from body (they held overflow data rows)
                    for extra_tbl in tables_in_range[1:]:
                        try:
                            body.remove(extra_tbl)
                        except ValueError:
                            pass
                    # Remove non-table elements (spacer paragraphs)
                    non_tbl = [e for e in removable if e.tag != f'{{{W}}}tbl']
                    for elem in non_tbl:
                        try:
                            body.remove(elem)
                        except ValueError:
                            pass
                    replaced += 1
                    logger.info(
                        f"  '{section_name}': filled table with {n_inserted} data rows, "
                        f"cleared {len(tables_in_range)-1} extra table(s), "
                        f"removed {len(non_tbl)} non-table element(s)"
                    )
                    continue
                if scaffold_tables:
                    logger.info(
                        f"  '{section_name}': docxtpl scaffold table detected — rebuilding as paragraphs"
                    )
            # ----------------------------------------------------------------

            style_source_paras = [c for c in removable if c.tag == f'{{{W}}}p']
            for tbl in tables_in_range:
                style_source_paras.extend(list(tbl.iter(f'{{{W}}}p')))

            template_pattern_paras = _build_template_preserving_section_paragraphs(
                section_name,
                employee,
                style_source_paras,
            )
            if template_pattern_paras:
                for elem in removable:
                    body.remove(elem)

                insert_after = heading_elem
                for new_p in template_pattern_paras:
                    insert_after.addnext(new_p)
                    insert_after = new_p

                replaced += 1
                logger.info(
                    f"  '{section_name}': reused template paragraph pattern "
                    f"for {len(template_pattern_paras)} inserted paragraph(s)"
                )
                continue

            rendered_paras = _render_section_paragraphs(
                new_content,
                style_source_paras,
                heading_elem=heading_elem,
            )

            for elem in removable:
                body.remove(elem)

            # Insert new paragraphs after heading (in order)
            insert_after = heading_elem
            for new_p in rendered_paras:
                insert_after.addnext(new_p)
                insert_after = new_p

            replaced += 1
            logger.info(
                f"  '{section_name}': removed {len(removable)} elements "
                f"→ {len(rendered_paras)} lines inserted"
            )

            # For languages in infographic templates: also replace textbox labels
            # The body-level replacement handles body paragraphs but NOT textbox
            # shapes that contain language names (e.g. "Anglais", "Espagnol").
            if section_name == 'languages' and has_textboxes_in_range:
                emp_langs = employee.get('languages') or []
                if emp_langs:
                    _lang_mod = _replace_language_textboxes_in_range(content_children, emp_langs)
                    if _lang_mod:
                        logger.info(
                            f"  '{section_name}': replaced {_lang_mod} language textbox label(s)"
                        )

        # ── Post-loop: inject summary + experience body blocks ──────────────────
        # In some templates (Canadian infographic) section headings live in textbox
        # overlays with no corresponding body-level heading.  Their content paragraphs
        # sit in the body between other sections.  We detect and replace them here.
        _mc_tag = f'{{{NS_MC}}}AlternateContent'
        sections_rebuilt = {s for s, _ in sections_found}

        # Helper: collect non-textbox, non-mc-decoration, non-empty body paragraphs
        # within a given range of body children.
        def _body_block_candidates(start_idx: int, end_idx: int) -> list:
            live = list(body)
            result = []
            for k in range(start_idx, min(end_idx, len(live))):
                c = live[k]
                if c.tag != f'{{{W}}}p':
                    continue
                if _para_is_textbox(c):
                    continue
                if c.find(f'.//{_mc_tag}') is not None:
                    # Only skip if the paragraph carries NO plain-text content
                    texts = [t.text for t in c.iter(f'{{{W}}}t') if t.text]
                    if not ''.join(texts).strip():
                        continue
                else:
                    texts = [t.text for t in c.iter(f'{{{W}}}t') if t.text]
                    if not ''.join(texts).strip():
                        continue
                result.append(c)
            return result

        # --- Summary block: plain body paragraphs BEFORE the first detected heading ---
        _contact_label_pfx = re.compile(
            r'^(?:t[eé]l|fax|e-?mail|adresse|address|phone|portable|mobile|gsm|'
            r'linkedin|github|site\s*web|url|http|www\.)\s*[:\-]?\s*',
            re.I,
        )
        _intl_phone_re = re.compile(r'\+?\d[\d\s\-\.\(\)]{7,}')

        def _is_contact_para(para_elem) -> bool:
            """True if paragraph looks like a contact/identity field, not summary content.
            
            Paragraphs that carry the person's name, title, phone, email,
            address, or website are contact fields and must NOT be replaced by
            the professional summary.
            """
            t = ''.join(tx.text for tx in para_elem.iter(f'{{{W}}}t') if tx.text).strip()
            if not t:
                return False
            # Style "Title"/"Titre" → name paragraph
            # Style "Subtitle"/"Sous-titre" → job-title paragraph
            pPr = para_elem.find(f'{{{W}}}pPr')
            if pPr is not None:
                pStyle = pPr.find(f'{{{W}}}pStyle')
                if pStyle is not None:
                    sval = pStyle.get(f'{{{W}}}val', '').lower()
                    if any(kw in sval for kw in ('title', 'titre', 'subtitle', 'sous-titre')):
                        return True
            low = t.lower()
            # Label-prefixed contact lines: 'Tél : ...', 'Adresse : ...'
            if _contact_label_pfx.match(low):
                return True
            # Email pattern
            if re.search(r'[\w.+-]+@[\w-]+\.[\w.-]+', t):
                return True
            # Phone pattern (international)
            if _intl_phone_re.search(t):
                return True
            # URL / website
            if re.search(r'(?:https?://|www\.)\S+', t, re.I):
                return True
            # Street address pattern (number + street word or postal code)
            if re.search(r'\d+\s+(?:rue|avenue|boulevard|street|main|road|chemin)\b', t, re.I):
                return True
            if re.search(r'\b\d{5}\b', t):  # 5-digit postal/zip code
                return True
            return False

        if 'summary' not in sections_rebuilt and sections_found:
            summary_content = _build_section_content('summary', employee, preferred_language)
            if summary_content:
                first_sec_pos = body_children.index(sections_found[0][1])
                summary_candidates = [
                    p for p in _body_block_candidates(0, first_sec_pos)
                    if not _is_contact_para(p)
                ]
                if summary_candidates:
                    rendered_paras = _render_section_paragraphs(
                        summary_content,
                        summary_candidates,
                    )
                    anchor = summary_candidates[0]
                    for new_p in rendered_paras:
                        anchor.addprevious(new_p)
                    for elem in summary_candidates:
                        try:
                            body.remove(elem)
                        except ValueError:
                            pass
                    replaced += 1
                    logger.info(
                        f"  'summary': injected {len(rendered_paras)} lines, "
                        f"replaced {len(summary_candidates)} body block paragraphs"
                    )

        # --- Experience block: body paragraphs between last header and education ---
        if 'experience' not in sections_rebuilt:
            exp_content = _build_section_content('experience', employee, preferred_language)
            if exp_content:
                edu_heading = next((h for s, h in sections_found if s == 'education'), None)
                if edu_heading is not None:
                    live_body = list(body)
                    if edu_heading in live_body:
                        edu_pos = live_body.index(edu_heading)
                        # Walk backwards to find where experience content starts
                        # (the paragraph after the last header textbox / mc-only spacer)
                        exp_start = 0
                        for k in range(edu_pos - 1, -1, -1):
                            c = live_body[k]
                            if _para_is_textbox(c):
                                exp_start = k + 1
                                break
                            if c.tag == f'{{{W}}}p':
                                texts = [t.text for t in c.iter(f'{{{W}}}t') if t.text]
                                if not ''.join(texts).strip() and c.find(f'.//{_mc_tag}') is not None:
                                    exp_start = k + 1
                                    break
                        exp_candidates = _body_block_candidates(exp_start, edu_pos)
                        if exp_candidates:
                            rendered_paras = _render_section_paragraphs(
                                exp_content,
                                exp_candidates,
                            )
                            anchor = exp_candidates[0]
                            for new_p in rendered_paras:
                                anchor.addprevious(new_p)
                            for elem in exp_candidates:
                                try:
                                    body.remove(elem)
                                except ValueError:
                                    pass
                            # ── Page-break before FORMATION heading ──────────
                            # The Canadian 2-page template has a 2nd page header
                            # (floating TXBX) anchored to the first body paragraph
                            # on page 2. Without pushing content to page 2, that
                            # TXBX lands on page 1 and overlaps everything.
                            # Adding pageBreakBefore to FORMATION ensures page 2
                            # always starts there regardless of content volume.
                            _edu_ppr = edu_heading.find(f'{{{W}}}pPr')
                            if _edu_ppr is None:
                                _edu_ppr = etree.Element(f'{{{W}}}pPr')
                                edu_heading.insert(0, _edu_ppr)
                            if _edu_ppr.find(f'{{{W}}}pageBreakBefore') is None:
                                _pgbr = etree.SubElement(_edu_ppr, f'{{{W}}}pageBreakBefore')
                                _pgbr.set(f'{{{W}}}val', '1')
                                logger.info("  'experience': added pageBreakBefore to FORMATION heading")
                            replaced += 1
                            logger.info(
                                f"  'experience': injected before education heading — "
                                f"replaced {len(exp_candidates)} body block paragraphs "
                                f"→ {len(rendered_paras)} lines"
                            )
        # ── end post-loop blocks ─────────────────────────────────────────────────

        if replaced > 0:
            # Write modified XML back
            with open(doc_xml_path, 'wb') as f:
                f.write(etree.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True))

            # Rebuild DOCX zip preserving all files (including textbox XML)
            with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for root_dir, _dirs, files in os.walk(temp_dir):
                    for fname in files:
                        fpath = os.path.join(root_dir, fname)
                        arcname = os.path.relpath(fpath, temp_dir)
                        zout.write(fpath, arcname)

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return replaced
# At the end of the main generation process (after all replacements), call the final cleanup
# Example usage (to be called in the main fallback generation function after all replacements):
# _final_quality_control_cleanup(docx_path)


def _get_txbx_position(txbx_content: Any) -> Optional[Tuple[int, int, int, int]]:
    """Extract (x, y, cx, cy) in EMU from the wp:anchor ancestor of a txbxContent.

    Returns None when the shape has no positional anchor (e.g. inline shapes).
    """
    WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
    anchors = txbx_content.xpath(
        'ancestor::wp:anchor',
        namespaces={'wp': WP_NS},
    )
    if not anchors:
        return None
    anchor = anchors[0]
    pos_h = anchor.find(f'{{{WP_NS}}}positionH')
    pos_v = anchor.find(f'{{{WP_NS}}}positionV')
    extent = anchor.find(f'{{{WP_NS}}}extent')
    if pos_h is None or pos_v is None or extent is None:
        return None
    x_off = pos_h.find(f'{{{WP_NS}}}posOffset')
    y_off = pos_v.find(f'{{{WP_NS}}}posOffset')
    if x_off is None or y_off is None:
        return None
    try:
        return (
            int(x_off.text or '0'),
            int(y_off.text or '0'),
            int(extent.get('cx', '0')),
            int(extent.get('cy', '0')),
        )
    except ValueError:
        return None


def _replace_txbx_content(
    txbx_content: Any,
    new_content: List[Dict],
    ref_source_elems: Optional[list] = None,
) -> None:
    """Replace all plain paragraphs inside a <w:txbxContent> with *new_content*.

    Preserves any paragraphs that contain embedded drawings/pictures.
    Copies run-properties and spacing from the first existing content paragraph
    to the injected paragraphs so they inherit the template's font/size/color.
    """
    W = NS_W
    children = list(txbx_content)
    removable = [
        c for c in children
        if c.tag == f'{{{W}}}p'
        and b'w:drawing' not in etree.tostring(c)
        and b'w:pict' not in etree.tostring(c)
    ]
    source = ref_source_elems if ref_source_elems else removable
    rendered_paras = _render_section_paragraphs(
        new_content,
        source,
        txbx_target=txbx_content,
    )

    for elem in removable:
        try:
            txbx_content.remove(elem)
        except ValueError:
            pass

    prev: Any = None
    for new_p in rendered_paras:
        if prev is not None:
            prev.addnext(new_p)
        else:
            remaining = list(txbx_content)
            if remaining:
                remaining[-1].addnext(new_p)
            else:
                txbx_content.append(new_p)
        prev = new_p


def _replace_cv_sections_in_textboxes(
    docx_path: str,
    employee: Dict[str, Any],
    body_sections_replaced: int = 0,
    preferred_language: str = "original",
) -> Tuple[int, List[Tuple[str, str]]]:
    """
    Rebuild CV section content that lives INSIDE WPS textboxes.

    Handles two layout patterns:
      A) Heading + content in the SAME textbox (e.g. sidebar sections).
      B) Heading and content in SEPARATE textboxes positioned visually
         (heading above, content below).  Uses spatial proximity matching
         via wp:anchor position offsets.

    Only processes <mc:Choice> shapes (modern WPS).  <mc:Fallback> shapes
    (VML compatibility duplicates) are skipped — they will be synchronised
    by Phase C (mc:Choice → mc:Fallback mirroring).

    Returns (count_rebuilt, extra_pairs) where extra_pairs is a list of
    (old_text, new_text) tuples captured from replaced section content.
    These can be fed into _apply_paragraph_replacements to update headers/
    footers that have duplicate copies of the same content.
    """
    W = NS_W
    temp_dir = tempfile.mkdtemp()
    rebuilt = 0
    extra_pairs: List[Tuple[str, str]] = []
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)

        doc_xml_path = os.path.join(temp_dir, 'word', 'document.xml')
        with open(doc_xml_path, 'rb') as f:
            raw = f.read()
        tree = etree.fromstring(raw)

        txbx_content_tag = f'{{{NS_W}}}txbxContent'
        MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

        # ── Phase A: same-textbox heading + content ──
        heading_alone_sections: set = set()   # section names handled in Phase B

        for txbx_content in tree.iter(txbx_content_tag):
            # Skip mc:Fallback (VML duplicates for older Word versions).
            if txbx_content.xpath(
                'ancestor::mc:Fallback',
                namespaces={'mc': MC},
            ):
                continue

            children = list(txbx_content)
            headings: List[Tuple[str, Any]] = []
            for child in children:
                if child.tag == f'{{{W}}}p':
                    sec = _identify_section_lxml(child)
                    if sec:
                        headings.append((sec, child))

            if not headings:
                continue

            # Check if there are non-heading content paragraphs in this textbox
            heading_elems = {h[1] for h in headings}
            has_content_paras = False
            for child in children:
                if child.tag == f'{{{W}}}p' and child not in heading_elems:
                    txt = ''.join(
                        t.text for t in child.iter(f'{{{W}}}t') if t.text
                    ).strip()
                    if txt:
                        has_content_paras = True
                        break

            if not has_content_paras:
                # Heading alone — defer to Phase B (spatial matching)
                for sec_name, _ in headings:
                    heading_alone_sections.add(sec_name)
                continue

            # Same-textbox: replace content between headings (original logic)
            for h_idx, (sec_name, h_elem) in enumerate(headings):
                next_h_elem = headings[h_idx + 1][1] if h_idx + 1 < len(headings) else None

                live = list(txbx_content)
                if h_elem not in live:
                    continue
                h_pos = live.index(h_elem)
                n_pos = live.index(next_h_elem) if next_h_elem in live else len(live)
                content_elems = live[h_pos + 1: n_pos]

                new_content = _build_section_content(sec_name, employee, preferred_language)
                if new_content is None:
                    for elem in content_elems:
                        try:
                            txbx_content.remove(elem)
                        except ValueError:
                            pass
                    try:
                        txbx_content.remove(h_elem)
                    except ValueError:
                        pass
                    logger.info(
                        "  [txbx] section='%s' heading=%r: no employee data, removed textbox content",
                        sec_name,
                        _paragraph_plain_text(h_elem),
                    )
                    rebuilt += 1
                    continue

                removable = [
                    c for c in content_elems
                    if c.tag == f'{{{W}}}p'
                    and b'w:drawing' not in etree.tostring(c)
                    and b'w:pict' not in etree.tostring(c)
                ]
                rendered_paras = _render_section_paragraphs(
                    new_content,
                    removable,
                    heading_elem=h_elem,
                    txbx_target=txbx_content,
                )
                for elem in removable:
                    try:
                        txbx_content.remove(elem)
                    except ValueError:
                        pass

                insert_after = h_elem
                for new_p in rendered_paras:
                    insert_after.addnext(new_p)
                    insert_after = new_p

                logger.info(
                    "  [txbx] section='%s' heading=%r: removed %d paragraph(s), inserted %d item(s)",
                    sec_name,
                    _paragraph_plain_text(h_elem),
                    len(removable),
                    len(rendered_paras),
                )
                rebuilt += 1

        # ── Phase B: spatial matching for separate heading / content textboxes ──
        # GUARD: skip Phase B when body section replacement already handled the
        # sections.  Templates with both body paragraphs AND heading-only
        # textboxes (e.g. 124-modele-cv-canadien) would otherwise have Phase B
        # spatially assign all textboxes as section content and wipe them.
        if heading_alone_sections and body_sections_replaced == 0:
            def _is_rich_content_shape(
                texts: List[str],
                pos: Tuple[int, int, int, int],
            ) -> bool:
                total_chars = sum(len(t.strip()) for t in texts)
                para_count = len([t for t in texts if t.strip()])
                width = pos[2] if pos else 0
                height = pos[3] if pos else 0
                return (
                    total_chars >= 120
                    or para_count >= 2
                    or (total_chars >= 60 and height >= 600000)
                    or (total_chars >= 60 and width >= 3000000)
                )

            def _content_shape_score(
                texts: List[str],
                pos: Tuple[int, int, int, int],
            ) -> Tuple[int, int, int]:
                total_chars = sum(len(t.strip()) for t in texts)
                para_count = len([t for t in texts if t.strip()])
                area = (pos[2] * pos[3]) if pos else 0
                return (total_chars, para_count, area)

            _LANGUAGE_WORDS = frozenset({
                'anglais', 'english', 'french', 'francais', 'français', 'arabic', 'arabe',
                'spanish', 'espagnol', 'german', 'allemand', 'italian', 'italien',
                'portuguese', 'portugais', 'turkish', 'turc', 'chinese', 'chinois',
                'japanese', 'japonais', 'russian', 'russe', 'hindi', 'urdu',
            })
            _EDU_KEYWORDS = (
                'université', 'universite', 'university', 'college', 'collège',
                'school', 'école', 'ecole', 'lycée', 'lycee', 'institut',
                'institute', 'faculty', 'faculté', 'baccalauréat', 'baccalaureat',
            )
            _DEGREE_KEYWORDS = (
                'licence', 'license', 'master', 'maîtrise', 'maitrise', 'bachelor',
                'diplôme', 'diplome', 'technicien', 'engineer', 'ingénieur',
                'ingenieur', 'doctorat', 'phd', 'certificat', 'certificate',
            )
            _INTEREST_KEYWORDS = (
                'voyage', 'voyages', 'sports', 'sport', 'bénévolat', 'benevolat',
                'loisir', 'loisirs', 'hobby', 'hobbies', 'natation', 'football',
                'escrime', 'association',
            )
            _JOB_KEYWORDS = frozenset({
                'chargé', 'chargée', 'chef', 'directeur', 'directrice', 'manager',
                'ingénieur', 'ingénieure', 'developpeur', 'développeur', 'analyste',
                'assistant', 'assistante', 'responsable', 'coordinateur', 'coordinatrice',
                'technicien', 'technicienne', 'architecte', 'designer', 'project',
                'lead', 'developer', 'engineer', 'administrator', 'administrateur',
            })
            _DATE_RE = re.compile(
                r'(?:\b(?:19|20)\d{2}\b|'
                r'janv|févr|fevr|mars|avr|mai|juin|juil|août|aout|sept|oct|nov|déc|dec|'
                r'present|current|aujourd|today)',
                re.I,
            )
            _PHONE_RE = re.compile(r'\+?\d[\d\s\-\.\(\)]{7,}')
            _CITY_COUNTRY_RE = re.compile(
                r'^[A-ZÀ-Ý][A-Za-zÀ-ÿ\-\' ]+(?:,\s*[A-ZÀ-Ý][A-Za-zÀ-ÿ\-\' ]+)+$'
            )

            def _shape_stats(texts: List[str]) -> Dict[str, Any]:
                clean = [t.strip() for t in texts if t and t.strip()]
                lower_lines = [t.casefold() for t in clean]
                joined = ' '.join(clean)
                lower_joined = ' '.join(lower_lines)
                total_chars = sum(len(t) for t in clean)
                para_count = len(clean)
                max_len = max((len(t) for t in clean), default=0)
                short_alpha_lines = sum(
                    1
                    for t in clean
                    if len(t) <= 28 and re.fullmatch(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ '\-]{1,27}", t)
                )
                language_hits = sum(
                    1
                    for t in lower_lines
                    if t in _LANGUAGE_WORDS or any(t.startswith(lang + ' ') for lang in _LANGUAGE_WORDS)
                )
                school_like = any(kw in lower_joined for kw in _EDU_KEYWORDS)
                degree_like = any(kw in lower_joined for kw in _DEGREE_KEYWORDS)
                interest_like = any(kw in lower_joined for kw in _INTEREST_KEYWORDS)
                job_like = any(re.search(rf'\b{re.escape(kw)}\b', lower_joined) for kw in _JOB_KEYWORDS)
                date_like = bool(_DATE_RE.search(lower_joined))
                city_country_like = any(_CITY_COUNTRY_RE.match(t) for t in clean)
                company_like = any(
                    1 <= len(t.split()) <= 5
                    and t == t.upper()
                    and re.search(r'[A-ZÀ-Ý]', t)
                    for t in clean
                )
                contact_like = bool(
                    any('@' in t for t in clean)
                    or any(re.search(r'(?:https?://|www\.|linkedin\.com)', t, re.I) for t in clean)
                    or any(_PHONE_RE.search(t) for t in clean)
                )
                language_like = language_hits > 0 or (
                    para_count >= 2
                    and short_alpha_lines == para_count
                    and not school_like
                    and not job_like
                    and not company_like
                )
                rich_desc = (
                    total_chars >= 120
                    or max_len >= 100
                    or para_count >= 4
                )
                return {
                    'clean': clean,
                    'total_chars': total_chars,
                    'para_count': para_count,
                    'max_len': max_len,
                    'short_alpha_lines': short_alpha_lines,
                    'language_like': language_like,
                    'school_like': school_like,
                    'degree_like': degree_like,
                    'interest_like': interest_like,
                    'job_like': job_like,
                    'date_like': date_like,
                    'city_country_like': city_country_like,
                    'company_like': company_like,
                    'contact_like': contact_like,
                    'rich_desc': rich_desc,
                }

            def _section_candidate_score(
                sec_name: str,
                info: Dict[str, Any],
                heading_pos: Tuple[int, int, int, int],
            ) -> int:
                stats = info['stats']
                pos = info['pos']
                dist_penalty = int(abs(pos[1] - heading_pos[1]) / 100000)
                score = -dist_penalty

                if sec_name == 'summary':
                    score += min(stats['total_chars'], 320)
                    if stats['rich_desc']:
                        score += 160
                    if stats['para_count'] <= 3:
                        score += 40
                    if stats['language_like'] or stats['school_like'] or stats['date_like']:
                        score -= 220
                    if stats['company_like'] or stats['job_like']:
                        score -= 120
                    if stats['contact_like']:
                        score -= 260
                elif sec_name == 'skills':
                    score += 55 * min(stats['para_count'], 4)
                    if stats['para_count'] >= 2:
                        score += 100
                    if not stats['date_like'] and not stats['school_like'] and not stats['language_like']:
                        score += 80
                    if stats['max_len'] > 160:
                        score -= 160
                    if stats['language_like'] or stats['school_like'] or stats['date_like']:
                        score -= 220
                elif sec_name == 'languages':
                    if stats['language_like']:
                        score += 320
                    score += 80 * min(stats['short_alpha_lines'], 4)
                    if stats['max_len'] > 32:
                        score -= 140
                    if stats['school_like'] or stats['date_like'] or stats['job_like'] or stats['company_like']:
                        score -= 240
                elif sec_name == 'education':
                    if stats['school_like']:
                        score += 220
                    if stats['degree_like']:
                        score += 220
                    if stats['date_like']:
                        score += 100
                    if stats['language_like'] or stats['job_like'] or stats['company_like']:
                        score -= 160
                elif sec_name == 'experience':
                    if stats['date_like']:
                        score += 120
                    if stats['city_country_like']:
                        score += 120
                    if stats['job_like'] or stats['company_like']:
                        score += 120
                    if stats['rich_desc']:
                        score += 140
                    if stats['school_like'] or stats['degree_like'] or stats['language_like']:
                        score -= 200
                elif sec_name == 'interests':
                    if stats['interest_like']:
                        score += 260
                    if stats['para_count'] >= 2 and not stats['date_like'] and not stats['school_like']:
                        score += 40
                    if stats['language_like'] or stats['job_like']:
                        score -= 140

                return score

            # Collect heading-only and content-only textboxes with positions
            heading_shapes: List[Tuple[str, Any, Tuple[int, int, int, int], int]] = []
            content_shapes: List[Tuple[Any, Tuple[int, int, int, int], int, List[str]]] = []

            for order_idx, txbx_content in enumerate(tree.iter(txbx_content_tag)):
                if txbx_content.xpath(
                    'ancestor::mc:Fallback', namespaces={'mc': MC}
                ):
                    continue

                pos = _get_txbx_position(txbx_content)
                if pos is None:
                    continue

                children = list(txbx_content)
                p_children = [c for c in children if c.tag == f'{{{W}}}p']
                if not p_children:
                    continue

                # Check for section heading
                first_sec = _identify_section_lxml(p_children[0])

                # Non-heading text count
                non_heading_texts = []
                heading_set = set()
                for pc in p_children:
                    s = _identify_section_lxml(pc)
                    if s:
                        heading_set.add(pc)
                    else:
                        txt = ''.join(
                            t.text for t in pc.iter(f'{{{W}}}t') if t.text
                        ).strip()
                        if txt:
                            non_heading_texts.append(txt)

                if first_sec and first_sec in heading_alone_sections and not non_heading_texts:
                    heading_shapes.append((first_sec, txbx_content, pos, order_idx))
                elif not first_sec and non_heading_texts:
                    content_shapes.append((txbx_content, pos, order_idx, non_heading_texts))

            if heading_shapes and content_shapes:
                heading_positions = {sec_name: pos for sec_name, _txbx, pos, _order in heading_shapes}
                semantic_candidates: Dict[str, List[Dict[str, Any]]] = {
                    sec_name: [] for sec_name in heading_positions
                }
                claim_order = [
                    sec for sec in ('summary', 'languages', 'skills', 'interests', 'education', 'experience')
                    if sec in heading_positions
                ]
                thresholds = {
                    'summary': 140,
                    'languages': 140,
                    'skills': 130,
                    'interests': 120,
                    'education': 120,
                    'experience': 80,
                }
                scored_content_infos: List[Dict[str, Any]] = []
                for c_txbx, c_pos, c_order, c_texts in content_shapes:
                    scored_content_infos.append(
                        {
                            'txbx': c_txbx,
                            'pos': c_pos,
                            'y': c_pos[1],
                            'order': c_order,
                            'texts': c_texts,
                            'stats': _shape_stats(c_texts),
                        }
                    )

                claimed_ids: set[int] = set()
                for sec_name in claim_order:
                    heading_pos = heading_positions[sec_name]
                    ranked: List[Tuple[int, Dict[str, Any]]] = []
                    for info in scored_content_infos:
                        if id(info['txbx']) in claimed_ids:
                            continue
                        score = _section_candidate_score(sec_name, info, heading_pos)
                        if score >= thresholds.get(sec_name, 120):
                            ranked.append((score, info))

                    if not ranked:
                        continue

                    ranked.sort(key=lambda item: item[0], reverse=True)
                    best_score = ranked[0][0]
                    if sec_name == 'summary':
                        chosen_infos = [ranked[0][1]]
                    elif sec_name in {'languages', 'skills'}:
                        chosen_infos = [
                            info for score, info in ranked
                            if score >= best_score - 80
                        ][:4]
                    elif sec_name == 'interests':
                        chosen_infos = [ranked[0][1]]
                    else:
                        chosen_infos = [info for _score, info in ranked]

                    for score, info in ranked:
                        if info in chosen_infos:
                            info['match_score'] = score

                    if sec_name == 'experience':
                        chosen_infos.sort(key=lambda info: (info['y'], info['order']))
                    else:
                        chosen_infos.sort(
                            key=lambda info: (-int(info.get('match_score', 0)), info['y'], info['order'])
                        )

                    semantic_candidates[sec_name] = chosen_infos
                    claimed_ids.update(id(info['txbx']) for info in chosen_infos)
                    logger.info(
                        "  [txbx-spatial] section='%s': semantic preassignment selected %d candidate box(es)",
                        sec_name,
                        len(chosen_infos),
                    )

                # Column tolerance: shapes within 1 inch (~914400 EMU) horizontally
                # are considered in the same visual column.
                COL_TOL = 914400

                # Sort headings by x then y
                heading_shapes.sort(key=lambda h: (h[2][0], h[2][1]))
                heading_shapes_by_order = sorted(heading_shapes, key=lambda h: h[3])

                matched_content: set = set()  # id() of matched content txbx

                for sec_name, h_txbx, (hx, hy, hcx, hcy), h_order in heading_shapes:
                    assigned_infos = semantic_candidates.get(sec_name) or []
                    if assigned_infos:
                        candidates = [
                            (info['txbx'], info['y'], info['order'], info['texts'], info['pos'])
                            for info in assigned_infos
                        ]
                        for info in assigned_infos:
                            matched_content.add(id(info['txbx']))
                    else:
                        # Find the y of the next heading in the same column
                        next_y = float('inf')
                        for other_sec, _, (ox, oy, _, _), _other_order in heading_shapes:
                            if abs(ox - hx) < COL_TOL and oy > hy:
                                next_y = min(next_y, oy)

                        next_order = float('inf')
                        for _other_sec, _other_txbx, _other_pos, other_order in heading_shapes_by_order:
                            if other_order > h_order:
                                next_order = other_order
                                break

                        # Find content textboxes in same column, below heading,
                        # above next heading
                        candidates = []
                        for c_txbx, (cx, cy, ccx, ccy), c_order, c_texts in content_shapes:
                            if id(c_txbx) in matched_content:
                                continue
                            if abs(cx - hx) < COL_TOL and cy >= hy and cy < next_y:
                                candidates.append((c_txbx, cy, c_order, c_texts, (cx, cy, ccx, ccy)))

                        if sec_name == 'experience':
                            has_rich_spatial = any(
                                _is_rich_content_shape(c_texts, c_pos)
                                for _c_txbx, _cy, _c_order, c_texts, c_pos in candidates
                            )
                            if not has_rich_spatial:
                                ordered_candidates = []
                                for c_txbx, c_pos, c_order, c_texts in content_shapes:
                                    if id(c_txbx) in matched_content:
                                        continue
                                    if c_order <= h_order or c_order >= next_order:
                                        continue
                                    ordered_candidates.append(
                                        (c_txbx, c_pos[1], c_order, c_texts, c_pos)
                                    )
                                has_rich_ordered = any(
                                    _is_rich_content_shape(c_texts, c_pos)
                                    for _c_txbx, _cy, _c_order, c_texts, c_pos in ordered_candidates
                                )
                                if has_rich_ordered:
                                    candidates = ordered_candidates
                                    logger.info(
                                        "  [txbx-spatial] section='%s': using XML-order fallback with %d candidate box(es)",
                                        sec_name,
                                        len(candidates),
                                    )

                    # Find the y of the next heading in the same column
                    if not candidates:
                        continue

                    candidates.sort(key=lambda c: c[1])  # top to bottom

                    for c_txbx, *_rest in candidates:
                        matched_content.add(id(c_txbx))

                    # Capture old paragraph text BEFORE replacement — these will
                    # be returned as extra replacement pairs so that copies in
                    # headers/footers are also updated.
                    old_para_texts = []
                    for c_txbx, _cy, _c_order, _c_texts, _c_pos in candidates:
                        for p in c_txbx.iter(f'{{{W}}}p'):
                            t = ''.join(
                                tx.text for tx in p.iter(f'{{{W}}}t') if tx.text
                            ).strip()
                            if t and len(t) > 15:
                                old_para_texts.append(t)

                    new_content = _build_section_content(sec_name, employee, preferred_language)
                    if new_content is None:
                        # No data — blank all content textboxes
                        for c_txbx, *_rest in candidates:
                            for p in list(c_txbx):
                                if p.tag == f'{{{W}}}p':
                                    for t in p.iter(f'{{{W}}}t'):
                                        t.text = ''
                        logger.info(
                            "  [txbx-spatial] section='%s': no employee data, blanked %d content box(es)",
                            sec_name,
                            len(candidates),
                        )
                        rebuilt += 1
                        continue

                    if candidates:
                        ref_source = []
                        for c_txbx, _cy, _c_order, _c_texts, _c_pos in candidates:
                            ref_source.extend(list(c_txbx))
                        ref_rpr = _get_ref_rpr(ref_source)
                        new_content = _reflow_textbox_section_items(
                            new_content,
                            candidates[0][0],
                            ref_rpr=ref_rpr,
                        )

                    # ── Entry-aware distribution across textboxes ──
                    # Split section items into logical entries (each starting
                    # with a compact date or bold title line).
                    entries: List[List[Dict]] = []
                    cur_entry: List[Dict] = []
                    for item in new_content:
                        is_entry_start = (
                            (item.get('compact') and not item.get('bullet'))
                            or (item.get('bold') and not item.get('bullet')
                                and not item.get('compact')
                                and cur_entry
                                and not cur_entry[-1].get('compact'))
                        )
                        if is_entry_start and cur_entry:
                            entries.append(cur_entry)
                            cur_entry = [item]
                        else:
                            cur_entry.append(item)
                    if cur_entry:
                        entries.append(cur_entry)

                    candidate_infos = [
                        {
                            'txbx': c_txbx,
                            'y': cy,
                            'order': c_order,
                            'texts': c_texts,
                            'pos': c_pos,
                        }
                        for c_txbx, cy, c_order, c_texts, c_pos in candidates
                    ]

                    active_candidates = candidate_infos
                    blank_candidates: List[Dict[str, Any]] = []

                    if sec_name == 'experience' and candidate_infos:
                        rich_candidates = [
                            info for info in candidate_infos
                            if _is_rich_content_shape(info['texts'], info['pos'])
                        ]
                        if rich_candidates:
                            rich_candidates.sort(key=lambda info: (info['y'], info['order']))
                            if len(entries) <= len(rich_candidates):
                                active_candidates = rich_candidates[:len(entries)]
                            else:
                                active_candidates = rich_candidates
                            active_ids = {id(info['txbx']) for info in active_candidates}
                            blank_candidates = [
                                info for info in candidate_infos
                                if id(info['txbx']) not in active_ids
                            ]
                        else:
                            best = max(
                                candidate_infos,
                                key=lambda info: _content_shape_score(info['texts'], info['pos']),
                            )
                            active_candidates = [best]
                            blank_candidates = [
                                info for info in candidate_infos
                                if id(info['txbx']) != id(best['txbx'])
                            ]
                    elif sec_name == 'education' and candidate_infos:
                        best = max(
                            candidate_infos,
                            key=lambda info: _content_shape_score(info['texts'], info['pos']),
                        )
                        active_candidates = [best]
                        blank_candidates = [
                            info for info in candidate_infos
                            if id(info['txbx']) != id(best['txbx'])
                        ]

                    n_boxes = len(active_candidates)
                    if n_boxes == 1 or len(entries) <= 1:
                        _replace_txbx_content(active_candidates[0]['txbx'], new_content)
                        for info in active_candidates[1:]:
                            _replace_txbx_content(info['txbx'], [{'text': '', 'bold': False, 'bullet': False}])
                    else:
                        # Distribute entries across textboxes (1 entry per box,
                        # or all in first box if more entries than boxes)
                        if len(entries) <= n_boxes:
                            for bi, info in enumerate(active_candidates):
                                if bi < len(entries):
                                    _replace_txbx_content(info['txbx'], entries[bi])
                                else:
                                    _replace_txbx_content(info['txbx'], [{'text': '', 'bold': False, 'bullet': False}])
                        else:
                            # More entries than boxes — preserve the template layout by
                            # spreading consecutive entries across all usable boxes.
                            distributed_entries = _distribute_entries_across_boxes(entries, n_boxes)
                            for bi, info in enumerate(active_candidates):
                                box_content = distributed_entries[bi] if bi < len(distributed_entries) else []
                                if box_content:
                                    _replace_txbx_content(info['txbx'], box_content)
                                else:
                                    _replace_txbx_content(info['txbx'], [{'text': '', 'bold': False, 'bullet': False}])

                    for info in blank_candidates:
                        _replace_txbx_content(info['txbx'], [{'text': '', 'bold': False, 'bullet': False}])

                    logger.info(
                        f"  [txbx-spatial] '{sec_name}': {len(entries)} entries "
                        f"across {n_boxes} content box(es)"
                    )
                    rebuilt += 1

                    # Build extra pairs: old paragraph text → new section text.
                    # These are used by _apply_paragraph_replacements to update
                    # copies of the same content in headers/footers.
                    if (
                        old_para_texts
                        and new_content
                        and _section_supports_textbox_extra_pairs(sec_name)
                    ):
                        new_text = ' '.join(
                            it['text'] for it in new_content if it.get('text')
                        )
                        for old_t in old_para_texts:
                            extra_pairs.append((old_t, new_text))
                            # Also add a shorter sentinel (first sentence or
                            # first 80 chars at a word boundary) so that
                            # header/footer copies — which may differ slightly
                            # in trailing text — still get matched via
                            # substring lookup in _apply_paragraph_replacements.
                            if len(old_t) > 80:
                                dot = old_t.find('.', 40)
                                if dot > 0 and dot < len(old_t) - 5:
                                    short = old_t[:dot + 1]
                                else:
                                    short = old_t[:80].rsplit(' ', 1)[0]
                                if short and short != old_t:
                                    extra_pairs.append((short, new_text))

        # ── Phase C: Mirror mc:Choice → mc:Fallback (VML sync) ──
        # LibreOffice renders VML fallback content.  After modifying mc:Choice
        # textbox paragraphs, copy the paragraphs into the sibling mc:Fallback
        # so both renderers show identical content.
        MC_ALT = f'{{{MC}}}AlternateContent'
        MC_CHOICE = f'{{{MC}}}Choice'
        MC_FALLBACK = f'{{{MC}}}Fallback'
        synced = 0
        for ac in tree.iter(MC_ALT):
            choice = ac.find(MC_CHOICE)
            fallback = ac.find(MC_FALLBACK)
            if choice is None or fallback is None:
                continue
            choice_txbx = choice.find(f'.//{txbx_content_tag}')
            fallback_txbx = fallback.find(f'.//{txbx_content_tag}')
            if choice_txbx is None or fallback_txbx is None:
                continue
            # Compare plain text
            choice_text = ''.join(t.text or '' for t in choice_txbx.iter(f'{{{W}}}t'))
            fallback_text = ''.join(t.text or '' for t in fallback_txbx.iter(f'{{{W}}}t'))
            if choice_text == fallback_text:
                continue
            # Replace fallback paragraphs with deep copies of choice paragraphs
            for child in list(fallback_txbx):
                fallback_txbx.remove(child)
            for child in choice_txbx:
                fallback_txbx.append(copy.deepcopy(child))
            synced += 1
        if synced:
            logger.info(f"  [vml-sync] Mirrored {synced} mc:Choice → mc:Fallback textbox(es)")
            rebuilt = max(rebuilt, 1)  # ensure write-back

        # Also apply VML sync to header/footer XML files
        for hf_name in os.listdir(os.path.join(temp_dir, 'word')):
            if not re.match(r'^(header|footer)\d+\.xml$', hf_name):
                continue
            hf_path = os.path.join(temp_dir, 'word', hf_name)
            with open(hf_path, 'rb') as f:
                hf_tree = etree.fromstring(f.read())
            hf_synced = 0
            for ac in hf_tree.iter(MC_ALT):
                choice = ac.find(MC_CHOICE)
                fallback = ac.find(MC_FALLBACK)
                if choice is None or fallback is None:
                    continue
                c_txbx = choice.find(f'.//{txbx_content_tag}')
                f_txbx = fallback.find(f'.//{txbx_content_tag}')
                if c_txbx is None or f_txbx is None:
                    continue
                ct = ''.join(t.text or '' for t in c_txbx.iter(f'{{{W}}}t'))
                ft = ''.join(t.text or '' for t in f_txbx.iter(f'{{{W}}}t'))
                if ct == ft:
                    continue
                for child in list(f_txbx):
                    f_txbx.remove(child)
                for child in c_txbx:
                    f_txbx.append(copy.deepcopy(child))
                hf_synced += 1
            if hf_synced:
                with open(hf_path, 'wb') as f:
                    f.write(etree.tostring(hf_tree, xml_declaration=True, encoding='UTF-8', standalone=True))
                logger.info(f"  [vml-sync] {hf_name}: mirrored {hf_synced} textbox(es)")
                rebuilt = max(rebuilt, 1)

        if rebuilt > 0:
            with open(doc_xml_path, 'wb') as f:
                f.write(etree.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True))
            with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for root_dir, _dirs, files in os.walk(temp_dir):
                    for fname in files:
                        fpath = os.path.join(root_dir, fname)
                        zout.write(fpath, os.path.relpath(fpath, temp_dir))

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return rebuilt, extra_pairs


# ═══════════════════════════════════════════════════════════════════════════
#  Snapshot textbox positions (for reflow pre-resize baseline)
# ═══════════════════════════════════════════════════════════════════════════

def _snapshot_textbox_positions(docx_path: str) -> Dict[str, Dict[str, int]]:
    """Capture (x, y, cx, cy) for every wps:wsp shape, keyed by (group_index, shape_index).

    Used so that the reflow phase can tell which overlaps existed BEFORE resize
    expanded textbox heights — those are intentional template overlaps that
    should be preserved.
    """
    positions: Dict[str, Dict[str, int]] = {}
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            if 'word/document.xml' not in zf.namelist():
                return positions
            raw = zf.read('word/document.xml')
        tree = etree.fromstring(raw)
        _WPG_TAG = f'{{{NS_WPS.replace("wordprocessingShape","wordprocessingGroup".replace("Shape","Group"))}}}wgp'
        # Use the actual wordprocessingGroup namespace
        _WPG_TAG = '{http://schemas.microsoft.com/office/word/2010/wordprocessingGroup}wgp'
        _WSP = f'{{{NS_WPS}}}wsp'
        _SPR = f'{{{NS_WPS}}}spPr'
        _XFRM = f'{{{NS_A}}}xfrm'
        _OFF = f'{{{NS_A}}}off'
        _EXT = f'{{{NS_A}}}ext'
        for gi, grp in enumerate(tree.iter(_WPG_TAG)):
            for si, wsp in enumerate(grp.findall(_WSP)):
                spr = wsp.find(_SPR)
                if spr is None:
                    continue
                xfrm = spr.find(_XFRM)
                if xfrm is None:
                    continue
                off = xfrm.find(_OFF)
                ext = xfrm.find(_EXT)
                if off is None or ext is None:
                    continue
                try:
                    positions[f"{gi}:{si}"] = {
                        'x': int(off.get('x', '0')),
                        'y': int(off.get('y', '0')),
                        'cx': int(ext.get('cx', '0')),
                        'cy': int(ext.get('cy', '0')),
                    }
                except (ValueError, TypeError):
                    pass
    except Exception:
        pass
    return positions


# ═══════════════════════════════════════════════════════════════════════════
#  Phase — Dynamic TextBox resize after replacement
# ═══════════════════════════════════════════════════════════════════════════

def _resize_textboxes(docx_path: str) -> int:
    """
    After all text replacements, expand WPS textbox heights (cy) so that
    injected content is never clipped.

    Algorithm per textbox:
    1. Get current cx (width in EMUs) to estimate chars-per-line.
    2. Walk every <w:p> inside <w:txbxContent>.
    3. Estimate line count per paragraph from text length + font size.
    4. Sum all line heights + fixed padding.
    5. If calculated height > current cy  →  expand (NEVER shrink).
       Both <a:ext cy> and <wp:extent cy> are updated for complete fidelity.

    Returns count of textboxes whose cy was expanded.
    """
    EMU_PER_INCH        = 914_400
    CHARS_PER_INCH_11PT = 12          # approx characters per inch at 11pt
    LINE_SPACING        = 1.2         # word-processor default
    PADDING_RATIO       = 0.15        # 15 % of content height as safety padding
    MIN_PADDING_EMU     = 30_000      # ~0.03 in absolute minimum
    DEFAULT_FONT_PT     = 11.0
    EMU_PER_PT          = 12_700

    temp_dir = tempfile.mkdtemp()
    resized  = 0
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)

        doc_xml_path = os.path.join(temp_dir, 'word', 'document.xml')
        with open(doc_xml_path, 'rb') as f:
            raw = f.read()
        tree = etree.fromstring(raw)

        changed = False
        for txbx in tree.iter(_WPS_TXBX):
            curr_cx = _get_shape_cx(txbx)
            curr_cy = _get_shape_cy(txbx)
            if curr_cy <= 0:
                continue

            # Estimate available line width in characters
            width_inches   = (curr_cx / EMU_PER_INCH) if curr_cx > 0 else 2.0
            chars_per_line = max(10, int(width_inches * CHARS_PER_INCH_11PT))

            # txbxContent is in the W namespace
            txbx_content = txbx.find(f'{{{NS_W}}}txbxContent')
            if txbx_content is None:
                continue

            # Skip textboxes with no visible text (blanked by cross-textbox merge)
            all_text = ''.join(t.text or '' for t in txbx_content.iter(f'{{{NS_W}}}t')).strip()
            if not all_text:
                continue

            content_emu = 0
            for p_elem in txbx_content.iter(f'{{{NS_W}}}p'):
                # Detect font size from first run that declares <w:sz>
                font_pt = DEFAULT_FONT_PT
                for r in p_elem.iter(f'{{{NS_W}}}r'):
                    rpr = r.find(f'{{{NS_W}}}rPr')
                    if rpr is not None:
                        sz = rpr.find(f'{{{NS_W}}}sz')
                        if sz is not None:
                            try:
                                half_pts = int(sz.get(f'{{{NS_W}}}val', '0'))
                                if half_pts > 0:
                                    font_pt = half_pts / 2.0
                                    break
                            except (ValueError, TypeError):
                                pass

                # Build paragraph text
                para_text  = ''.join(t.text or '' for t in p_elem.iter(f'{{{NS_W}}}t'))
                char_count = len(para_text.strip())

                # Scale chars_per_line by font ratio (larger font → fewer chars/line)
                adjusted_cpl = max(5, int(chars_per_line * (DEFAULT_FONT_PT / font_pt)))
                line_count   = max(1, math.ceil(char_count / adjusted_cpl)) if char_count else 1
                line_height_emu = int(font_pt * EMU_PER_PT * LINE_SPACING)
                content_emu += line_count * line_height_emu

                # ── Width expansion for single-line content ──────────────────
                # If the paragraph text fits on one line but the estimated text
                # width exceeds the current cx, expand cx so the text is not
                # clipped horizontally (e.g. "Chef de proje" → "Chef de projet").
                if curr_cx > 0 and char_count > 0:
                    EMU_PER_CHAR = int(EMU_PER_INCH / max(1, CHARS_PER_INCH_11PT)
                                       * (DEFAULT_FONT_PT / font_pt))
                    needed_cx = int(char_count * EMU_PER_CHAR * 1.15)  # 15 % buffer
                    if needed_cx > curr_cx:
                        _set_shape_cx(txbx, needed_cx)
                        curr_cx = needed_cx
                        # Recalculate chars_per_line with new width
                        width_inches   = needed_cx / EMU_PER_INCH
                        chars_per_line = max(10, int(width_inches * CHARS_PER_INCH_11PT))
                        changed = True

            # Proportional padding: 15% of content height, minimum 30K EMU
            total_emu = content_emu + max(MIN_PADDING_EMU, int(content_emu * PADDING_RATIO))

            # Cap at sane maximum (~22 inches) to prevent integer overflow in Word
            _MAX_SHAPE_CY = 20_000_000
            if total_emu > _MAX_SHAPE_CY:
                logger.warning(
                    f"[resize_textboxes] Capping cy from {total_emu} to {_MAX_SHAPE_CY}")
                total_emu = _MAX_SHAPE_CY

            # Only expand height, never shrink
            if total_emu > curr_cy:
                _set_shape_cy(txbx, total_emu)
                resized += 1
                changed = True
                logger.debug(
                    f"[resize_textboxes] cx={curr_cx} cy {curr_cy} → {total_emu}"
                )

        if changed:
            with open(doc_xml_path, 'wb') as f:
                f.write(
                    etree.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True)
                )
            with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for root_dir, _dirs, files in os.walk(temp_dir):
                    for fname in files:
                        fpath = os.path.join(root_dir, fname)
                        zout.write(fpath, os.path.relpath(fpath, temp_dir))

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    logger.info(f"[resize_textboxes] Expanded {resized} textbox(es)")
    return resized


def _reflow_contact_textboxes(docx_path: str,
                              pre_resize_pos: Optional[Dict[str, Dict[str, int]]] = None) -> int:
    """
    After all text replacements and height expansion, prevent vertical overlap
    between textboxes that share the same x-column inside WPS groups.

    ``pre_resize_pos`` (optional) maps ``"group_idx:shape_idx"`` to the shape's
    (x, y, cx, cy) **before** resize ran.  When provided, overlaps that already
    existed in the pre-resize layout are treated as intentional and skipped.

    Algorithm:
    1. For each wpg:wgp group, collect ALL child shapes with (x, y, cx, cy).
    2. Group TEXT shapes by x-column.
    3. Sort each column by y and calculate required shifts.
    4. Apply shifts to text shapes AND their companion shapes (icons/decorators
       in the same y-band) so icons stay visually aligned with their text.
    5. If the group's ext cy is exceeded, expand it.

    Returns count of shapes repositioned.
    """
    NS_WPG_TAG = '{http://schemas.microsoft.com/office/word/2010/wordprocessingGroup}wgp'
    NS_WPG_GRPSPR = '{http://schemas.microsoft.com/office/word/2010/wordprocessingGroup}grpSpPr'
    _WPS_WSP = f'{{{NS_WPS}}}wsp'
    _WPS_SPR = f'{{{NS_WPS}}}spPr'
    _WPS_TXBX = f'{{{NS_WPS}}}txbx'
    _A_XFRM = f'{{{NS_A}}}xfrm'
    _A_OFF = f'{{{NS_A}}}off'
    _A_EXT = f'{{{NS_A}}}ext'
    _A_CHEXT = f'{{{NS_A}}}chExt'
    _MC_FB = f'{{{NS_MC}}}Fallback'
    GAP_EMU = 25_000           # ~0.03 inches gap between rows
    X_TOLERANCE = 50_000       # text shapes within 50k EMU → same column
    Y_COMPANION_TOL = 50_000   # companion shapes within 50k EMU of text row
    MAX_COMPANION_CY = 400_000 # skip tall spanning shapes (decorative lines)

    temp_dir = tempfile.mkdtemp()
    repositioned = 0
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)

        doc_xml_path = os.path.join(temp_dir, 'word', 'document.xml')
        with open(doc_xml_path, 'rb') as f:
            raw = f.read()
        tree = etree.fromstring(raw)

        changed = False

        for gi, grp in enumerate(tree.iter(NS_WPG_TAG)):
            # Skip groups inside mc:Fallback
            p = grp.getparent()
            in_fb = False
            while p is not None:
                if p.tag == _MC_FB:
                    in_fb = True
                    break
                p = p.getparent()
            if in_fb:
                continue

            # Collect ALL child shapes with positions
            shapes_info = []  # (wsp, x, y, cx, cy, has_text, pos_key)
            for si, wsp in enumerate(grp.findall(_WPS_WSP)):
                spr = wsp.find(_WPS_SPR)
                if spr is None:
                    continue
                xfrm = spr.find(_A_XFRM)
                if xfrm is None:
                    continue
                off = xfrm.find(_A_OFF)
                ext = xfrm.find(_A_EXT)
                if off is None or ext is None:
                    continue
                try:
                    x = int(off.get('x', 0))
                    y = int(off.get('y', 0))
                    cx = int(ext.get('cx', 0))
                    cy = int(ext.get('cy', 0))
                except (ValueError, TypeError):
                    continue
                # Check if textbox has any text
                txbx = wsp.find(_WPS_TXBX)
                has_text = False
                if txbx is not None:
                    tc = txbx.find(f'{{{NS_W}}}txbxContent')
                    if tc is not None:
                        txt = ''.join(t.text or '' for t in tc.iter(f'{{{NS_W}}}t')).strip()
                        has_text = bool(txt)
                pos_key = f"{gi}:{si}"
                shapes_info.append((wsp, x, y, cx, cy, has_text, pos_key))

            if len(shapes_info) < 2:
                continue

            # ── Step A: Group TEXT shapes by x-column ──
            text_shapes = [s for s in shapes_info if s[5]]
            columns: Dict[int, list] = {}
            for info in text_shapes:
                _, x, y, cx, cy, has_text, _pk = info
                matched_col = None
                for col_x in columns:
                    if abs(x - col_x) <= X_TOLERANCE:
                        matched_col = col_x
                        break
                if matched_col is not None:
                    columns[matched_col].append(info)
                else:
                    columns[x] = [info]

            # ── Step B: Reflow text shapes & record (original_y → delta) ──
            # Maps original y of shifted text shapes → shift delta
            shift_map: Dict[int, int] = {}

            for col_x, col_shapes in columns.items():
                if len(col_shapes) < 2:
                    continue
                col_shapes.sort(key=lambda s: s[2])

                for i in range(len(col_shapes) - 1):
                    _, _, upper_y, _, upper_cy, _, upper_pk = col_shapes[i]
                    wsp_lower, _, lower_y, _, lower_cy, _, lower_pk = col_shapes[i + 1]
                    upper_bottom = upper_y + upper_cy
                    if upper_bottom + GAP_EMU > lower_y:
                        # ── Skip if this overlap existed BEFORE resize ──
                        # If pre-resize data shows the upper shape's bottom
                        # was already >= lower shape's y, the overlap is
                        # intentional template design (e.g. name + title).
                        if pre_resize_pos:
                            pre_upper = pre_resize_pos.get(upper_pk)
                            pre_lower = pre_resize_pos.get(lower_pk)
                            if pre_upper and pre_lower:
                                pre_upper_bottom = pre_upper['y'] + pre_upper['cy']
                                if pre_upper_bottom >= pre_lower['y']:
                                    # Overlap was already present — skip reflow
                                    continue

                        new_y = upper_bottom + GAP_EMU
                        delta = new_y - lower_y
                        # Record shift before applying (original lower_y → delta)
                        orig_lower_y = lower_y
                        for prev_orig_y, prev_delta in shift_map.items():
                            if abs((prev_orig_y + prev_delta) - lower_y) < 100:
                                orig_lower_y = prev_orig_y
                                break
                        shift_map[orig_lower_y] = new_y - orig_lower_y

                        spr = wsp_lower.find(_WPS_SPR)
                        if spr is not None:
                            xfrm = spr.find(_A_XFRM)
                            if xfrm is not None:
                                off = xfrm.find(_A_OFF)
                                if off is not None:
                                    off.set('y', str(new_y))
                                    col_shapes[i + 1] = (wsp_lower, col_shapes[i+1][1], new_y,
                                                          col_shapes[i+1][3], col_shapes[i+1][4],
                                                          col_shapes[i+1][5], col_shapes[i+1][6])
                                    repositioned += 1
                                    changed = True

            # ── Step C: Apply companion shifts to non-text shapes ──
            if shift_map:
                non_text = [s for s in shapes_info if not s[5]]
                already_shifted: set = set()
                for orig_text_y, delta in shift_map.items():
                    for nt_wsp, nt_x, nt_y, nt_cx, nt_cy, _, _pk in non_text:
                        if id(nt_wsp) in already_shifted:
                            continue
                        # Skip tall spanning shapes (decorative vertical lines)
                        if nt_cy > MAX_COMPANION_CY:
                            continue
                        # Skip the full-width background / header shapes
                        if nt_cx > 5_000_000:
                            continue
                        # Match by y-proximity to the ORIGINAL text y
                        if abs(nt_y - orig_text_y) <= Y_COMPANION_TOL:
                            new_nt_y = nt_y + delta
                            spr = nt_wsp.find(_WPS_SPR)
                            if spr is not None:
                                xfrm = spr.find(_A_XFRM)
                                if xfrm is not None:
                                    off = xfrm.find(_A_OFF)
                                    if off is not None:
                                        off.set('y', str(new_nt_y))
                                        already_shifted.add(id(nt_wsp))
                                        repositioned += 1
                                        changed = True

            # ── Step D: Expand group extents if needed ──
            if changed:
                grp_spr = grp.find(NS_WPG_GRPSPR)
                if grp_spr is not None:
                    grp_xfrm = grp_spr.find(_A_XFRM)
                    if grp_xfrm is not None:
                        ch_ext = grp_xfrm.find(_A_CHEXT)
                        grp_ext = grp_xfrm.find(_A_EXT)
                        max_bottom = 0
                        for wsp in grp.findall(_WPS_WSP):
                            spr = wsp.find(_WPS_SPR)
                            if spr is None:
                                continue
                            xfrm = spr.find(_A_XFRM)
                            if xfrm is None:
                                continue
                            off = xfrm.find(_A_OFF)
                            ext = xfrm.find(_A_EXT)
                            if off is None or ext is None:
                                continue
                            try:
                                sy = int(off.get('y', 0))
                                scy = int(ext.get('cy', 0))
                                max_bottom = max(max_bottom, sy + scy)
                            except (ValueError, TypeError):
                                pass
                        if ch_ext is not None:
                            try:
                                old_cy = int(ch_ext.get('cy', 0))
                                if max_bottom > old_cy:
                                    ch_ext.set('cy', str(max_bottom + GAP_EMU))
                            except (ValueError, TypeError):
                                pass
                        if grp_ext is not None:
                            try:
                                old_cy = int(grp_ext.get('cy', 0))
                                if max_bottom > old_cy:
                                    grp_ext.set('cy', str(max_bottom + GAP_EMU))
                            except (ValueError, TypeError):
                                pass

        if changed:
            with open(doc_xml_path, 'wb') as f:
                f.write(etree.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True))
            with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for root_dir, _dirs, files in os.walk(temp_dir):
                    for fname in files:
                        fpath = os.path.join(root_dir, fname)
                        zout.write(fpath, os.path.relpath(fpath, temp_dir))

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    if repositioned:
        logger.info(f"[reflow_textboxes] Repositioned {repositioned} textbox(es)")
    return repositioned


def _detect_template_mode(docx_path: str) -> str:
    """Check if template uses Jinja2 placeholders.

    Uses a fast byte-scan of the zip to avoid a redundant full extraction
    (the caller will do that later for direct mode).

    Only counts a match when the ``{{…}}`` pair appears inside a
    ``<w:t>`` element in ``word/document.xml`` — this prevents false
    positives from JavaScript ``{{ }}`` in ``word/comments.xml`` or
    other ancillary parts.
    """
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            if 'word/document.xml' in zf.namelist():
                raw = zf.read('word/document.xml')
                # Match {{ token }} inside <w:t ...>...</w:t> segments
                # A simple heuristic: if both {{ and }} appear, it's likely Jinja2
                if b'{{' in raw and b'}}' in raw:
                    # Extra check: require at least one known placeholder name
                    _KNOWN_TOKENS = [
                        b'{{ full_name', b'{{ name', b'{{ email', b'{{ phone',
                        b'{{ title', b'{{ summary', b'{{ skills', b'{{ address',
                        b'{{full_name', b'{{name', b'{{email', b'{{phone',
                        b'{{title', b'{{summary', b'{{skills', b'{{address',
                    ]
                    if any(tok in raw for tok in _KNOWN_TOKENS):
                        logger.info("Template syntax scan: Jinja2 markers detected")
                        return "placeholder"
                    # Has {{ }} but no known tokens — could be literal text
                    logger.info("Template syntax scan: '{{ }}' found but no known Jinja tokens")
                    return "direct"
    except (zipfile.BadZipFile, Exception) as exc:
        logger.warning(f"Template syntax scan failed (defaulting to direct): {exc}")

    logger.info("Template syntax scan: no Jinja markers (direct pipeline)")
    return "direct"


def _supports_fast_placeholder_render(docx_path: str) -> bool:
    """Return True when the template is simple enough for docxtpl rendering.

    Placeholder mode is the only mode that can reliably execute Jinja loop
    constructs (tables/sections authored with ``{% ... %}``).  We therefore
    prefer placeholder mode by default and only disable it if explicitly
    requested via env.
    """
    if os.getenv("CV_PLACEHOLDER_FAST_MODE", "1") == "0":
        return False

    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            xml_members = [
                name for name in zf.namelist()
                if name.startswith('word/') and name.endswith('.xml')
            ]
            if not xml_members:
                return False
            # If we reached here and the template is a valid DOCX, let docxtpl try.
            # Structural tags such as {%tr ...%} are expected in many templates.
            return True
    except Exception as exc:
        logger.warning(f"Placeholder capability scan failed (defaulting to direct): {exc}")
        return False


def _plan_template_execution(docx_path: str) -> Dict[str, Any]:
    """Analyze a template and choose the most appropriate execution strategy.

    The generator previously only knew whether a template looked like
    placeholder-based or direct-replacement. In practice, direct templates fall
    into multiple structural families: body-section templates, textbox-heavy
    infographic templates, layout-table templates, and hybrids. This planner
    classifies the template up front so downstream phases can favor the right
    replacement surfaces instead of treating all direct templates the same.
    """
    plan: Dict[str, Any] = {
        "template_mode": "direct",
        "use_fast_placeholder_render": False,
        "strategy": "direct_text_replacement_only",
        "body_section_headings": 0,
        "textbox_section_headings": 0,
        "heading_only_textboxes": 0,
        "layout_table_detected": False,
        "positioned_textboxes": 0,
        "run_body_section_replacement": True,
        "run_textbox_section_replacement": True,
    }

    template_mode = _detect_template_mode(docx_path)
    plan["template_mode"] = template_mode

    if template_mode == "placeholder":
        fast_placeholder = _supports_fast_placeholder_render(docx_path)
        plan["use_fast_placeholder_render"] = fast_placeholder
        plan["strategy"] = "placeholder_fast" if fast_placeholder else "placeholder_direct"
        plan["run_body_section_replacement"] = not fast_placeholder
        plan["run_textbox_section_replacement"] = not fast_placeholder
        return plan

    W = NS_W
    txbx_content_tag = f'{{{W}}}txbxContent'
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            raw = zf.read('word/document.xml')
        tree = etree.fromstring(raw)
    except Exception as exc:
        logger.warning(f"Template strategy analysis failed (defaulting to direct text-only): {exc}")
        plan["run_body_section_replacement"] = False
        plan["run_textbox_section_replacement"] = False
        return plan

    body = tree.find(f'{{{W}}}body')
    if body is None:
        body = tree.find(f'.//{{{W}}}body')
    if body is None:
        plan["run_body_section_replacement"] = False
        plan["run_textbox_section_replacement"] = False
        return plan

    body_children = list(body)
    body_section_headings = 0
    for child in body_children:
        if child.tag == f'{{{W}}}p' and _identify_section_lxml(child):
            body_section_headings += 1

    layout_table = _get_layout_table(body)
    layout_table_detected = layout_table is not None

    textbox_section_headings = 0
    heading_only_textboxes = 0
    positioned_textboxes = 0
    for txbx_content in tree.iter(txbx_content_tag):
        if txbx_content.xpath('ancestor::mc:Fallback', namespaces={'mc': NS_MC}):
            continue
        if _get_txbx_position(txbx_content) is not None:
            positioned_textboxes += 1

        paragraphs = [c for c in list(txbx_content) if c.tag == f'{{{W}}}p']
        if not paragraphs:
            continue

        heading_names = [sec for sec in (_identify_section_lxml(p) for p in paragraphs) if sec]
        if not heading_names:
            continue

        textbox_section_headings += 1
        has_non_heading_content = False
        for p in paragraphs:
            if _identify_section_lxml(p):
                continue
            text = ''.join(t.text or '' for t in p.iter(f'{{{W}}}t')).strip()
            if text:
                has_non_heading_content = True
                break
        if not has_non_heading_content:
            heading_only_textboxes += 1

    plan.update(
        {
            "body_section_headings": body_section_headings,
            "textbox_section_headings": textbox_section_headings,
            "heading_only_textboxes": heading_only_textboxes,
            "layout_table_detected": layout_table_detected,
            "positioned_textboxes": positioned_textboxes,
        }
    )

    if body_section_headings > 0 and textbox_section_headings > 0:
        plan["strategy"] = "direct_hybrid_sections"
    elif body_section_headings > 0:
        plan["strategy"] = "direct_body_sections"
    elif layout_table_detected:
        plan["strategy"] = "direct_layout_table"
    elif textbox_section_headings > 0:
        plan["strategy"] = "direct_textbox_sections"
    elif positioned_textboxes >= 4:
        plan["strategy"] = "direct_infographic_text_replacement"
    else:
        plan["strategy"] = "direct_text_replacement_only"

    plan["run_body_section_replacement"] = body_section_headings > 0 or layout_table_detected
    plan["run_textbox_section_replacement"] = textbox_section_headings > 0
    return plan


def _build_placeholder_render_context(employee_data: Dict[str, Any]) -> Dict[str, Any]:
    """Build a docxtpl-friendly context for placeholder templates.

    The fallback engine receives heterogeneous payloads (camelCase/snake_case,
    list items as dict or string).  This helper normalizes common aliases so
    templates authored with loops like ``education``/``experience`` and fields
    like ``edu.school`` or ``exp.period`` render reliably.
    """
    employee = dict(employee_data or {})
    # Normalize common payload variants received from backend.
    if "experience" not in employee and isinstance(employee.get("workExperiences"), list):
        employee["experience"] = employee.get("workExperiences")
    if "education" not in employee and isinstance(employee.get("educations"), list):
        employee["education"] = employee.get("educations")
    if "summary" not in employee and employee.get("professionalSummary"):
        employee["summary"] = employee.get("professionalSummary")

    def _s(value: Any) -> str:
        return str(value).strip() if value is not None else ""

    full_name = _s(employee.get("name"))
    if not full_name:
        full_name = _s(f"{_s(employee.get('firstName'))} {_s(employee.get('lastName'))}")

    current_position = '' if employee.get('_title_derived') else _s(
        employee.get("title")
        or employee.get("current_position")
        or employee.get("currentPosition")
        or employee.get("jobTitle")
    )

    sections = build_structured_cv_sections_payload(employee).get("sections", {})
    exp_rows = sections.get("experience") or []
    edu_rows = sections.get("education") or []

    experience = [
        {
            "title": _s(exp.get("title")),
            "company": _s(exp.get("company")),
            "period": _s(exp.get("dates")),
            "dates": _s(exp.get("dates")),
            "description": _s(exp.get("description") or ""),
        }
        for exp in exp_rows
    ]

    education = [
        {
            "degree": _s(edu.get("degree")),
            "school": _s(edu.get("institution")),
            "institution": _s(edu.get("institution")),
            "period": _s(edu.get("dates")),
            "dates": _s(edu.get("dates")),
        }
        for edu in edu_rows
    ]

    certifications: List[Dict[str, str]] = []
    for cert in (employee.get("certifications") or []):
        if isinstance(cert, dict):
            name = _s(cert.get("name") or cert.get("title"))
            year = _s(cert.get("year") or cert.get("date_obtained") or cert.get("issueDate"))
        else:
            name = _s(cert)
            year = ""
        if name:
            certifications.append({"name": name, "year": year})

    projects: List[Dict[str, str]] = []
    for proj in (employee.get("projects") or []):
        if not isinstance(proj, dict):
            text = _s(proj)
            if text:
                projects.append({"name": text, "title": text, "period": "", "description": text, "role": ""})
            continue
        name = _s(proj.get("name") or proj.get("projectName") or proj.get("title"))
        period = _s(proj.get("period") or proj.get("dates") or proj.get("date_range"))
        if not period:
            start = _s(proj.get("startDate") or proj.get("start_date"))
            end = _s(proj.get("endDate") or proj.get("end_date"))
            if start and end:
                period = f"{start} - {end}"
            else:
                period = start or end
        projects.append(
            {
                "name": name,
                "title": _s(proj.get("title") or name),
                "period": period,
                "dates": period,
                "description": _s(proj.get("description")),
                "role": _s(proj.get("role")),
            }
        )

    skills = sections.get("skills") or []

    summary_text = _s(
        employee.get("summary")
        or employee.get("professionalSummary")
        or employee.get("professional_summary")
    )

    context: Dict[str, Any] = {
        "full_name": full_name,
        "name": full_name,
        "current_position": current_position,
        "title": current_position,
        "job_title": current_position,
        "email": _s(employee.get("email")),
        "phone": _s(employee.get("phone")),
        "telephone": _s(employee.get("phone")),
        "address": _s(employee.get("address")),
        "linkedin": _s(employee.get("linkedin")),
        "summary": summary_text,
        "professional_summary": summary_text,
        "experience": experience,
        "experiences": experience,
        "work_experiences": experience,
        "education": education,
        "educations": education,
        "formation": education,
        "certifications": certifications,
        "projects": projects,
        "skills": skills,
    }

    # Per-row aliases for common template variants.
    for exp in context["experience"]:
        exp.setdefault("jobTitle", exp.get("title", ""))
        exp.setdefault("companyName", exp.get("company", ""))
        exp.setdefault("startDate", "")
        exp.setdefault("endDate", "")
    for edu in context["education"]:
        edu.setdefault("fieldOfStudy", "")
        edu.setdefault("startDate", "")
        edu.setdefault("endDate", edu.get("dates", ""))
    for proj in context["projects"]:
        proj.setdefault("projectName", proj.get("name", ""))
        proj.setdefault("startDate", "")
        proj.setdefault("endDate", "")

    return context


def _build_jinja_scalar_placeholder_pairs(
    paragraphs: List[str],
    employee_data: Dict[str, Any],
) -> List[Tuple[str, str]]:
    """Build deterministic replacements for simple Jinja scalar placeholders.

    This is used by the direct pipeline when a template contains docxtpl/Jinja
    control tags that prevent safe placeholder-mode rendering. It covers header
    tokens like ``{{ full_name }}``, ``{{email}}``, ``{{ phone }}``,
    ``{{ current_position }}``, and ``{{ summary }}`` using the same normalized
    context as placeholder mode, so the output does not depend on AI guesses.
    """
    context = _build_placeholder_render_context(employee_data)
    placeholder_re = re.compile(r'\{\{\s*([a-zA-Z_][\w]*)\s*\}\}')
    pairs: List[Tuple[str, str]] = []
    seen_old: set[str] = set()

    for para in paragraphs or []:
        for match in placeholder_re.finditer(para or ''):
            old_text = match.group(0)
            key = match.group(1)
            value = context.get(key)
            if old_text in seen_old:
                continue
            if isinstance(value, str):
                pairs.append((old_text, value))
                seen_old.add(old_text)

    if pairs:
        logger.info(
            "[jinja_scalar_placeholders] Detected %d deterministic pair(s): %s",
            len(pairs),
            ', '.join(repr(old[:40]) for old, _ in pairs[:6]),
        )
    return pairs


def _render_placeholder_template(
    template_path: str,
    employee_data: Dict[str, Any],
    output_path: str,
) -> None:
    """Render a Jinja/docxtpl-authored DOCX template."""
    context = _build_placeholder_render_context(employee_data)
    doc = DocxTemplate(template_path)
    doc.render(context)
    doc.save(output_path)



# ═══════════════════════════════════════════════════════════════════════════
#  AI-Powered replacement via Groq
# ═══════════════════════════════════════════════════════════════════════════

_AI_PROMPT = """\
You are a precise CV contact-field replacement engine.
The structured section content (experience, education, skills, summary) is handled \
by a SEPARATE pipeline — your ONLY job is to replace personal contact/identity fields \
in the template header so the output carries the correct employee data.

## YOUR SCOPE — exactly these 7 field categories:
1. Full name  (header / banner — ALL CAPS or title-case, as printed in template)
2. Current job title / position  (subtitle line below the name)
3. Email address
4. Phone / mobile number
5. LinkedIn URL or slug
6. Portfolio / personal website URL
7. Physical address / city / country

## NAME MATCHING RULES:
- Find the template's name text exactly as it appears (including ALL-CAPS, accents, spacing).
- Return ONE entry for the full name: {{"old": "LUCAS LEBLANC", "new": "{employee_full_name}"}}.
- If first-name and last-name appear in SEPARATE paragraphs, return TWO entries
  (one per fragment) with the matching employee name parts.
- Never split a single name paragraph into first/last sub-entries.

## STRICT RULES:
- NEVER return empty replacements ("new": ""). If no employee value exists, omit the pair.
- NEVER replace section headings (Expérience, Formation, Compétences, Skills, Education…).
- NEVER replace experience job titles, company names, date ranges, or descriptions.
- NEVER hallucinate data absent from the employee JSON.
- Use the EXACT verbatim text found in the template for every "old" value.
- Ignore invisible Unicode characters (\\u200b, \\u00a0) when matching.
- For fragmented fields (e.g. email local-part and domain in separate runs), \
  use the combined form as it appears contiguously in the template.

## sections_to_clear:
List ONLY top-level section headings that have ZERO employee data and should be hidden.
The employee HAS DATA for: {populated_sections}. NEVER list those sections.
Include only headings present VERBATIM in the template text.

## Language:
{language_hint}
Keep company names, school names, product names, technical acronyms, and proper nouns unchanged.

Output — strict JSON only, no prose, no markdown fences:
{{
  "replacements": [{{"old": "exact template text", "new": "employee value"}}],
  "sections_to_clear": ["VERBATIM HEADING"]
}}

TEMPLATE TEXT:
{template_text}

EMPLOYEE DATA (JSON):
{employee_json}
"""

_VISIBLE_WORD_PART_RE = re.compile(
    r'^word/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$',
    re.I,
)


# Sections the AI must never be allowed to clear.  These are either populated
# by the rendering engine separately (skills, summary) or legally-sensitive
# (certifications), so removing them on an LLM guess causes data loss.
_NEVER_CLEAR_SECTIONS: frozenset = frozenset({
    'skills', 'certifications', 'summary',
})

# Patterns whose presence in an "old" replacement value indicate the text is
# contact information — blanking those out is almost always an LLM hallucination.
_CONTACT_CONTENT_RE = re.compile(
    r'[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}|'   # email address
    r'(?:\+?\d[\d\s.()\-]{5,}\d)',         # phone number
    re.IGNORECASE,
)


_AUTO_CLEAR_SECTION_KEYWORDS: Dict[str, List[str]] = {
    # Sidebar-only sections frequently present in generic templates but usually
    # absent from structured employee payloads.
    'communication': [
        'communication',
        'communications',
        'communication skills',
        'soft skills',
        'compétences relationnelles',
        'aptitudes relationnelles',
        'compétences de communication',
    ],
    'direction': [
        'direction',
        'leadership',
        'management',
        'gestion',
        'managerial skills',
        'leadership skills',
        'management skills',
        'encadrement',
    ],
}


def _normalize_heading_label(text: str) -> str:
    normalized = _normalize_taxonomy_heading(text)
    return re.sub(r'[^a-z0-9]+', ' ', normalized).strip()


def _is_heading_label_match(text: str, keyword: str) -> bool:
    t = _normalize_heading_label(text)
    k = _normalize_heading_label(keyword)
    if not t or not k:
        return False
    if t == k:
        return True
    return t.startswith(k + ' ') or re.search(rf'\b{re.escape(k)}\b', t) is not None


def _has_optional_section_data(employee: Dict[str, Any], canonical: str) -> bool:
    if canonical == 'communication':
        keys = ('communication', 'communications', 'communicationSkills', 'soft_skills', 'softSkills')
    elif canonical == 'direction':
        keys = ('direction', 'leadership', 'management', 'managerialSkills', 'managerial_skills')
    else:
        keys = ()

    for key in keys:
        value = employee.get(key)
        if isinstance(value, str) and value.strip():
            return True
        if isinstance(value, (list, tuple, dict)) and len(value) > 0:
            return True
    return False


def _derive_deterministic_sections_to_clear(
    paragraphs: List[str],
    employee: Dict[str, Any],
) -> List[str]:
    """Find optional template sections to clear without relying on Groq.

    We only consider short heading-like lines to avoid false positives.
    """
    extra: List[str] = []
    seen_norm: set[str] = set()

    for para in paragraphs or []:
        text = (para or '').strip()
        if not text or len(text) > 70:
            continue
        if re.search(r'@|https?://|\d{2,}[/-]\d{2,}', text, re.I):
            continue

        canonical = _canonicalize_section_label_for_clearing(text)
        if canonical is None:
            continue
        if _employee_has_section_content(employee, canonical):
            continue

        norm = _normalize_heading_label(text)
        if norm and norm not in seen_norm:
            seen_norm.add(norm)
            extra.append(text)

    return extra


def _build_groq_input_text(full_text: str, paragraphs: List[str], max_chars: int = 5500) -> str:
    """
    Build a prioritized text excerpt for Groq instead of blindly truncating at N chars.

    Priority order (within max_chars budget):
      1. The contact block paragraph — always first so Groq can find contact info
         even when it appears late in the document.
      2. All section heading lines — short, critical for sections_to_clear detection.
      3. Remaining body text padded to fill the budget.

    This guarantees Groq sees the contact info regardless of template length.
    """
    if len(full_text) <= max_chars:
        return full_text

    # Find contact paragraph (has @ + digit, >30 chars)
    contact_para = ''
    contact_idx = -1
    for i, p in enumerate(paragraphs):
        if '@' in p and re.search(r'\d{3}', p) and len(p) > 30:
            contact_para = p
            contact_idx = i
            break

    # Vicinity fallback: find email paragraph and take ±4 neighbours
    if not contact_para:
        for i, p in enumerate(paragraphs):
            if '@' in p and re.search(r'[\w.+-]+\s*@\s*[\w-]+\.[\w.-]+', p):
                start = max(0, i - 4)
                end = min(len(paragraphs), i + 5)
                contact_para = '\n'.join(paragraphs[start:end])
                contact_idx = i
                break

    if not contact_para:
        return full_text[:max_chars]

    parts: List[str] = [contact_para]
    used = len(contact_para)

    # Add section headings using the same canonical classifier used by clearing.
    for i, p in enumerate(paragraphs):
        if i == contact_idx:
            continue
        t = p.strip()
        if not t or len(t) > 65:
            continue
        if _canonicalize_section_label(t, allow_partial=False) is not None:
            if p not in parts and used + len(p) + 1 <= max_chars:
                parts.append(p)
                used += len(p) + 1

    # Fill remaining budget with body text (excluding already-added parts)
    remaining = max_chars - used - 2
    if remaining > 200:
        added_set = set(parts)
        body_lines = [p for p in paragraphs if p not in added_set]
        body_text = '\n'.join(body_lines)
        if body_text:
            parts.append(body_text[:remaining])

    return '\n'.join(parts)


def _ai_get_replacements(
    template_text: str,
    employee: Dict[str, Any],
    paragraphs: Optional[List[str]] = None,
    preferred_language: Optional[str] = None,
) -> Tuple[List[Tuple[str, str]], List[str]]:
    """
    Call Groq LLM to identify every personal data string in the template
    and return (replacement_pairs, sections_to_clear).

    replacement_pairs: list of (old, new) tuples
    sections_to_clear: list of section heading strings with no employee data
    """
    api_key = settings.GROQ_API_KEY
    if not api_key:
        logger.warning("GROQ_API_KEY not set — falling back to regex detection")
        return [], []

    full_text = template_text
    if paragraphs is None:
        paragraphs = []

    # Use prioritized text instead of a blind character truncation.
    # This guarantees Groq always sees the contact block even in long templates.
    trunc_text = _build_groq_input_text(full_text, paragraphs, max_chars=5500)

    # Build a list of sections the employee actually has data for, so the AI
    # knows not to include them in sections_to_clear
    _populated: List[str] = []
    if employee.get('summary'):
        _populated.append('summary/profile/objective')
    if employee.get('experience') and len(employee['experience']) > 0:
        _populated.append('experience/work history')
    if employee.get('education') and len(employee['education']) > 0:
        _populated.append('education/formation')
    if employee.get('skills') and len(employee['skills']) > 0:
        _populated.append('skills/compétences')
    if employee.get('projects') and len(employee['projects']) > 0:
        _populated.append('projects/key projects')
    if employee.get('certifications') and len(employee['certifications']) > 0:
        _populated.append('certifications')
    if employee.get('languages') and len(employee['languages']) > 0:
        _populated.append('languages/langues')
    if employee.get('interests') and len(employee['interests']) > 0:
        _populated.append("interests/centres d'intérêt")
    populated_sections_str = ', '.join(_populated) if _populated else 'see employee JSON'

    language_hint = _language_instruction(preferred_language)
    prompt = _AI_PROMPT.format(
        template_text=trunc_text,
        employee_json=json.dumps(_trim_employee_for_groq(employee), ensure_ascii=False, indent=2),
        populated_sections=populated_sections_str,
        language_hint=language_hint,
        employee_full_name=(employee.get('name') or '').strip(),
    )

    client = Groq(api_key=api_key, timeout=settings.GROQ_TIMEOUT_SECONDS)
    try:
        response = _groq_with_retry(lambda: client.chat.completions.create(
            model=settings.GROQ_CV_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            max_tokens=1200,
            response_format={"type": "json_object"},
        ))
    except Exception as exc:
        if _is_groq_soft_fallback_error(exc):
            logger.warning(
                "Groq unavailable for this request; continuing with deterministic fallback: %s",
                exc,
            )
        else:
            logger.error(f"Groq API call failed: {exc}")
        return [], []

    raw = (response.choices[0].message.content or '').strip()
    logger.info(f"Groq raw response: {raw[:600]}")

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.error(f"Could not parse Groq JSON response: {exc}\nRaw: {raw[:300]}")
        return [], []

    # ── Extract replacement pairs ──────────────────────────────────────
    if isinstance(parsed, dict):
        items = parsed.get("replacements") or parsed.get("pairs") or []
        if not items and parsed:
            # Legacy: flat dict where keys are old values
            items = [{"old": k, "new": v} for k, v in parsed.items()
                     if k not in ("replacements", "sections_to_clear", "pairs")]
    else:
        items = parsed

    pairs: List[Tuple[str, str]] = []
    from app.services.cv_section_taxonomy import classify_heading as _classify_hd2

    for item in items:
        if not isinstance(item, dict):
            continue
        old = (item.get("old") or "").strip()
        new_raw = item.get("new")
        new = (new_raw or "").strip() if new_raw is not None else ""
        if not old:
            continue
        if old == new:
            continue
        # Never allow replacing section headings (e.g. "Expérience", "Formation")
        # with data values; that corrupts template structure.
        if _classify_hd2(old) is not None:
            logger.warning("Rejected heading replacement from AI: %r -> %r", old, new)
            continue
        # Reject ambiguous glyph-only placeholders (e.g. "……………..").
        # Applying those globally often overwrites multiple unrelated fields.
        if not re.search(r"[A-Za-zÀ-ÿ0-9@]", old):
            logger.warning("Rejected ambiguous glyph-only replacement: %r -> %r", old, new)
            continue
        # Enforce the prompt rule: never accept empty replacements.
        # An empty "new" is either a hallucination or an attempt to blank a
        # field — both are rejected.  Specific destructive cases are logged.
        if not new:
            if _CONTACT_CONTENT_RE.search(old):
                logger.warning("Rejected empty replacement (contact info): %r → ''", old)
            elif _classify_hd2(old) is not None:
                logger.warning("Rejected empty replacement (section heading): %r → ''", old)
            else:
                logger.warning("Rejected empty replacement: %r → ''", old)
            continue
        if old in full_text:
            pairs.append((old, new))
        else:
            for para in paragraphs:
                if old.lower() in para.lower():
                    real_idx = para.lower().find(old.lower())
                    real_old = para[real_idx: real_idx + len(old)]
                    if real_old and real_old not in [p[0] for p in pairs]:
                        pairs.append((real_old, new))
                    break

    pairs.sort(key=lambda x: len(x[0]), reverse=True)

    # ── Extract sections to clear ──────────────────────────────────────
    sections_to_clear: List[str] = []
    if isinstance(parsed, dict):
        raw_stc = parsed.get("sections_to_clear") or []
        if isinstance(raw_stc, list):
            sections_to_clear = [str(s).strip() for s in raw_stc if s]

    # ── Deterministic safety filter ────────────────────────────────────
    # Remove any section heading from sections_to_clear that corresponds to
    # employee data that actually exists.  Uses the shared taxonomy so that
    # all 6 languages and 300+ synonyms are covered, not just a hard-coded
    # English/French subset.
    def _employee_has_field(heading: str) -> bool:
        return _employee_has_section_content(employee, _canonicalize_section_label_for_clearing(heading))

    skipped_ambiguous: List[str] = []
    filtered_stc: List[str] = []
    for heading in sections_to_clear:
        canonical = _canonicalize_section_label_for_clearing(heading)
        if canonical is None:
            skipped_ambiguous.append(heading)
            continue
        if _employee_has_field(heading):
            continue
        filtered_stc.append(heading)

    if skipped_ambiguous:
        logger.info(
            "Safety filter ignored %d ambiguous section(s) from clear list: %s",
            len(skipped_ambiguous),
            skipped_ambiguous,
        )

    if len(filtered_stc) < len(sections_to_clear):
        skipped = [s for s in sections_to_clear if s not in filtered_stc]
        logger.info(f"Safety filter removed {len(skipped)} section(s) from clear list "
                    f"(employee has data): {skipped}")
    sections_to_clear = filtered_stc

    # ── Deterministic supplement (LLM-independent) ─────────────────────
    # Some templates include optional sidebar sections such as
    # "Communication"/"Direction" that Groq may occasionally miss.
    # Detect those headings from template paragraphs and clear them when the
    # employee profile has no dedicated data for them.
    deterministic_stc = _derive_deterministic_sections_to_clear(paragraphs, employee)
    if deterministic_stc:
        existing_norm = {_normalize_heading_label(s) for s in sections_to_clear}
        added = []
        for sec in deterministic_stc:
            norm = _normalize_heading_label(sec)
            if norm and norm not in existing_norm:
                sections_to_clear.append(sec)
                existing_norm.add(norm)
                added.append(sec)
        if added:
            logger.info(
                "Deterministic clear detection added %d section(s): %s",
                len(added),
                added,
            )

    logger.info(f"AI produced {len(pairs)} replacement pairs:")
    for old, new in pairs:
        logger.info(f"  '{old}' → '{new}'")
    if sections_to_clear:
        logger.info(f"AI sections to clear: {sections_to_clear}")

    return pairs, sections_to_clear


def _clear_template_sections(docx_path: str, sections_to_clear: List[str]) -> int:
    """
    Remove the content of specific named sections from the document.

    For each name in sections_to_clear:
    - Finds every <wps:txbx> whose text matches the section label and clears it
      (handles labels embedded in the sidebar like OBJECTIF).
    - Also removes body-level heading + content paragraphs for that section
      using the same safe removal logic as _replace_cv_sections.

    Returns the number of sections actually cleared.
    """
    if not sections_to_clear:
        return 0

    W = NS_W

    temp_dir = tempfile.mkdtemp()
    cleared = 0
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)

        doc_xml_path = os.path.join(temp_dir, 'word', 'document.xml')
        with open(doc_xml_path, 'rb') as f:
            raw = f.read()
        tree = etree.fromstring(raw)

        # ── 1. Clear textbox shapes that hold the section label ────────
        for txbx in tree.iter(_WPS_TXBX):
            t_elems = list(txbx.iter(f'{{{W}}}t'))
            text = ''.join(t.text or '' for t in t_elems).strip()
            for label in sections_to_clear:
                if _section_label_matches_text(text, label):
                    # Clear only this textbox
                    for t in t_elems:
                        t.text = ''
                    logger.info(f"  Cleared textbox label: '{text}'")
                    cleared += 1
                    break

        # ── 2. Remove body-level heading + content paragraphs ─────────
        body = tree.find(f'{{{W}}}body')
        if body is not None:
            body_children = list(body)

            # ── 2a. Remove pre-heading summary paragraphs ────────────
            # If OBJECTIF (or any summary label) is being cleared and the
            # employee has no summary, remove body paragraphs that appear
            # BEFORE the first recognized section heading (those are the
            # template's objective/summary text with no heading of their own).
            if any(_canonicalize_section_label(s) == 'summary' for s in sections_to_clear):
                first_heading_idx = None
                for i, child in enumerate(body_children):
                    if child.tag == f'{{{W}}}p':
                        t = ''.join(t2.text or '' for t2 in child.iter(f'{{{W}}}t')).strip()
                        if _identify_section_lxml(child):
                            first_heading_idx = i
                            break
                if first_heading_idx is not None and first_heading_idx > 0:
                    pre_section = body_children[:first_heading_idx]
                    for elem in pre_section:
                        raw = etree.tostring(elem)
                        # Skip textbox/drawing paragraphs (layout elements)
                        if b'txbxContent' in raw or b'w:drawing' in raw or b'w:pict' in raw:
                            continue
                        body.remove(elem)
                        logger.info(f"  Removed pre-heading summary paragraph")
                    cleared += 1

            for label in sections_to_clear:
                for i, child in enumerate(list(body)):
                    if child.tag != f'{{{W}}}p':
                        continue
                    texts = ''.join(t.text or '' for t in child.iter(f'{{{W}}}t')).strip()
                    if _section_label_matches_text(texts, label):
                        # Found heading — remove it and its safe content range
                        current_body = list(body)
                        idx = current_body.index(child)
                        next_heading_pos = len(current_body)
                        for j in range(idx + 1, len(current_body)):
                            nb = current_body[j]
                            if nb.tag == f'{{{W}}}p' and _identify_section_lxml(nb):
                                next_heading_pos = j
                                break
                        content = current_body[idx + 1: next_heading_pos]
                        removable = []
                        for c in content:
                            raw = etree.tostring(c)
                            if b'txbxContent' in raw:
                                # Small TXBXes (language flags etc.) are safe to remove.
                                # Large TXBX paragraphs — the mega contact-header block
                                # (name + phone + email + address all concatenated)
                                # — are layout anchors: stop here so we don't eat
                                # experience entries injected just after this anchor.
                                txbx_text = ''.join(
                                    t.text for t in c.iter(f'{{{W}}}t') if t.text
                                )
                                if len(txbx_text.strip()) > 50:
                                    break  # contact-header anchor — stop collecting
                                removable.append(c)
                            elif b'w:drawing' in raw or b'w:pict' in raw:
                                pass  # skip drawing-only decorations
                            else:
                                removable.append(c)
                        for elem in removable:
                            try:
                                body.remove(elem)
                            except ValueError:
                                pass
                        body.remove(child)
                        logger.info(f"  Removed body section: '{label}' + {len(removable)} content elements")
                        cleared += 1
                        break

        # ── 3. Clear sections inside layout table cells ───────────────
        # For templates that use a layout table (two-column sidebar), section
        # headings appear as <w:p> inside <w:tc> cells, not as body-level
        # paragraphs.  Groq's sections_to_clear labels (e.g. "Communication",
        # "Direction") need to be cleared there too.
        W_TC = f'{{{W}}}tc'
        W_TR = f'{{{W}}}tr'
        W_P  = f'{{{W}}}p'
        for tc_elem in tree.iter(W_TC):
            tc_children = list(tc_elem)
            for h_idx, child in enumerate(tc_children):
                if child.tag != W_P:
                    continue
                cell_text = ''.join(
                    t.text or '' for t in child.iter(f'{{{W}}}t')
                ).strip()
                for label in sections_to_clear:
                    if _section_label_matches_text(cell_text, label):
                        # Clear all subsequent paragraphs in this cell up to the
                        # next section-like heading paragraph
                        for content_p in tc_children[h_idx + 1:]:
                            if content_p.tag != W_P:
                                continue
                            # Stop at a new section heading
                            following_text = ''.join(
                                t.text or '' for t in content_p.iter(f'{{{W}}}t')
                            ).strip()
                            if following_text and _identify_section_lxml(content_p):
                                break
                            # Clear all <w:t> text in this content paragraph
                            for t in content_p.iter(f'{{{W}}}t'):
                                t.text = ''
                        # Also blank the heading paragraph itself
                        for t in child.iter(f'{{{W}}}t'):
                            t.text = ''
                        logger.info(f"  Cleared layout-table cell section: '{cell_text}'")
                        cleared += 1
                        break

        with open(doc_xml_path, 'wb') as f:
            f.write(etree.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True))
        with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as zout:
            for root_dir, _dirs, files in os.walk(temp_dir):
                for fname in files:
                    fpath = os.path.join(root_dir, fname)
                    zout.write(fpath, os.path.relpath(fpath, temp_dir))
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return cleared



# ═══════════════════════════════════════════════════════════════════════════
#  Generic placeholder detection (second pass)
# ═══════════════════════════════════════════════════════════════════════════

def _detect_generic_placeholders(
    paragraphs: List[str],
    employee: Dict[str, Any],
) -> List[Tuple[str, str]]:
    """
    Second-pass: detect generic template placeholder text that was NOT caught by
    Groq/regex detection (because it doesn't contain real personal data) and map
    it to the employee's fields.

    Patterns handled:
    - "20xx" / "xxxx"             → current year
    - "Décrivez …" / "Describe …" → employee summary (if available)
    - "Ma compétence" / "My skill"→ first unused skill from employee.skills
    - "Nom entreprise"             → first experience company name
    - "Nom Prénom" alone           → full employee name (already in _PH_NAME but
                                     the generic second pass catches mis-cased variants)
    """
    pairs: List[Tuple[str, str]] = []
    seen_old: set = set()

    def _add(old_text: str, new_text: str) -> None:
        if old_text and old_text not in seen_old and old_text != new_text:
            pairs.append((old_text, new_text))
            seen_old.add(old_text)

    skills    = list(employee.get('skills') or [])
    skill_idx = 0                   # rotating pointer for skill-slot placeholders
    exps      = employee.get('experience') or []
    summary   = (employee.get('summary') or '').strip()
    for para in paragraphs:
        ps = para.strip()
        if not ps:
            continue

        # ── Date placeholder "20xx", "xxxx" ─────────────────────────
        if re.search(r'\b20xx\b|\bxxxx\b', ps, re.I):
            new_ps = re.sub(
                r'\b(?:janv?(?:ier)?|f[ée]vr?(?:ier)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|ao[uû]t|sept(?:embre)?|oct(?:obre)?|nov(?:embre)?|d[ée]c(?:embre)?|january|february|march|april|may|june|july|august|september|october|november|december)\.?\s+(?:20xx|xxxx)\s*[–—-]\s*(?:janv?(?:ier)?|f[ée]vr?(?:ier)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|ao[uû]t|sept(?:embre)?|oct(?:obre)?|nov(?:embre)?|d[ée]c(?:embre)?|january|february|march|april|may|june|july|august|september|october|november|december)\.?\s+(?:20xx|xxxx)\b',
                '',
                ps,
                flags=re.I,
            )
            new_ps = re.sub(r'\b(?:20xx|xxxx)\b', '', new_ps, flags=re.I)
            new_ps = re.sub(r'\s{2,}', ' ', new_ps).strip(' ,;:-–—')
            _add(ps, new_ps)
            continue

        # ── Summary placeholder: "Décrivez …", "Describe …" ─────────
        if re.match(r'^(?:D[eé]crivez|Describe|Write your|R[eé]digez)\b', ps, re.I):
            if summary:
                _add(ps, summary)
            continue

        # ── Skill-slot placeholder: "Ma compétence", "My skill" ─────
        if re.fullmatch(
            r'(?:•\s*)?(?:ma\s+comp[eé]tence|my\s+skill|skill\s+\d+)',
            ps, re.I,
        ):
            if skill_idx < len(skills):
                _add(ps, str(skills[skill_idx]))
                skill_idx += 1
            continue

        # ── Company name placeholder "Nom entreprise", "Company name" ─
        if re.fullmatch(
            r"(?:Nom\s+(?:de\s+l['\u2019])?entreprise|Company\s+name|Nom\s+soci[eé]t[eé])",
            ps, re.I,
        ):
            if exps:
                company = (exps[0].get('company') or exps[0].get('companyName', '')).strip()
                if company:
                    _add(ps, company)
            continue

        # ── Bullet + instruction placeholder ("• Décrivez votre rôle") ──
        if re.match(r'^[•●\-–]\s+(?:D[eé]crivez|Describe|Ajoutez|Add your)\b', ps, re.I):
            # Only remove/replace if employee has a summary to put there
            if summary:
                _add(ps, f'• {summary}')
            continue

    if pairs:
        logger.info(f"[generic_placeholders] Detected {len(pairs)} pairs: "
                    + ", ".join(f"'{o[:30]}'" for o, _ in pairs[:5]))
    return pairs


# ═══════════════════════════════════════════════════════════════════════════
#  Quality check
# ═══════════════════════════════════════════════════════════════════════════

_QC_PLACEHOLDER_PATTERNS: List[Tuple[str, str]] = [
    (r'\b20xx\b',                  '20xx date placeholder'),
    (r'\bxxxx\b',                  'xxxx placeholder'),
    (r'\bD[eé]crivez\b',           'Décrivez summary placeholder'),
    (r'\bma\s+comp[eé]tence\b',    'Ma compétence skill placeholder'),
    (r'\bmy\s+skill\b',            'My skill placeholder'),
    (r'\bnom\s+entreprise\b',      'Nom entreprise placeholder'),
    (r'\bnom\s+pr[eé]nom\b',       'Nom Prénom name placeholder'),
    (r'\{\{\s*full_name\s*\}\}',   '{{ full_name }} Jinja token not replaced'),
    (r'\{\{\s*current_position\s*\}\}', '{{ current_position }} Jinja token not replaced'),
    (r'\{\{\s*[\w.]+\s*\}\}',      'Unreplaced Jinja {{ }} token in output'),
    (r'\{%\s*(?:tr\s+)?for\b[^%]*?%\}', 'Unreplaced Jinja {% for %} tag in output'),
    (r'\{%\s*(?:tr\s+)?endfor\s*%\}',   'Unreplaced Jinja {% endfor %} tag in output'),
    (r'\{%\s*endtr\s*%\}',              'Unreplaced Jinja {% endtr %} tag in output'),
]


def _quality_check(docx_path: str, employee: Dict[str, Any]) -> List[str]:
    """
    Scan the generated DOCX for quality issues.  Issues are logged as warnings
    and also returned as a list of strings for the caller to inspect.

    Checks:
    1. Remaining generic placeholder text.
    2. TextBox cy values that are suspiciously small (< 100 000 EMUs).
    3. Required employee fields (name, email, phone) present in output.
    """
    issues: List[str] = []

    # ── Extract all text ──────────────────────────────────────────────
    all_parts: List[str] = []
    with zipfile.ZipFile(docx_path) as zf:
        for arc_name in zf.namelist():
            if not _VISIBLE_WORD_PART_RE.match(arc_name.replace('\\', '/')):
                continue
            with zf.open(arc_name) as fh:
                try:
                    tree = etree.parse(fh)
                except Exception:
                    continue
            for t in tree.iter(f'{{{NS_W}}}t', f'{{{NS_A}}}t'):
                all_parts.append(t.text or '')

    full_lower = ' '.join(all_parts).lower()

    # ── 1. Placeholder text still present ────────────────────────────
    for pattern, desc in _QC_PLACEHOLDER_PATTERNS:
        if re.search(pattern, full_lower, re.I):
            issues.append(f"Remaining placeholder: {desc}")
            logger.warning(f"[quality_check] {desc} still present in output")

    # ── 2. TextBox cy sanity ─────────────────────────────────────────
    with zipfile.ZipFile(docx_path) as zf:
        if 'word/document.xml' in zf.namelist():
            with zf.open('word/document.xml') as fh:
                doc_tree = etree.parse(fh)
            for txbx in doc_tree.iter(_WPS_TXBX):
                cy = _get_shape_cy(txbx)
                if 0 < cy < 100_000:
                    issues.append(f"TextBox cy too small: {cy} EMUs")
                    logger.warning(f"[quality_check] TextBox cy={cy} < 100 000 EMUs")

    # ── 3. Required fields present ───────────────────────────────────
    for field in ('name', 'email', 'phone'):
        value = (employee.get(field) or '').strip()
        if not value:
            continue
        # For TXBX-heavy templates, contact fields are split across paragraphs
        # with different spacing.  Use lax matching:
        #   name  → check first 15 chars (usually appears in TXBX as first name)
        #   email → check local part only (before @)
        #   phone → check digit-only version
        if field == 'email' and '@' in value:
            check = value.split('@')[0].lower().replace(' ', '')
        elif field == 'phone':
            check = re.sub(r'\D', '', value)[-4:]  # last 4 digits
        else:
            check = value.lower()[:15]
        if check and check.replace(' ', '') not in full_lower.replace(' ', ''):
            issues.append(f"Required field missing in output: {field} ({value[:30]})")
            logger.warning(f"[quality_check] {field} not found in generated output")

    # ── 4. Template residuals (Lucas template data not replaced) ────
    for text, desc in _LUCAS_RESIDUALS:
        if text.lower() in full_lower:
            issues.append(f"Template residual not replaced: {desc} ({text!r})")
            logger.warning(f"[quality_check] Residual still present: {text!r}")

    if not issues:
        logger.info("[quality_check] All checks passed")
    return issues


def _fix_contact_separators(docx_path: str) -> int:
    """
    Post-replacement pass: insert a <w:br/> soft line break between any two
    contact-field values that ended up concatenated inside the same <w:p>.

    In infographic (two-column) templates, the VML fallback layer often stores
    all contact fields in a single paragraph (or in paragraphs whose runs are
    reconstructed by _replace_in_paragraph).  After replacement, email and
    address may end up back-to-back with no visual separator.

    Detection: a <w:p> that contains runs whose concatenated text matches
    EMAIL_REGEX immediately followed by a non-whitespace char (start of address).

    Fix: insert <w:r><w:br/></w:r> between the email run and the address run.

    Returns count of paragraphs modified.
    """
    _EMAIL_RUN_RE = re.compile(
        r'[a-zA-Z0-9][a-zA-Z0-9._%+\-]*@[a-zA-Z0-9][\w\-]*(?:\.[a-zA-Z0-9][\w\-]*)*\.[a-zA-Z]{2,}'
    )
    W = NS_W
    fixed = 0
    temp_dir = tempfile.mkdtemp()
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)

        doc_xml_path = os.path.join(temp_dir, 'word', 'document.xml')
        with open(doc_xml_path, 'rb') as f:
            raw = f.read()
        tree = etree.fromstring(raw)
        changed = False

        for p_elem in tree.iter(f'{{{W}}}p'):
            t_elems = list(p_elem.iter(f'{{{W}}}t'))
            if not t_elems:
                continue
            joined = ''.join(t.text or '' for t in t_elems)

            # Check: does joined text contain email immediately followed by non-whitespace?
            m = _EMAIL_RUN_RE.search(joined)
            if not m:
                continue
            after_email = joined[m.end():]
            # Only fix if address follows immediately (no whitespace gap)
            if not after_email or after_email[0].isspace():
                continue
            # The email and address runs are concatenated — we need to split them.
            # Strategy: find the <w:t> element that contains the boundary.
            # We'll rebuild the runs: email goes into a run, <w:br/> inserted, address follows.
            email_end_pos = m.end()
            pos = 0
            email_last_t: Any = None
            split_offset = -1
            for t in t_elems:
                txt = t.text or ''
                start = pos
                end = pos + len(txt)
                # Does this run span the email/address boundary?
                if start < email_end_pos <= end:
                    email_last_t = t
                    split_offset = email_end_pos - start
                    break
                pos = end

            if email_last_t is None:
                continue

            # Get the <w:r> run containing the boundary <w:t>
            boundary_run = email_last_t.getparent()
            if boundary_run is None or boundary_run.tag != f'{{{W}}}r':
                continue

            orig_text = email_last_t.text or ''
            email_part = orig_text[:split_offset]
            addr_part  = orig_text[split_offset:]

            if not addr_part:
                # Address starts in the NEXT run(s) — just insert <w:br/> after boundary_run
                br_run = etree.Element(f'{{{W}}}r')
                etree.SubElement(br_run, f'{{{W}}}br')
                boundary_run.addnext(br_run)
            else:
                # Split the boundary run: keep email_part in this run,
                # create a new <w:br/> run, then create an address run
                email_last_t.text = email_part
                if email_part and email_part != email_part.strip():
                    email_last_t.set(_XML_SPACE, 'preserve')

                br_run = etree.Element(f'{{{W}}}r')
                etree.SubElement(br_run, f'{{{W}}}br')

                addr_run = copy.deepcopy(boundary_run)
                addr_t = addr_run.find(f'{{{W}}}t')
                if addr_t is not None:
                    addr_t.text = addr_part
                    if addr_part != addr_part.strip():
                        addr_t.set(_XML_SPACE, 'preserve')

                boundary_run.addnext(addr_run)
                boundary_run.addnext(br_run)

            fixed += 1
            changed = True
            logger.info(f"[fix_contact_separators] Inserted <w:br/> between email and address")

        if changed:
            with open(doc_xml_path, 'wb') as f:
                f.write(etree.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True))
            with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for root_dir, _dirs, files in os.walk(temp_dir):
                    for fname in files:
                        fpath = os.path.join(root_dir, fname)
                        zout.write(fpath, os.path.relpath(fpath, temp_dir))
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return fixed


def _fill_labeled_contact_placeholders(docx_path: str, employee: Dict[str, Any]) -> int:
    """Fill dotted contact placeholders in label-prefixed paragraphs."""
    phone = str(employee.get("phone") or "").strip()
    email = str(employee.get("email") or "").strip()
    linkedin = str(employee.get("linkedin") or "").strip()
    address = str(employee.get("address") or "").strip()
    if not any((phone, email, linkedin, address)):
        return 0

    try:
        doc = Document(docx_path)
    except Exception:
        return 0

    fixed = 0
    dot_re = re.compile(r"[.…•·_]{4,}")
    fill_rules: List[Tuple[re.Pattern[str], str]] = []
    if phone:
        fill_rules.append((re.compile(r"^\s*(?:t[ée]l(?:[ée]phone)?|tel|phone|mobile)\s*[:\-]\s*", re.I), phone))
    if email:
        fill_rules.append((re.compile(r"^\s*(?:e-?mail|courriel|email)\s*[:\-]\s*", re.I), email))
    if linkedin:
        fill_rules.append((re.compile(r"^\s*(?:linkedin)\s*[:\-]?\s*", re.I), linkedin))
    if address:
        fill_rules.append((re.compile(r"^\s*(?:adresse|address|location)\s*[:\-]\s*", re.I), address))

    for para in doc.paragraphs:
        text = para.text or ""
        if not text.strip():
            continue
        for pattern, value in fill_rules:
            m = pattern.match(text)
            if not m:
                continue
            if value in text:
                break
            rhs = text[m.end():]
            # Replace both dotted placeholders and stale hardcoded template values.
            if not rhs.strip():
                para.text = f"{text[:m.end()]}{value}"
                fixed += 1
                break
            if dot_re.search(rhs) or rhs.strip() != value:
                para.text = f"{text[:m.end()]}{value}"
                fixed += 1
                break
            break

    if fixed:
        doc.save(docx_path)
    return fixed


def _fill_top_dotted_identity_placeholders(docx_path: str, employee: Dict[str, Any]) -> int:
    """Fill top-of-document unlabeled dotted placeholders with identity fields.

    Heuristic:
    - Only inspect the first 20 body paragraphs.
    - Only paragraphs made mostly of dots/placeholder glyphs.
    - Fill in order: name, title, linkedin (when available).
    """
    name = str(employee.get("name") or "").strip()
    title = str(employee.get("title") or employee.get("currentPosition") or "").strip()
    linkedin = str(employee.get("linkedin") or "").strip()
    values = [v for v in (name, title, linkedin) if v]
    if not values:
        return 0

    try:
        doc = Document(docx_path)
    except Exception:
        return 0

    dot_line_re = re.compile(r"^[\s.…•·_]{4,}$")
    changed = 0
    vi = 0
    max_scan = min(20, len(doc.paragraphs))
    for i in range(max_scan):
        if vi >= len(values):
            break
        p = doc.paragraphs[i]
        txt = (p.text or "").strip()
        if not txt:
            continue
        if dot_line_re.match(txt):
            p.text = values[vi]
            vi += 1
            changed += 1

    if changed:
        doc.save(docx_path)
    return changed


def _cleanup_placeholder_noise(docx_path: str) -> int:
    """Remove residual dotted/N-A placeholder artifacts in paragraphs and tables."""
    try:
        doc = Document(docx_path)
    except Exception:
        return 0

    changed = 0
    dot_re = re.compile(r"[.…•·_]{4,}")
    na_re = re.compile(r"^\s*(?:N/?A|NA|n/?a)\s*$", re.I)

    for para in doc.paragraphs:
        text = para.text or ""
        stripped = text.strip()
        if not stripped:
            continue
        if na_re.match(stripped):
            para.text = ""
            changed += 1
            continue
        cleaned = dot_re.sub("", text).strip()
        if cleaned != stripped and (not cleaned or len(cleaned) < len(stripped)):
            para.text = cleaned
            changed += 1

    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                ctext = cell.text or ""
                stripped = ctext.strip()
                if not stripped:
                    continue
                if na_re.match(stripped):
                    cell.text = ""
                    changed += 1
                    continue
                cleaned = dot_re.sub("", ctext).strip()
                if cleaned != stripped and (not cleaned or len(cleaned) < len(stripped)):
                    cell.text = cleaned
                    changed += 1

    if changed:
        doc.save(docx_path)
    return changed


# Template-specific residual strings that indicate the output still contains
# Lucas Leblanc template data (used for logging only, does not abort).
_LUCAS_RESIDUALS: List[Tuple[str, str]] = [
    ('555-555-5555',         'phone template'),
    ('@courriel.ca',         'email domain template'),
    ('lucas.leblanc',        'email local template'),
    ('DESJARDINS',           'company template (Desjardins)'),
    ('SOBEYS',               'company template (Sobeys)'),
    ('CHU DE MONTRÉAL',      'company template (CHU)'),
    ('La Sorbonne',          'education template (Sorbonne)'),
    ('Lycée Blaise Pascal',  'education template (Pascal)'),
    ('lucas-leblanc',        'linkedin slug template'),
    ('Montréal, Canada',     'address template'),
]


def _check_replacement_completeness(
    docx_path: str,
    combined_pairs: List[Tuple[str, str]],
) -> None:
    """Log warnings for any replacement pair whose 'old' value is still present
    in the output document after all replacement phases.

    Also scans for known Lucas Leblanc template residuals that should have been
    cleared by the replacement process.

    This function is informational only — it does not modify the document.
    """
    try:
        paragraphs: List[str] = []
        with zipfile.ZipFile(docx_path) as zf:
            for arc_name in zf.namelist():
                if not _VISIBLE_WORD_PART_RE.match(arc_name.replace('\\', '/')):
                    continue
                with zf.open(arc_name) as fh:
                    try:
                        xml_bytes = fh.read()
                    except Exception:
                        continue
                paragraphs.extend(_get_paragraph_texts(xml_bytes))
        combined_text = '\n'.join(paragraphs)
    except Exception as exc:
        logger.warning(f"[completeness] Could not extract text: {exc}")
        return

    # ── 1. Replacement-pair residuals ─────────────────────────────────
    missed = 0
    for old, new in combined_pairs:
        if not old or old == new:
            continue
        if old in combined_text:
            for i, p in enumerate(paragraphs):
                if old in p:
                    logger.warning(
                        f"[completeness] Unreplaced pair: '{old[:50]}' still at para {i}: {p[:80]!r}"
                    )
                    missed += 1
                    break
    if missed:
        logger.warning(f"[completeness] {missed} replacement pair(s) were not applied")

    # ── 2. Lucas-template residual scan ───────────────────────────────
    for text, desc in _LUCAS_RESIDUALS:
        if text in combined_text:
            for i, p in enumerate(paragraphs):
                if text in p:
                    logger.warning(
                        f"[completeness] Lucas residual [{desc}]: '{text}' at para {i}: {p[:80]!r}"
                    )
                    break


def _cleanup_unrendered_jinja_tags(docx_path: str) -> int:
    """
    Remove raw Jinja/docxtpl syntax left in the DOCX when running AI-only mode.

    Clears control tags like ``{% tr for ... %}``, ``{% endfor %}``, ``{% endtr %}``
    and variable tags like ``{{ exp.description }}`` across all ``word/*.xml`` parts.

    Returns the number of paragraphs that were modified.
    """
    W = NS_W
    A = NS_A
    WP = f'{{{W}}}p'
    WT = f'{{{W}}}t'
    AP = f'{{{A}}}p'
    AT = f'{{{A}}}t'
    XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space'

    # Control-flow tags ({% ... %}) and variable tags ({{ ... }})
    block_re = re.compile(r'\{%\s*[^%]*?%\}', re.IGNORECASE)
    var_re = re.compile(r'\{\{\s*[^{}]+\s*\}\}')

    temp_dir = tempfile.mkdtemp()
    changed_count = 0
    any_changed = False

    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)

        word_dir = os.path.join(temp_dir, 'word')
        if not os.path.isdir(word_dir):
            return 0

        for xml_root, _dirs, xml_files in os.walk(word_dir):
            for xml_name in xml_files:
                if not xml_name.endswith('.xml'):
                    continue
                xml_path = os.path.join(xml_root, xml_name)
                with open(xml_path, 'rb') as f:
                    raw = f.read()
                try:
                    tree = etree.fromstring(raw)
                except etree.XMLSyntaxError:
                    continue

                file_changed = False

                def _clean_para(para_el: Any, t_tag: str) -> int:
                    nonlocal file_changed
                    t_elems = list(para_el.iter(t_tag))
                    if not t_elems:
                        return 0
                    joined = ''.join(t.text or '' for t in t_elems)
                    if not joined:
                        return 0
                    has_jinja = ('{{' in joined and '}}' in joined) or ('{%' in joined and '%}' in joined)
                    if not has_jinja:
                        return 0
                    cleaned = block_re.sub('', joined)
                    cleaned = var_re.sub('', cleaned)
                    # Normalize obvious spacing artifacts after tag removal
                    cleaned = re.sub(r'[ \t]{2,}', ' ', cleaned)
                    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
                    if cleaned == joined:
                        return 0
                    cleaned = _xml_safe_text(cleaned)
                    t_elems[0].text = cleaned
                    if cleaned.startswith(' ') or cleaned.endswith(' '):
                        t_elems[0].set(XML_SPACE, 'preserve')
                    else:
                        t_elems[0].set(XML_SPACE, 'preserve')
                    for te in t_elems[1:]:
                        te.text = ''
                    file_changed = True
                    return 1

                file_mods = 0
                for para in tree.iter(WP):
                    file_mods += _clean_para(para, WT)
                for para in tree.iter(AP):
                    file_mods += _clean_para(para, AT)

                if file_changed:
                    changed_count += file_mods
                    any_changed = True
                    with open(xml_path, 'wb') as f:
                        f.write(etree.tostring(
                            tree, xml_declaration=True, encoding='UTF-8', standalone=True
                        ))

        if any_changed:
            with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for root_dir, _dirs, files in os.walk(temp_dir):
                    for fname in files:
                        fpath = os.path.join(root_dir, fname)
                        zout.write(fpath, os.path.relpath(fpath, temp_dir))
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    if changed_count:
        logger.info(f"[jinja_cleanup] Cleared unrendered Jinja syntax in {changed_count} paragraph(s)")
    return changed_count


def _para_visible_text(p_elem: Any) -> str:
    """Plain visible text in *p_elem*, ignoring text inside nested textboxes.

    Body-level paragraphs that *contain* a textbox shape may also carry
    surrounding plain runs; only those plain runs count as "this paragraph's
    own text". Text inside `<w:txbxContent>` belongs to a child shape that we
    inspect separately.
    """
    W = NS_W
    WT = f'{{{W}}}t'
    W_TXBX = f'{{{W}}}txbxContent'
    out: List[str] = []
    for t in p_elem.iter(WT):
        if not t.text:
            continue
        anc = t.getparent()
        in_txbx = False
        while anc is not None and anc is not p_elem:
            if anc.tag == W_TXBX:
                in_txbx = True
                break
            anc = anc.getparent()
        if not in_txbx:
            out.append(t.text)
    return ''.join(out).strip()


def _prune_empty_sections(docx_path: str) -> int:
    """Remove section headings whose body content has been emptied.

    Runs after every replacement and cleanup pass. For each container
    (``<w:body>``, every ``<w:tc>`` cell, every ``<w:txbxContent>`` shape),
    walks the direct ``<w:p>`` children, identifies section headings via
    ``_identify_section_lxml``, and inspects the paragraphs/tables that
    follow each heading up to the next heading. When that range carries no
    visible text (only blanks / drawings / Jinja remnants already cleared),
    the heading **and** its body range are deleted so the layout collapses
    cleanly with no orphan title.

    Preserved as-is:
      * Heading paragraphs that wrap a ``wps:txbx`` shape — those are layout
        anchors and ``_identify_section_lxml`` already filters them out.
      * Pure-drawing / pure-picture paragraphs (decoration borders, column
        separators).
      * Textbox-container paragraphs inside a body range (they hold sidebar
        chrome that must survive the wipe).
      * One empty ``<w:p>`` in any ``<w:tc>`` / ``<w:txbxContent>`` that
        would otherwise become structurally empty (OOXML invariant).
    """
    W = NS_W
    WP = f'{{{W}}}p'
    WTBL = f'{{{W}}}tbl'
    WTC = f'{{{W}}}tc'
    W_TXBX_CONTENT = f'{{{W}}}txbxContent'
    pruned = 0

    temp_dir = tempfile.mkdtemp(prefix='cv_prune_')
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)

        doc_xml_path = os.path.join(temp_dir, 'word', 'document.xml')
        if not os.path.isfile(doc_xml_path):
            return 0

        with open(doc_xml_path, 'rb') as f:
            raw = f.read()
        try:
            tree = etree.fromstring(raw)
        except etree.XMLSyntaxError as exc:
            logger.warning(f"[prune_empty_sections] Cannot parse document.xml: {exc}")
            return 0

        # Build the list of containers to walk. Body first (so removals there
        # don't affect later cell/textbox traversal — we re-iterate live each time).
        body = tree.find(f'{{{W}}}body')
        containers: List[Tuple[str, Any, bool]] = []
        if body is not None:
            containers.append(('body', body, False))
        for tc in tree.iter(WTC):
            containers.append(('tc', tc, True))
        for txbx in tree.iter(W_TXBX_CONTENT):
            containers.append(('txbx', txbx, True))

        for kind, container, must_keep_para in containers:
            children = list(container)
            heading_info: List[Tuple[int, str, Any]] = []
            for c_idx, child in enumerate(children):
                if child.tag != WP:
                    continue
                sec = _identify_section_lxml(child)
                if sec:
                    heading_info.append((c_idx, sec, child))

            if not heading_info:
                continue

            to_remove: List[Any] = []
            for h_pos, (c_idx, sec, h_elem) in enumerate(heading_info):
                next_idx = (
                    heading_info[h_pos + 1][0]
                    if h_pos + 1 < len(heading_info)
                    else len(children)
                )
                body_range = children[c_idx + 1: next_idx]

                has_content = False
                for elem in body_range:
                    if elem.tag == WP:
                        # Pure-drawing paragraphs are decoration, not content
                        if _para_is_drawing_only(elem):
                            continue
                        # Textbox-container paragraphs hold child shapes whose
                        # text is checked separately when we walk txbxContent
                        # nodes, so don't count their inherited text here.
                        if _para_is_textbox(elem):
                            continue
                        if _para_visible_text(elem):
                            has_content = True
                            break
                    elif elem.tag == WTBL:
                        tbl_text = ''.join(
                            t.text or '' for t in elem.iter(f'{{{W}}}t')
                        ).strip()
                        if tbl_text:
                            has_content = True
                            break

                if has_content:
                    continue

                # Empty section — remove the heading and any plain paragraphs in
                # its body range. Pure-drawing / textbox-container paragraphs
                # are layout chrome and stay untouched so the page geometry
                # doesn't shift around the now-gone section.
                to_remove.append(h_elem)
                for elem in body_range:
                    if elem.tag == WP and (
                        _para_is_drawing_only(elem) or _para_is_textbox(elem)
                    ):
                        continue
                    to_remove.append(elem)
                pruned += 1
                logger.info(
                    f"[prune_empty_sections] {kind}: pruned empty section '{sec}' "
                    f"(heading + {len(body_range)} body element(s))"
                )

            for elem in to_remove:
                try:
                    container.remove(elem)
                except ValueError:
                    pass

            # OOXML requires <w:tc> and <w:txbxContent> to contain at least one
            # <w:p> or <w:tbl>. If we just emptied them, drop in a placeholder
            # paragraph so Word still opens the file cleanly.
            if must_keep_para:
                live_children = list(container)
                if not any(c.tag in (WP, WTBL) for c in live_children):
                    placeholder = etree.SubElement(container, WP)
                    logger.debug(
                        f"[prune_empty_sections] {kind}: inserted placeholder "
                        f"<w:p> for OOXML validity"
                    )
                    # Avoid unused-var lint; placeholder lives in the tree now.
                    _ = placeholder

        if pruned:
            with open(doc_xml_path, 'wb') as f:
                f.write(etree.tostring(
                    tree, xml_declaration=True, encoding='UTF-8', standalone=True,
                ))
            with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for root_dir, _dirs, files in os.walk(temp_dir):
                    for fname in files:
                        fpath = os.path.join(root_dir, fname)
                        zout.write(fpath, os.path.relpath(fpath, temp_dir))
            logger.info(f"[prune_empty_sections] Pruned {pruned} empty section(s)")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return pruned


def _remove_orphan_paragraphs(docx_path: str) -> int:
    """
    Remove body-level <w:p> elements that are completely empty (no text, no runs
    beyond <w:pPr>) AND were likely left orphaned by the replacement pipeline
    (e.g. a LinkedIn URL paragraph cleared to \"\").

    Heuristic for \"safe to remove\":
    - The paragraph has ONLY a <w:pPr> child (or no children at all).
    - It is NOT immediately adjacent to a textbox-container paragraph.
    - Its paragraph-spacing is zero or near-zero (not an intentional spacer).

    Returns count of paragraphs removed.
    """
    W = NS_W
    removed = 0
    temp_dir = tempfile.mkdtemp()
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)

        doc_xml_path = os.path.join(temp_dir, 'word', 'document.xml')
        with open(doc_xml_path, 'rb') as f:
            raw = f.read()
        tree = etree.fromstring(raw)
        body = tree.find(f'{{{W}}}body')
        if body is None:
            return 0

        changed = False
        to_remove = []
        children = list(body)
        for idx, child in enumerate(children):
            if child.tag != f'{{{W}}}p':
                continue
            # Skip textbox-container paragraphs (layout elements)
            if _para_is_textbox(child) or _para_is_drawing_only(child):
                continue

            # Check if paragraph has any meaningful content (text, runs, drawings)
            has_text = bool(list(child.iter(f'{{{W}}}t')))
            has_runs = bool(child.findall(f'{{{W}}}r'))
            has_draw = bool(child.findall(f'.//{{{W}}}drawing'))
            if has_text or has_runs or has_draw:
                continue

            # Only keep: children = [pPr] or no children (pure empty paragraph)
            child_tags = [c.tag for c in child]
            meaningful_children = [t for t in child_tags
                                   if t not in (f'{{{W}}}pPr', f'{{{W}}}bookmarkStart',
                                                f'{{{W}}}bookmarkEnd')]
            if meaningful_children:
                continue

            # Don't remove if adjacent paragraph is a textbox that uses this for spacing
            prev_has_txbx = (idx > 0 and _para_is_textbox(children[idx - 1]))
            next_has_txbx = (idx + 1 < len(children) and _para_is_textbox(children[idx + 1]))
            if prev_has_txbx or next_has_txbx:
                continue

            to_remove.append(child)

        for p in to_remove:
            try:
                body.remove(p)
                removed += 1
                changed = True
            except ValueError:
                pass

        if changed:
            with open(doc_xml_path, 'wb') as f:
                f.write(etree.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True))
            with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for root_dir, _dirs, files in os.walk(temp_dir):
                    for fname in files:
                        fpath = os.path.join(root_dir, fname)
                        zout.write(fpath, os.path.relpath(fpath, temp_dir))

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    if removed:
        logger.info(f"[remove_orphan_paragraphs] Removed {removed} empty orphan paragraph(s)")
    return removed


def _generate_with_replacement(
    template_path: str,
    employee: Dict[str, Any],
    output_path: str,
    gen_ctx: Optional[GenerationContext] = None,
    template_strategy: Optional[Dict[str, Any]] = None,
    preferred_language: Optional[str] = None,
) -> str:
    """Replacement pipeline — single pass with full mapping.

    Phases:
    1. Extract template text + structural data (experience/education/summary paras).
    2. Contact-field detection (regex, always runs).
    3. Pre-generate summary (Groq with deterministic fallback).
    4. Build FULL replacement map: contact + experience + education + summary.
    5. Supplement with Groq AI pairs (fills gaps the structured map missed).
    6. Apply ALL replacements in ONE pass on document.xml only.
    7. Resize textboxes to prevent content overflow.
    8. Quality + completeness checks.
    """
    shutil.copy2(template_path, output_path)

    if gen_ctx is None:
        gen_ctx = GenerationContext()

    # Phase 0: Dissolve SDT content controls in the output copy.
    # Word templates often wrap editable areas in <w:sdt> elements which
    # bury the actual <w:p>/<w:r> content inside <w:sdtContent> wrappers.
    # Dissolving them early makes all downstream phases (extraction,
    # section replacement, paragraph replacement) work transparently on
    # the underlying content.  The original template is not modified.
    with gen_ctx.phase("sdt_dissolution") as p:
        try:
            sdt_count = _dissolve_sdts_in_docx(output_path)
            p.details["sdts_dissolved"] = sdt_count
            p.message = f"{sdt_count} SDTs dissolved"
            if sdt_count:
                logger.info(f"Dissolved {sdt_count} SDT content controls")
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"SDT dissolution failed (non-fatal): {exc}")

    strategy = template_strategy or _plan_template_execution(output_path)
    with gen_ctx.phase("strategy_selection") as p:
        p.details["strategy"] = strategy.get("strategy")
        p.details["body_section_headings"] = strategy.get("body_section_headings")
        p.details["textbox_section_headings"] = strategy.get("textbox_section_headings")
        p.details["layout_table_detected"] = strategy.get("layout_table_detected")
        p.details["positioned_textboxes"] = strategy.get("positioned_textboxes")
        p.message = str(strategy.get("strategy") or "direct_text_replacement_only")
        logger.info(
            "Using template execution strategy: %s",
            strategy.get("strategy") or "direct_text_replacement_only",
        )

    # Phase 1: Extract template text
    # NOTE: extraction now uses output_path (SDTs dissolved) instead of
    # template_path so that text is cleanly retrieved from layout-table
    # cells and other SDT-heavy structures.
    with gen_ctx.phase("text_extraction") as p:
        full_text, paragraphs = _extract_all_text(output_path)
        p.details["paragraphs"] = len(paragraphs)
        p.details["chars"] = len(full_text)
        p.message = f"{len(paragraphs)} paragraphs, {len(full_text)} chars"
        if not paragraphs:
            gen_ctx.warn("Template appears to contain no text — output may be empty")
    logger.info(f"Template: {len(paragraphs)} paragraphs, {len(full_text)} chars")

    # Phase 2: Contact-field detection (regex, deterministic)
    with gen_ctx.phase("contact_detection") as p:
        detected = _detect_personal_info(full_text, paragraphs)
        p.details["detected_fields"] = list(detected.keys())
        p.message = f"Detected {len(detected)} fields"

    # Phase 2b: Structural data extraction (needs detected fields for
    #           experience company detection via title matching)
    with gen_ctx.phase("structural_extraction") as p:
        try:
            template_data = _extract_template_structured_data(output_path, detected)
            p.details["experience_entries"] = len(template_data.get('experience', []))
            p.details["education_entries"] = len(template_data.get('education', []))
            p.message = (
                f"exp={len(template_data.get('experience', []))}, "
                f"edu={len(template_data.get('education', []))}"
            )
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"Structural extraction failed (non-fatal): {exc}")
            template_data = {'experience': [], 'education': [], 'summary': []}

    # Phase 3: Pre-generate summary so it is available for the replacement map.
    if not employee.get('summary'):
        with gen_ctx.phase("summary_generation") as p:
            try:
                api_key = settings.GROQ_API_KEY
                if not api_key:
                    p.status = "skipped"
                    p.message = "GROQ_API_KEY not set — using deterministic fallback"
                    logger.info("[gen] GROQ_API_KEY not set — summary will use fallback")
                    summary = None
                else:
                    summary = _groq_generate_summary(employee, api_key, preferred_language)
                if summary:
                    employee = dict(employee)
                    employee['summary'] = summary
                    p.message = f"Generated ({len(summary)} chars)"
                    logger.info("[gen] Summary pre-generated (Groq or fallback)")
                else:
                    p.status = "skipped"
                    p.message = "No API key or generation returned empty"
            except Exception as exc:
                p.status = "failed"
                p.error = str(exc)
                logger.warning(f"Summary generation failed (non-fatal): {exc}")
    else:
        gen_ctx.skip_phase("summary_generation", "Employee already has a summary")

    # Phase 4: Build full replacement map
    apilayer_pairs: List[Tuple[str, str]] = []
    with gen_ctx.phase("apilayer_template_mapping") as p:
        try:
            if not settings.APILAYER_API_KEY:
                p.status = "skipped"
                p.message = "APILAYER_API_KEY not set"
            else:
                apilayer_pairs = _build_apilayer_template_pairs(output_path, employee)
                p.details["pair_count"] = len(apilayer_pairs)
                p.message = f"{len(apilayer_pairs)} APILayer pair(s)"
                if apilayer_pairs:
                    logger.info("APILayer template mapping contributed %d pair(s)", len(apilayer_pairs))
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"APILayer template mapping failed (non-fatal): {exc}")

    with gen_ctx.phase("build_replacement_map") as p:
        combined_pairs = _build_full_replacement_map(detected, template_data, employee)
        if combined_pairs is None:
            gen_ctx.warn("Replacement map builder returned None; falling back to an empty list")
            combined_pairs = []
        if apilayer_pairs:
            existing_olds = {old for old, _ in combined_pairs}
            combined_pairs = list(combined_pairs) + [
                (old, new) for old, new in apilayer_pairs if old not in existing_olds
            ]
        jinja_scalar_pairs = _build_jinja_scalar_placeholder_pairs(paragraphs, employee)
        if jinja_scalar_pairs:
            existing_olds = {old for old, _ in combined_pairs}
            combined_pairs = list(combined_pairs) + [
                (old, new) for old, new in jinja_scalar_pairs if old not in existing_olds
            ]
        generic_pairs = _detect_generic_placeholders(paragraphs, employee)
        if generic_pairs:
            existing_olds = {old for old, _ in combined_pairs}
            combined_pairs = list(combined_pairs) + [
                (old, new) for old, new in generic_pairs if old not in existing_olds
            ]
        # Sanitise all replacement values for XML safety
        combined_pairs = [
            (old, _xml_safe_text(str(new)) if new is not None else '')
            for old, new in combined_pairs
        ]
        combined_pairs.sort(key=lambda x: len(x[0]), reverse=True)
        gen_ctx.replacements_attempted = len(combined_pairs)
        p.details["pair_count"] = len(combined_pairs)
        if gen_ctx.debug:
            p.details["pairs_preview"] = [
                {"old": o[:60], "new": n[:60]} for o, n in combined_pairs[:20]
            ]
        p.message = f"{len(combined_pairs)} replacement pairs"

    # Phase 5: Groq AI pairs — supplement (fills any gap the structured map missed)
    with gen_ctx.phase("ai_supplement") as p:
        try:
            ai_pairs, sections_to_clear = _ai_get_replacements(
                full_text,
                employee,
                paragraphs,
                preferred_language=preferred_language,
            )
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"AI pair generation failed (non-fatal): {exc}")
            ai_pairs, sections_to_clear = [], []
        if ai_pairs:
            existing_olds = {old for old, _ in combined_pairs}
            new_from_ai = [
                (old, _xml_safe_text(str(new)) if new is not None else '')
                for old, new in ai_pairs if old not in existing_olds
            ]
            if new_from_ai:
                combined_pairs = list(combined_pairs) + new_from_ai
                combined_pairs.sort(key=lambda x: len(x[0]), reverse=True)
                gen_ctx.replacements_attempted = len(combined_pairs)
                p.message = f"AI contributed {len(new_from_ai)} additional pair(s)"
                logger.info(f"AI contributed {len(new_from_ai)} additional pair(s)")
            else:
                p.message = "AI pairs all duplicates of existing"
        else:
            p.message = "No AI pairs generated"

    # Phase 6: Replace CV section content FIRST — section headings must be
    #           detected while their text is still intact (before text replacement
    #           can blank them via the structured-data replacement map).
    sections_replaced = 0
    if strategy.get("run_body_section_replacement", True):
        with gen_ctx.phase("section_replacement") as p:
            try:
                sections_replaced = _replace_cv_sections(
                    output_path,
                    employee,
                    preferred_language=preferred_language,
                )
                p.details["sections_replaced"] = sections_replaced
                p.message = f"{sections_replaced} sections replaced"
                if sections_replaced:
                    logger.info(f"CV sections replaced: {sections_replaced}")
            except Exception as exc:
                p.status = "failed"
                p.error = str(exc)
                logger.warning(f"Section replacement failed (non-fatal): {exc}")
    else:
        gen_ctx.skip_phase(
            "section_replacement",
            f"Strategy {strategy.get('strategy')} skips body-section replacement",
        )

    # Phase 6b: Replace sections inside textbox shapes
    txbx_extra_pairs: List[Tuple[str, str]] = []
    if strategy.get("run_textbox_section_replacement", True):
        with gen_ctx.phase("textbox_section_replacement") as p:
            try:
                txbx_replaced, txbx_extra_pairs = _replace_cv_sections_in_textboxes(
                    output_path, employee,
                    body_sections_replaced=sections_replaced,
                    preferred_language=preferred_language,
                )
                p.details["txbx_replaced"] = txbx_replaced
                p.message = f"{txbx_replaced} textbox sections replaced"
                if txbx_replaced:
                    logger.info(f"Textbox sections replaced: {txbx_replaced}")
            except Exception as exc:
                p.status = "failed"
                p.error = str(exc)
                logger.warning(f"Textbox section replacement failed (non-fatal): {exc}")
    else:
        gen_ctx.skip_phase(
            "textbox_section_replacement",
            f"Strategy {strategy.get('strategy')} skips textbox-section replacement",
        )

    # Phase 6c: Clear sections with no employee data (AI-identified)
    if sections_to_clear:
        with gen_ctx.phase("section_clearing") as p:
            try:
                cleared = _clear_template_sections(output_path, sections_to_clear)
                p.details["cleared"] = cleared
                p.message = f"{cleared} sections cleared"
                if cleared:
                    logger.info(f"Sections cleared: {cleared}")
            except Exception as exc:
                p.status = "failed"
                p.error = str(exc)
                logger.warning(f"Section clearing failed (non-fatal): {exc}")
    else:
        gen_ctx.skip_phase("section_clearing", "No sections to clear")

    # Phase 6d: Apply text replacements AFTER sections have been replaced.
    # Include extra pairs from textbox section replacement (for header/footer
    # copies of section content like summary text).
    with gen_ctx.phase("apply_replacements") as p:
        if txbx_extra_pairs:
            existing_olds = {old for old, _ in combined_pairs}
            for old_t, new_t in txbx_extra_pairs:
                if old_t and new_t and old_t not in existing_olds:
                    combined_pairs.append((old_t, _xml_safe_text(str(new_t))))
                    existing_olds.add(old_t)
            combined_pairs.sort(key=lambda x: len(x[0]), reverse=True)
        count = _apply_paragraph_replacements(output_path, combined_pairs)
        gen_ctx.replacements_applied = count
        p.details["paragraphs_modified"] = count
        p.message = f"{count} paragraph(s) modified"
        logger.info(f"Replacements applied: {count} paragraph(s) modified")

    # Phase 6e: AI-only hardening — remove any raw Jinja/docxtpl syntax that
    # could remain visible when templates were originally authored for docxtpl.
    with gen_ctx.phase("jinja_cleanup") as p:
        try:
            cleaned = _cleanup_unrendered_jinja_tags(output_path)
            p.details["paragraphs_cleaned"] = cleaned
            p.message = f"{cleaned} paragraph(s) cleaned"
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"Jinja cleanup failed (non-fatal): {exc}")

    # Phase 6f: deterministic cleanup for visible residual placeholders.
    with gen_ctx.phase("final_cleanup") as p:
        try:
            _final_quality_control_cleanup(output_path)
            p.message = "Visible placeholder cleanup applied"
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"Final cleanup failed (non-fatal): {exc}")

    # Phase 6f2: Prune sections whose body has been emptied so we never leave
    # an orphan heading behind. Runs after every replacement / cleanup pass
    # has had a chance to write its data, so the only sections still empty
    # at this point are the ones that genuinely have no employee data.
    with gen_ctx.phase("empty_section_prune") as p:
        try:
            pruned_sections = _prune_empty_sections(output_path)
            p.details["sections_pruned"] = pruned_sections
            p.message = f"{pruned_sections} empty section(s) pruned"
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"Empty section prune failed (non-fatal): {exc}")

    # Phase 6g: Remove empty orphan paragraphs created by cleanup/replacement.
    with gen_ctx.phase("orphan_cleanup") as p:
        try:
            removed = _remove_orphan_paragraphs(output_path)
            p.details["removed"] = removed
            p.message = f"{removed} orphan paragraph(s) removed"
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"Orphan cleanup failed (non-fatal): {exc}")

    # Phase 6h: Repair contact line separators when email/address got concatenated.
    with gen_ctx.phase("contact_placeholder_fill") as p:
        try:
            filled = _fill_labeled_contact_placeholders(output_path, employee)
            top_filled = _fill_top_dotted_identity_placeholders(output_path, employee)
            p.details["filled"] = filled
            p.details["top_identity_filled"] = top_filled
            p.message = f"{filled + top_filled} contact/identity placeholder(s) filled"
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"Contact placeholder fill failed (non-fatal): {exc}")

    with gen_ctx.phase("contact_separator_fix") as p:
        try:
            fixed = _fix_contact_separators(output_path)
            p.details["fixed"] = fixed
            p.message = f"{fixed} contact paragraph(s) fixed"
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"Contact separator fix failed (non-fatal): {exc}")

    with gen_ctx.phase("placeholder_noise_cleanup") as p:
        try:
            cleaned = _cleanup_placeholder_noise(output_path)
            p.details["cleaned"] = cleaned
            p.message = f"{cleaned} placeholder artifact(s) cleaned"
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"Placeholder noise cleanup failed (non-fatal): {exc}")

    # Snapshot textbox positions BEFORE resize for the reflow phase.
    # This lets reflow distinguish resize-caused overlap from intentional overlap.
    pre_resize_positions = _snapshot_textbox_positions(output_path)

    # Phase 7: Resize textboxes (prevents content overflow)
    with gen_ctx.phase("textbox_resize") as p:
        try:
            count_resized = _resize_textboxes(output_path)
            p.details["resized"] = count_resized
            p.message = f"{count_resized} textboxes resized"
            if count_resized:
                logger.info(f"Textboxes resized: {count_resized}")
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"Textbox resize failed (non-fatal): {exc}")

    # Phase 7b: Reflow textbox vertical positions (prevents overlap)
    with gen_ctx.phase("textbox_reflow") as p:
        try:
            count_reflowed = _reflow_contact_textboxes(output_path, pre_resize_positions)
            p.details["reflowed"] = count_reflowed
            p.message = f"{count_reflowed} textboxes reflowed"
            if count_reflowed:
                logger.info(f"Textboxes reflowed: {count_reflowed}")
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"Textbox reflow failed (non-fatal): {exc}")

    # Phase 8: Quality + completeness checks
    with gen_ctx.phase("quality_check") as p:
        try:
            issues = _quality_check(output_path, employee)
            gen_ctx.quality_issues.extend(issues)
            _check_replacement_completeness(output_path, combined_pairs)
            p.details["issues_found"] = len(issues)
            p.message = f"{len(issues)} issues found" if issues else "All checks passed"
        except Exception as exc:
            p.status = "failed"
            p.error = str(exc)
            logger.warning(f"Quality check failed (non-fatal): {exc}")

    logger.info(f"=== CV Generated: {output_path} ===")
    return output_path

def _find_libreoffice() -> Optional[str]:
    """Find LibreOffice executable."""
    import platform
    
    env_path = os.environ.get("LIBREOFFICE_PATH")
    if env_path and os.path.exists(env_path):
        return env_path
    
    if platform.system() == "Windows":
        candidates = [
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        ]
    else:
        candidates = ["/usr/bin/soffice", "/usr/bin/libreoffice"]
    
    for path in candidates:
        if os.path.exists(path):
            return path
    
    if platform.system() != "Windows":
        try:
            result = subprocess.run(["which", "soffice"], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                return result.stdout.strip()
        except:
            pass
    
    return None


def convert_docx_to_pdf(docx_path: str, output_path: Optional[str] = None) -> Optional[str]:
    """Convert DOCX to PDF using LibreOffice.

    Uses a per-call temporary UserInstallation directory so that multiple
    concurrent conversions don't fight over the same LibreOffice profile and
    crash each other.  --norestore and --nofirststartwizard prevent interactive
    dialogs that would hang the process in headless mode.
    """
    soffice = _find_libreoffice()
    if not soffice:
        logger.warning("LibreOffice not found — PDF conversion unavailable")
        return None

    output_dir = os.path.dirname(output_path or docx_path) or "."
    os.makedirs(output_dir, exist_ok=True)

    user_profile = tempfile.mkdtemp(prefix="lo_profile_")
    try:
        # LibreOffice UserInstallation URI must use forward slashes.
        profile_uri = "file:///" + user_profile.replace("\\", "/")
        result = subprocess.run(
            [
                soffice,
                "--headless",
                "--norestore",
                "--nofirststartwizard",
                f"-env:UserInstallation={profile_uri}",
                "--convert-to", "pdf",
                "--outdir", output_dir,
                docx_path,
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode == 0:
            pdf_name = os.path.splitext(os.path.basename(docx_path))[0] + ".pdf"
            pdf_path = os.path.join(output_dir, pdf_name)
            if os.path.exists(pdf_path):
                if output_path and pdf_path != output_path:
                    shutil.move(pdf_path, output_path)
                    return output_path
                return pdf_path
        else:
            logger.warning("LibreOffice exited %d. stderr: %s", result.returncode, result.stderr[:500])
    except Exception as exc:
        logger.error("PDF conversion failed: %s", exc)
    finally:
        shutil.rmtree(user_profile, ignore_errors=True)

    return None


# ===========================================================================
# Photo Replacement
# ===========================================================================

def _replace_photo(docx_path: str, photo_path: str) -> bool:
    """Replace the largest image in the DOCX with the employee photo.

    Repacks atomically: writes to a temp file first then renames over the
    original so a mid-write crash cannot corrupt the DOCX.
    """
    if not photo_path or not os.path.exists(photo_path):
        return False

    temp_dir = tempfile.mkdtemp(prefix="cv_photo_")
    tmp_out: Optional[str] = None
    try:
        with zipfile.ZipFile(docx_path, 'r') as zf:
            zf.extractall(temp_dir)

        media_dir = os.path.join(temp_dir, 'word', 'media')
        if not os.path.exists(media_dir):
            return False

        images = [
            f for f in os.listdir(media_dir)
            if f.lower().endswith(('.png', '.jpg', '.jpeg'))
        ]
        if not images:
            return False

        largest = max(images, key=lambda f: os.path.getsize(os.path.join(media_dir, f)))
        target = os.path.join(media_dir, largest)

        with Image.open(target) as orig:
            size = orig.size

        with Image.open(photo_path) as new_img:
            resized = new_img.convert('RGB').resize(size, Image.LANCZOS)
            ext = os.path.splitext(largest)[1].lower()
            fmt = 'JPEG' if ext in ('.jpg', '.jpeg') else 'PNG'
            resized.save(target, fmt, quality=95)

        # Write to a temp file alongside the original, then rename atomically.
        doc_dir = os.path.dirname(os.path.abspath(docx_path))
        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False, dir=doc_dir) as tmp_f:
            tmp_out = tmp_f.name
        with zipfile.ZipFile(tmp_out, 'w', zipfile.ZIP_DEFLATED) as zout:
            for root, _dirs, files in os.walk(temp_dir):
                for file in files:
                    fp = os.path.join(root, file)
                    zout.write(fp, os.path.relpath(fp, temp_dir))
        os.replace(tmp_out, docx_path)
        tmp_out = None  # ownership transferred
        return True
    except Exception as exc:
        logger.warning("Photo replacement failed: %s", exc)
        return False
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
        if tmp_out and os.path.exists(tmp_out):
            os.unlink(tmp_out)


# ===========================================================================
# Main Entry Point
# ===========================================================================

# Keywords that mark the end of a genuine address in APILayer-parsed PDFs.
# The parser often concatenates semi-structured table content (Période, Organisme …)
# directly after the address line without a line break.
_ADDR_SECTION_SPLIT = re.compile(
    r'\s+(?:Exp[eé]riences?|Formation|Certifications?|Comp[eé]tences?|Skills|'
    r'Education|Projects?|P[eé]riode|Organisme|Fonction\s+occup|'
    r'Professional\s+experience|Work\s+experience)',
    re.I,
)

_PHONE_RE = re.compile(r'^[\d\s+()\-./]+$')
_EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

# Maximum lengths to prevent XML overflow in fixed-height template areas.
_MAX_NAME_LEN     = 80
_MAX_FIELD_LEN    = 300   # email, phone, address, linkedin, title
_MAX_SUMMARY_LEN  = 2000
_MAX_DESC_LEN     = 1500  # individual experience/project descriptions


def _safe_str(value: Any, max_len: int = _MAX_FIELD_LEN) -> str:
    """Coerce *value* to a trimmed string with an optional length cap."""
    if value is None:
        return ""
    s = str(value).strip()
    if len(s) > max_len:
        s = s[:max_len].rsplit(' ', 1)[0] + "…"
    return s


def cleanEmployeeData(employee: Dict[str, Any]) -> Dict[str, Any]:
    """
    Sanitise and validate all employee fields before they touch the template.

    Problems addressed:
    - APILayer mixes address text with the experience table that follows it
    - Corrupted email (field contains a label instead of a real address)
    - Corrupted phone (non-numeric garbage)
    - Experience/education entries with empty title or company are useless
    """
    import copy
    cleaned = copy.deepcopy(employee)

    # ── Name (required, build from firstName/lastName if missing) ────
    name = _safe_str(cleaned.get('name'), _MAX_NAME_LEN)
    if not name:
        first = _safe_str(cleaned.get('firstName'), 40)
        last = _safe_str(cleaned.get('lastName'), 40)
        name = f"{first} {last}".strip()
    if name:
        cleaned['name'] = name
    else:
        cleaned['name'] = 'Employee'
        logger.warning("cleanEmployeeData: no usable name — defaulting to 'Employee'")

    # ── Scalar text fields — cap lengths ─────────────────────────────
    for field in ('title', 'email', 'phone', 'address', 'linkedin'):
        cleaned[field] = _safe_str(cleaned.get(field), _MAX_FIELD_LEN)
    cleaned['summary'] = _safe_str(cleaned.get('summary'), _MAX_SUMMARY_LEN)

    # ── Skills — ensure list of strings, filter None / empty ─────────
    raw_skills = cleaned.get('skills')
    if isinstance(raw_skills, list):
        cleaned['skills'] = [
            _safe_str(s, 100) for s in raw_skills
            if s is not None and str(s).strip()
        ]
    elif isinstance(raw_skills, str):
        cleaned['skills'] = [s.strip() for s in raw_skills.split(',') if s.strip()]
    else:
        cleaned['skills'] = []

    # ── Languages — same treatment ───────────────────────────────────
    raw_langs = cleaned.get('languages')
    if isinstance(raw_langs, list):
        cleaned['languages'] = [
            _safe_str(l, 50) for l in raw_langs
            if l is not None and str(l).strip()
        ]
    else:
        cleaned['languages'] = []

    # ── Address ──────────────────────────────────────────────────────
    raw_addr = cleaned.get('address', '').strip()
    if raw_addr:
        # Split at the first section-header keyword that APILayer injected
        parts = _ADDR_SECTION_SPLIT.split(raw_addr, maxsplit=1)
        cleaned['address'] = parts[0].strip()

    # ── Email ────────────────────────────────────────────────────────
    raw_email = cleaned.get('email', '').strip()
    if raw_email and not _EMAIL_RE.match(raw_email):
        logger.warning(f"cleanEmployeeData: discarding invalid email: {raw_email!r}")
        cleaned['email'] = ''

    # ── Phone ────────────────────────────────────────────────────────
    raw_phone = cleaned.get('phone', '').strip()
    if raw_phone and not _PHONE_RE.match(raw_phone):
        logger.warning(f"cleanEmployeeData: discarding invalid phone: {raw_phone!r}")
        cleaned['phone'] = ''

    # ── Experience entries ───────────────────────────────────────────
    raw_exp = cleaned.get('experience')
    if isinstance(raw_exp, list):
        valid_exp = []
        for exp in raw_exp:
            if not isinstance(exp, dict):
                continue
            title = (exp.get('title') or exp.get('jobTitle', '')).strip()
            company = (exp.get('company') or exp.get('companyName', '')).strip()
            if not title or not company:
                continue
            # Cap description length to prevent template overflow
            if exp.get('description'):
                exp['description'] = _safe_str(exp['description'], _MAX_DESC_LEN)
            valid_exp.append(exp)
        dropped = len(raw_exp) - len(valid_exp)
        if dropped:
            logger.info(f"cleanEmployeeData: dropped {dropped} incomplete experience entries")
        cleaned['experience'] = valid_exp
    else:
        cleaned['experience'] = []

    # ── Education entries ────────────────────────────────────────────
    raw_edu = cleaned.get('education')
    if isinstance(raw_edu, list):
        valid_edu = []
        for edu in raw_edu:
            if not isinstance(edu, dict):
                continue
            if not (edu.get('degree') or edu.get('institution', '')).strip():
                continue
            # Deduplicate doubled degree strings (e.g. "Foo Bar Foo Bar" → "Foo Bar")
            degree = (edu.get('degree') or '').strip()
            if degree:
                words = degree.split()
                half = len(words) // 2
                if half >= 2 and words[:half] == words[half:]:
                    edu['degree'] = ' '.join(words[:half])
            valid_edu.append(edu)
        cleaned['education'] = valid_edu
    else:
        cleaned['education'] = []

    # ── Certifications — filter nulls / non-dicts ────────────────────
    raw_certs = cleaned.get('certifications')
    if isinstance(raw_certs, list):
        cleaned['certifications'] = [
            c for c in raw_certs
            if c is not None and (isinstance(c, dict) or str(c).strip())
        ]
    else:
        cleaned['certifications'] = []

    # ── Projects — filter nulls, cap descriptions ────────────────────
    raw_proj = cleaned.get('projects')
    if isinstance(raw_proj, list):
        valid_proj = []
        for p in raw_proj:
            if not isinstance(p, dict):
                continue
            if p.get('description'):
                p['description'] = _safe_str(p['description'], _MAX_DESC_LEN)
            valid_proj.append(p)
        cleaned['projects'] = valid_proj
    else:
        cleaned['projects'] = []

    # ── Title (derive from most recent experience if not explicitly set) ──
    # Employees imported from APILayer often have no top-level 'title' field
    # but their experience entries carry the title.  Derived here so that Groq
    # and the regex detection both see a valid 'title' for the replacement map.
    if not cleaned.get('title') and cleaned.get('experience'):
        first_exp = cleaned['experience'][0]
        derived = (first_exp.get('title') or first_exp.get('jobTitle', '')).strip()
        if derived:
            cleaned['title'] = derived
            logger.info(f"cleanEmployeeData: derived title from experience: {derived!r}")

    # ── Content truncation (prevent overflow in fixed-height templates) ─
    # Employees with very long histories (23 certs, 18 projects) would overflow
    # any fixed-format template.  We keep the most meaningful entries.
    _MAX_CERTS    = 10   # prioritise those with dates
    _MAX_PROJECTS = 10
    _MAX_SKILLS   = 15

    certs = cleaned.get('certifications') or []
    if len(certs) > _MAX_CERTS:
        # Keep certs that have a date first, then fill with the rest
        with_date    = [c for c in certs if isinstance(c, dict)
                        and (c.get('date_obtained') or c.get('issueDate') or c.get('issue_date'))]
        without_date = [c for c in certs if c not in with_date]
        kept = (with_date + without_date)[:_MAX_CERTS]
        logger.info(
            f"cleanEmployeeData: certifications truncated {len(certs)} → {len(kept)}")
        cleaned['certifications'] = kept

    projects = cleaned.get('projects') or []
    if len(projects) > _MAX_PROJECTS:
        logger.info(
            f"cleanEmployeeData: projects truncated {len(projects)} → {_MAX_PROJECTS}")
        cleaned['projects'] = projects[:_MAX_PROJECTS]

    skills = cleaned.get('skills') or []
    if len(skills) > _MAX_SKILLS:
        cleaned['skills'] = skills[:_MAX_SKILLS]

    return cleaned


def _normalize_employee_payload_aliases(employee: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize common backend/raw payload aliases for fallback generation.

    Keeps this engine resilient whether caller sends the flattened fallback
    payload or the richer raw profile object.
    """
    normalized = dict(employee or {})

    if not normalized.get("name"):
        first = str(normalized.get("firstName") or normalized.get("first_name") or "").strip()
        last = str(normalized.get("lastName") or normalized.get("last_name") or "").strip()
        if first or last:
            normalized["name"] = f"{first} {last}".strip()

    if not normalized.get("title"):
        normalized["title"] = (
            normalized.get("currentPosition")
            or normalized.get("current_position")
            or normalized.get("jobTitle")
            or ""
        )

    if not normalized.get("summary"):
        normalized["summary"] = (
            normalized.get("professionalSummary")
            or normalized.get("professional_summary")
            or ""
        )

    if not normalized.get("linkedin"):
        normalized["linkedin"] = (
            normalized.get("linkedinUrl")
            or normalized.get("linkedin_url")
            or normalized.get("linkedIn")
            or ""
        )

    if not isinstance(normalized.get("experience"), list):
        for k in ("workExperiences", "work_experiences", "experiences", "parcours"):
            if isinstance(normalized.get(k), list):
                normalized["experience"] = normalized.get(k)
                break
    if not isinstance(normalized.get("education"), list):
        for k in ("educations", "formations", "degrees", "etudes"):
            if isinstance(normalized.get(k), list):
                normalized["education"] = normalized.get(k)
                break
    if not isinstance(normalized.get("projects"), list):
        for k in ("projectList", "project_list"):
            if isinstance(normalized.get(k), list):
                normalized["projects"] = normalized.get(k)
                break

    return normalized


def process_cv(
    template_path: str,
    employee_data: Dict[str, Any],
    output_dir: str,
    output_pdf: bool = False,
    debug: bool = False,
    language: str = "original",
    out_warnings: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """
    Process a CV template and replace personal information with employee data.

    Works with ANY DOCX template - no placeholders required.
    Handles complex layouts with textboxes, shapes, tables, etc.

    Args:
        template_path: Path to the DOCX template file.
        employee_data: Dict with employee profile data.
        output_dir: Directory for the generated output.
        output_pdf: If True, also convert to PDF and return the PDF path.
        debug: If True, write a JSON trace file alongside the output.
        out_warnings: Optional mutable list; engine warnings are appended here
                      so callers can surface them to the HTTP response.

    Returns:
        Path to the generated DOCX (or PDF if output_pdf=True).

    Raises:
        FileNotFoundError: Template file doesn't exist.
        ValueError: Invalid input data or template format.
        RuntimeError: Generation failed after validation passed.
    """
    ctx = GenerationContext(debug=debug)
    ctx.template_path = template_path or ""
    ctx.employee_name = (employee_data or {}).get('name', 'Unknown')

    logger.info("=== CV Generation Started ===")
    logger.info(f"Template: {template_path}")
    logger.info(f"Employee: {ctx.employee_name}")

    # ── Input validation ──────────────────────────────────────────────
    if not template_path or not os.path.isfile(template_path):
        raise FileNotFoundError(f"Template file not found: {template_path}")
    if not employee_data or not isinstance(employee_data, dict):
        raise ValueError("Employee data must be a non-empty dictionary")

    # Step 0: Validate and sanitise all employee fields using the schema
    with ctx.phase("input_validation") as p:
        employee_data = _normalize_employee_payload_aliases(employee_data)
        employee_data, validation_report = validate_employee_data(employee_data)
        employee_data = _normalize_employee_payload_aliases(employee_data)
        validation_report.log_all()
        ctx.validation_warnings = validation_report.warnings
        p.details["fields_defaulted"] = validation_report.fields_defaulted
        p.details["dropped_experiences"] = validation_report.dropped_experiences
        p.details["dropped_educations"] = validation_report.dropped_educations
        p.message = (
            f"{validation_report.valid_field_count}/"
            f"{validation_report.original_field_count} fields valid"
        )
    preferred_language = _resolve_generation_language(template_path, language)
    logger.info(f"Target language hint: {preferred_language}")
    employee_data = _normalize_employee_language_for_generation(
        employee_data,
        preferred_language,
    )
    # Translation/normalization helpers may reshape keys; re-apply aliases so
    # downstream section builders always see canonical lists.
    employee_data = _normalize_employee_payload_aliases(employee_data)
    
    os.makedirs(output_dir, exist_ok=True)
    
    ext = os.path.splitext(template_path)[1].lower()
    if ext != '.docx':
        raise ValueError(f"Only .docx templates supported, got: {ext}")
    
    # Verify the file is a valid zip/docx with the required internal structure
    with ctx.phase("template_validation") as p:
        try:
            validate_docx_structure(template_path)
            with zipfile.ZipFile(template_path, 'r') as zf:
                p.details["zip_entries"] = len(zf.namelist())
            p.details["size_bytes"] = os.path.getsize(template_path)
        except CVTemplateError as exc:
            raise ValueError(str(exc)) from exc

    # Compute input hash for idempotency verification
    input_hash = _compute_input_hash(template_path, employee_data)
    logger.info(f"Input hash: {input_hash}")

    # Build output filename — sanitize to prevent path traversal
    name = employee_data.get('name', 'Employee').replace(' ', '_')
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
    # Extra safety: Remove any directory components
    name = os.path.basename(name)
    if not name:
        name = 'Employee'
    # Truncate to 200 chars to stay within filesystem limits
    if len(name) > 200:
        name = name[:200]
    output_path = os.path.join(output_dir, f"{name}_CV.docx")
    ctx.output_path = output_path
    
    template_plan = _plan_template_execution(template_path)
    template_mode = template_plan["template_mode"]
    use_placeholder_mode = bool(template_plan.get("use_fast_placeholder_render"))
    logger.info(
        "Template execution strategy: %s (body=%s, textbox=%s, layout_table=%s, positioned_txbx=%s)",
        template_plan.get("strategy"),
        template_plan.get("body_section_headings"),
        template_plan.get("textbox_section_headings"),
        template_plan.get("layout_table_detected"),
        template_plan.get("positioned_textboxes"),
    )
    if template_mode == "placeholder" and not use_placeholder_mode:
        logger.info(
            "Template uses advanced docxtpl structural tags; falling back to direct pipeline"
        )
    ctx.mode = "placeholder" if use_placeholder_mode else "ai_only"

    try:
        if use_placeholder_mode:
            try:
                with ctx.phase("placeholder_render") as p:
                    _render_placeholder_template(template_path, employee_data, output_path)
                    p.message = "Rendered via docxtpl placeholder mode"

                # Placeholder templates can still overflow in textbox-heavy layouts
                # after values expand; run the same geometry safety passes.
                pre_resize_positions = _snapshot_textbox_positions(output_path)
                with ctx.phase("textbox_resize") as p:
                    resized = _resize_textboxes(output_path)
                    p.details["resized"] = resized
                    p.message = f"{resized} textboxes resized"
                with ctx.phase("textbox_reflow") as p:
                    reflowed = _reflow_contact_textboxes(output_path, pre_resize_positions)
                    p.details["reflowed"] = reflowed
                    p.message = f"{reflowed} textboxes reflowed"
            except TemplateError as exc:
                logger.warning(
                    "Placeholder render failed (%s); retrying with direct pipeline",
                    exc,
                )
                ctx.mode = "ai_only"
                _generate_with_replacement(
                    template_path,
                    employee_data,
                    output_path,
                    ctx,
                    template_strategy=template_plan,
                    preferred_language=preferred_language,
                )
        else:
            _generate_with_replacement(
                template_path,
                employee_data,
                output_path,
                ctx,
                template_strategy=template_plan,
                preferred_language=preferred_language,
            )
    except CVGenerationError:
        ctx.save_trace()
        raise
    except Exception as exc:
        logger.error(f"CV generation failed: {exc}", exc_info=True)
        ctx.save_trace()
        raise CVRenderError(
            f"CV generation failed: {exc}", cause=exc
        ) from exc

    # Verify output was actually created and is a valid DOCX
    with ctx.phase("output_validation") as p:
        if not os.path.isfile(output_path):
            raise CVIOError("CV generation completed but output file was not created")
        file_size = os.path.getsize(output_path)
        if file_size < 100:
            raise CVRenderError("CV generation produced an empty or corrupt output file")
        # Verify the output is a valid ZIP/DOCX
        if not zipfile.is_zipfile(output_path):
            raise CVRenderError("CV generation produced a corrupt (non-ZIP) output file")
        try:
            with zipfile.ZipFile(output_path, 'r') as zf:
                if 'word/document.xml' not in zf.namelist():
                    raise CVRenderError("CV generation produced a DOCX missing document.xml")
        except zipfile.BadZipFile:
            raise CVRenderError("CV generation produced a corrupt DOCX file")
        p.details["output_size_bytes"] = file_size
        p.details["input_hash"] = input_hash
        p.message = f"Valid DOCX ({file_size:,} bytes)"
    
    # Replace photo if provided
    if employee_data.get('photo'):
        with ctx.phase("photo_replacement") as p:
            try:
                photo_path = str(employee_data['photo'])
                # Security: reject path traversal — normalise and check for ..
                norm = os.path.normpath(photo_path)
                if '..' in norm.split(os.sep) or '..' in norm.split('/'):
                    p.status = "skipped"
                    p.message = "Photo path contains '..' — skipped for security"
                    ctx.warn("Photo path traversal attempt blocked")
                else:
                    success = _replace_photo(output_path, photo_path)
                    p.message = "replaced" if success else "no matching image found"
            except Exception as exc:
                p.status = "failed"
                p.error = str(exc)
                logger.warning(f"Photo replacement failed (non-fatal): {exc}")
    
    # Convert to PDF if requested
    if output_pdf:
        with ctx.phase("pdf_conversion") as p:
            pdf = convert_docx_to_pdf(output_path)
            if pdf:
                p.message = f"PDF created: {os.path.basename(pdf)}"
                ctx.finalize()
                ctx.save_trace()
                logger.info(f"=== CV Generation Complete: {pdf} ===")
                logger.info(ctx.get_summary())
                return pdf
            else:
                p.status = "failed"
                p.message = "PDF conversion failed — returning DOCX"
    
    ctx.finalize()
    ctx.save_trace()
    logger.info(f"=== CV Generation Complete: {output_path} ===")
    logger.info(ctx.get_summary())

    # Surface engine-level warnings to caller so they can be forwarded
    # through the API response headers (X-CV-Warnings).
    if out_warnings is not None:
        for w in (ctx.validation_warnings or []):
            out_warnings.append({"code": "validation", "severity": "info", "message": str(w)})
        for issue in (ctx.quality_issues or []):
            out_warnings.append({"code": "quality", "severity": "warning", "message": str(issue)})

    return output_path
