"""
template_tagger.py — Auto-tag engine for DOCX CV templates.

Converts a plain DOCX template (with dummy data like "John Doe") into a
Jinja2-tagged template (with {{ full_name }}, {% for exp in work_experiences %}, etc.)
so that DocxTemplate can render it with real employee data.

Three-layer pipeline:
  1. Regex   → emails, phones, date ranges (100% reliable)
  2. Rules   → section headings, header prominence, entry boundaries
  3. AI/LLM  → ambiguous text classification (fallback)
"""

import copy
import logging
import os
import re
import tempfile
import unicodedata
from dataclasses import dataclass, field as dataclass_field
from typing import Any, Dict, List, Optional, Tuple

from docx import Document
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

from app.services.cv_section_taxonomy import (
    SECTION_KEYWORDS,
    SECTION_KEYWORDS_NORMALIZED,
    SECTION_DATA_KEY,
    classify_heading,
    normalize_text,
)

logger = logging.getLogger(__name__)

def _tagger_enable_conditionals() -> bool:
    """Return True if auto-tagger should insert conditional wrappers."""
    return os.getenv("CV_TEMPLATE_TAGGER_CONDITIONALS", "1") != "0"


def _tagger_remove_empty_sections() -> bool:
    """Return True if empty sections (heading + content) must be hidden entirely.

    When True (the default), the tagger wraps the section heading paragraph
    AND its body together in ``{%p if data_key %}…{%p endif %}``.  No "N/A"
    fallback, no orphan heading — sections without data simply disappear.

    Set ``CV_TEMPLATE_REMOVE_EMPTY_SECTIONS=0`` to fall back to the legacy
    behaviour (heading always visible, body shows "N/A").
    """
    return _tagger_enable_conditionals() and os.getenv(
        "CV_TEMPLATE_REMOVE_EMPTY_SECTIONS", "1"
    ) != "0"


def _section_supports_strict_remove(para, section_type: str) -> bool:
    """Return True when a section heading is strong enough for full removal."""
    if para is None or not section_type or section_type == "other":
        return False

    text = (para.text or "").strip()
    if not text:
        return False

    style_name = (getattr(getattr(para, "style", None), "name", "") or "").lower()
    if style_name in ["heading 1", "heading1", "titre 1", "titre1"]:
        return True

    normalized = normalize_text(text)
    if normalized in SECTION_KEYWORDS_NORMALIZED.get(section_type, set()):
        return True

    if classify_heading(text) != section_type:
        return False

    runs = getattr(para, "runs", []) or []
    has_bold = any(bool(getattr(run.font, "bold", False)) for run in runs)
    max_size = 0
    for run in runs:
        if run.font.size:
            max_size = max(max_size, run.font.size)

    is_all_caps = (text == text.upper() and len(text) > 3)
    is_large = max_size >= 152400
    return len(text.split()) <= 4 and (has_bold or (is_large and is_all_caps))


# ============================================================================
# REGEX PATTERNS
# ============================================================================

_EMAIL_RE = re.compile(
    r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b"
)

_PHONE_RE = re.compile(
    r"(?:\+\d{1,3}[\s.-]?)?"            # optional country code
    r"(?:\(?\d{2,4}\)?[\s.-]?)"          # area code
    r"(?:\d{2,4}[\s.-]?){2,4}"           # number groups
)

# Placeholder phone patterns like "(33) 00 00 00 00 00"
_PHONE_PLACEHOLDER_RE = re.compile(
    r"(?:\(\d{1,3}\)\s*)?(?:00[\s.-]?){3,}00?",
    re.IGNORECASE,
)

_URL_RE = re.compile(
    r"https?://[^\s,;]+|www\.[^\s,;]+"
)

# Month names (EN + FR) for date detection
_MONTH_NAMES = (
    r"(?:Jan(?:uary|vier)?|Feb(?:ruary|rier)?|Mar(?:ch|s)?|"
    r"Apr(?:il)?|Avr(?:il)?|May|Mai|Jun(?:e)?|Juin|Jul(?:y)?|Juillet|"
    r"Aug(?:ust)?|Ao[uû]t|Sep(?:tember|tembre)?|Oct(?:ober|obre)?|"
    r"Nov(?:ember|embre)?|Dec(?:ember|embre)?)"
)

_DATE_SINGLE_RE = re.compile(
    rf"(?:{_MONTH_NAMES}\s+\d{{4}}|\d{{2}}/\d{{4}}|\d{{4}})",
    re.IGNORECASE,
)

_DATE_RANGE_RE = re.compile(
    rf"({_MONTH_NAMES}\s+\d{{4}}|\d{{2}}/\d{{4}}|\d{{4}})"
    r"\s*[-–—]\s*"
    rf"({_MONTH_NAMES}\s+\d{{4}}|\d{{2}}/\d{{4}}|\d{{4}}|"
    r"[Pp]resent|[Aa]ctuel(?:lement)?|[Ee]n\s*cours|[Cc]urrent)",
    re.IGNORECASE,
)

# Placeholder date ranges like "MOIS 20XX À MOIS 20XX"
_DATE_PLACEHOLDER_RE = re.compile(
    r"\b(MOIS|MONTH)\s+[0-9X]{4}\b\s*(?:-|–|—|A|À|TO)\s*"
    r"(?:\b(MOIS|MONTH)\s+[0-9X]{4}\b|AUJOURD['’]HUI|PRESENT|CURRENT|EN\s+COURS|ACTUEL(?:LE)?(?:MENT)?)",
    re.IGNORECASE,
)

# Placeholder body text commonly used in templates
_PLACEHOLDER_TEXT_RE = re.compile(
    r"(ins[eé]rez\s+votre\s+texte\s+ici|insert\s+your\s+text\s+here|lorem\s+ipsum)",
    re.IGNORECASE,
)

# Placeholder company/role lines commonly found in French templates
_PLACEHOLDER_COMPANY_RE = re.compile(
    r"(nom\s+de\s+soci[eé]t[eé]|nom\s+de\s+societe|company\s+name)",
    re.IGNORECASE,
)
_PLACEHOLDER_ROLE_RE = re.compile(
    r"(lieu\s*-\s*fonction|location\s*-\s*role|poste\s+et\s+lieu)",
    re.IGNORECASE,
)
_PLACEHOLDER_COMPANY_ROLE_RE = re.compile(
    r"(entreprise|societe|soci[eé]t[eé]|company).*(fonction|poste|role|position)",
    re.IGNORECASE,
)
_PLACEHOLDER_CONTACT_RE = re.compile(
    r"^\s*\d*\s*Votre\s+(nom|pr[eé]nom|adresse|rue|ville|t[eé]l[eé]phone|email)\b",
    re.IGNORECASE,
)
_PLACEHOLDER_ZEROS_RE = re.compile(r"^0{2,}$")


def _build_date_line(text: str, start_var: str, end_var: str) -> str:
    """Build a Jinja date line with smart open-ended handling."""
    upper_text = (text or "").upper()
    open_label: Optional[str] = None
    if "AUJOURD" in upper_text or "ACTUEL" in upper_text or "EN COURS" in upper_text:
        open_label = "Aujourd'hui"
    elif "PRESENT" in upper_text:
        open_label = "Present"
    elif "CURRENT" in upper_text:
        open_label = "Current"

    # If conditional wrappers are disabled, avoid block tags entirely.
    if not _tagger_enable_conditionals():
        # Use inline Jinja expressions to avoid {% if %} blocks.
        return (
            f"{{{{ {start_var} or '' }}}}"
            f"{{{{ ' - ' if ({start_var} or {end_var}) else '' }}}}"
            f"{{{{ ({end_var} or open_end_label) if ({start_var} or {end_var}) else '' }}}}"
        )

    # If open-ended label is needed, use a dynamic context variable.
    open_suffix = " - {{ open_end_label }}" if open_label else ""

    return (
        f"{{% if {start_var} %}}{{{{ {start_var} }}}}{{% endif %}}"
        f"{{% if {end_var} %}}"
        f"{{% if {start_var} %}} - {{% endif %}}{{{{ {end_var} }}}}"
        f"{{% elif {start_var} %}}{open_suffix}{{% endif %}}"
        f"{{% if not {start_var} and not {end_var} %}}N/A{{% endif %}}"
    )


def _apply_description_lines_loop(
    paragraphs,
    placeholder_indices: List[int],
    list_key: str,
) -> bool:
    """Replace repeated placeholder lines with a paragraph loop."""
    if not placeholder_indices or len(placeholder_indices) < 2:
        return False

    first_idx = placeholder_indices[0]
    first_para = paragraphs[first_idx]
    text = (first_para.text or "").strip()
    if not text:
        return False

    _insert_paragraph_before(first_para, f"{{%p for line in {list_key} %}}")
    _replace_text_in_paragraph(first_para, text, "{{ line }}")
    _insert_paragraph_after(first_para, "{%p endfor %}")

    for idx in placeholder_indices[1:]:
        para = paragraphs[idx]
        _remove_paragraph(para)

    return True


def _is_bullet_paragraph(paragraph) -> bool:
    """Return True if the paragraph is part of a numbered/bulleted list."""
    pPr = paragraph._element.pPr
    if pPr is None:
        return False
    # Word list paragraphs have <w:numPr>
    if pPr.xpath(".//w:numPr"):
        return True
    style_name = (paragraph.style.name or "").lower()
    return "list" in style_name


def _apply_bullet_lines_loop(
    paragraphs,
    bullet_indices: List[int],
    list_key: str,
) -> bool:
    """Replace repeated bullet lines with a paragraph loop, preserving bullet styling."""
    if not bullet_indices:
        return False
    first_idx = bullet_indices[0]
    first_para = paragraphs[first_idx]
    text = (first_para.text or "").strip()
    if not text:
        return False

    _insert_paragraph_before(first_para, f"{{%p for line in {list_key} %}}")
    _replace_text_in_paragraph(first_para, text, "{{ line }}")
    _insert_paragraph_after(first_para, "{%p endfor %}")

    for idx in bullet_indices[1:]:
        _remove_paragraph(paragraphs[idx])
    return True


# ============================================================================
# SECTION HEADING KEYWORDS — sourced from cv_section_taxonomy
# ============================================================================
# Section synonym definitions live in app.services.cv_section_taxonomy and
# are shared with cv_generator and cv_generator_fallback.  Adding a new
# language or alias is a single edit there.
#
# These names are kept as aliases so legacy imports/external callers don't
# break, but new code should call ``classify_heading()`` directly.
_HEADING_KEYWORDS: Dict[str, set] = {
    section: set(keywords) for section, keywords in SECTION_KEYWORDS.items()
}

# Always use LLM classification for repeating entry sections.
ALWAYS_USE_LLM_ENTRY_TAGGING = True
LLM_ENTRY_SECTIONS = {"experience", "education", "projects", "certifications"}


def _normalize_heading_text(text: str) -> str:
    """Backward-compatible alias for ``cv_section_taxonomy.normalize_text``."""
    return normalize_text(text)


_NORMALIZED_HEADING_KEYWORDS: Dict[str, set] = {
    section: set(keywords) for section, keywords in SECTION_KEYWORDS_NORMALIZED.items()
}

# Loop variable names and field mappings for repeating sections
_LOOP_CONFIG = {
    "experience": {
        "var": "exp",
        "list_key": "work_experiences",
        "fields": {
            "title": "exp.jobTitle",
            "company": "exp.companyName",
            "start_date": "exp.startDate",
            "end_date": "exp.endDate",
            "description": "exp.description",
        },
    },
    "education": {
        "var": "edu",
        "list_key": "educations",
        "fields": {
            "title": "edu.degree",
            "institution": "edu.institution",
            "field": "edu.fieldOfStudy",
            "start_date": "edu.startDate",
            "end_date": "edu.endDate",
        },
    },
    "certifications": {
        "var": "cert",
        "list_key": "certifications",
        "fields": {
            "title": "cert.name",
            "issuer": "cert.issuingOrganization",
            "date": "cert.issueDate",
            "credential": "cert.credentialId",
        },
    },
    "projects": {
        "var": "proj",
        "list_key": "projects",
        "fields": {
            "title": "proj.displayTitle",
            "role": "proj.role",
            "client": "proj.client",
            "start_date": "proj.startDate",
            "end_date": "proj.endDate",
            "description": "proj.description",
        },
    },
}


# ============================================================================
# DATA STRUCTURES
# ============================================================================

@dataclass
class Section:
    """A logical section of the CV document."""
    section_type: str  # "header", "experience", "education", etc.
    heading_idx: Optional[int] = None
    paragraph_indices: List[int] = dataclass_field(default_factory=list)


@dataclass
class TagReplacement:
    """A pending text replacement in a specific paragraph."""
    para_idx: int
    old_text: str
    new_text: str


# ============================================================================
# MAIN ENTRY POINT
# ============================================================================

def _sanitize_paragraph_flow(para):
    """Strip MS Word constraints that catastrophically lock dynamic generative chunks from naturally flowing."""
    pPr = para._element.pPr
    if pPr is not None:
        for tag in ['.//w:keepNext', './/w:keepLines', './/w:pageBreakBefore']:
            for node in pPr.xpath(tag):
                pPr.remove(node)

def _get_all_paragraphs(doc) -> list:
    """Yield all paragraphs in document, including those inside tables."""
    paras = list(doc.paragraphs)
    for p in paras:
        _sanitize_paragraph_flow(p)

    for table in doc.tables:
        for row in table.rows:
            # Force fluid rows for robust CV layout generation
            trPr = row._element.trPr
            if trPr is not None:
                # 1. Allow rows to actively split across pages
                for cs in trPr.xpath('.//w:cantSplit'):
                    trPr.remove(cs)
                # 2. Destroy rigid bounding box heights (prevents Word from jumping massive rows to Page 2)
                for h in trPr.xpath('.//w:trHeight'):
                    trPr.remove(h)
            for cell in row.cells:
                cell_paras = list(cell.paragraphs)
                for cp in cell_paras:
                    _sanitize_paragraph_flow(cp)
                paras.extend(cell_paras)
    return paras

def auto_tag_template(docx_path: str) -> str:
    """Convert a plain DOCX template into a Jinja2-tagged copy.

    The original file is never modified. Returns path to the tagged copy.
    If the template already contains ``{{ }}`` tags, returns the original path.
    """
    logger.info("Auto-tagging template: %s", docx_path)

    doc = Document(docx_path)
    all_paras = _get_all_paragraphs(doc)

    if not all_paras:
        logger.warning("Document has no paragraphs (even inside tables) — returning as-is")
        return docx_path

    # --- Already tagged? Skip. ---
    if _has_jinja_tags(all_paras):
        logger.info("Template already contains Jinja2 tags — skipping auto-tag")
        return docx_path

    # --- Step 1: merge split runs for reliable text matching ---
    for para in all_paras:
        _merge_split_runs(para)

    # --- Step 2: detect sections ---
    sections = _detect_sections(all_paras)
    logger.info(f"[DEBUG] Detected {len(sections)} sections: {[s.section_type for s in sections]}")

    # --- Step 3: collect tag replacements per section type ---
    replacements: List[TagReplacement] = []
    tagged_indices: set = set()  # track which paragraphs have been tagged

    for section in sections:
        if section.section_type == "header":
            reps = _tag_header_section(all_paras, section)
            replacements.extend(reps)
            tagged_indices.update(r.para_idx for r in reps)

        elif section.section_type == "summary":
            reps = _tag_summary_section(all_paras, section)
            replacements.extend(reps)
            tagged_indices.update(r.para_idx for r in reps)

        elif section.section_type == "skills":
            reps = _tag_skills_section(all_paras, section)
            replacements.extend(reps)
            tagged_indices.update(r.para_idx for r in reps)

        elif section.section_type == "contact":
            reps = _tag_contact_section(all_paras, section)
            replacements.extend(reps)
            tagged_indices.update(r.para_idx for r in reps)

    # --- Step 4: regex pass on un-tagged paragraphs ---
    regex_reps = _tag_with_regex(all_paras, tagged_indices)
    replacements.extend(regex_reps)

    logger.info(f"[DEBUG] Collected {len(replacements)} text replacements from rules engine.")
    for idx, rep in enumerate(replacements):
        logger.info(f"[DEBUG] Replacement {idx}: '{rep.old_text[:30]}' -> '{rep.new_text}'")

    if not replacements and not any(s.section_type in _LOOP_CONFIG for s in sections):
        logger.warning("[DEBUG] Auto-tagger found ZERO text chunks to replace and ZERO loop sections. Returning untouched template.")
        return docx_path

    # --- Step 5: apply all text replacements ---
    _apply_replacements(all_paras, replacements)

    # --- Step 5.5: Heading Translation Hooks ---
    for section in sections:
        if section.heading_idx is not None and section.section_type != "other":
            heading_para = all_paras[section.heading_idx]
            original_text = heading_para.text.strip()
            if original_text:
                # Escape single quotes for Jinja2 parsing
                safe_default = original_text.replace("'", "\\'")
                new_text = f"{{{{ section_titles.get('{section.section_type}', '{safe_default}') }}}}"
                
                # Replace inline string completely preserving all native MS Word template formatting
                _replace_text_in_paragraph(heading_para, original_text, new_text)

    # --- Step 6: Conditional rendering of empty sections ---
    # Strict mode (default, controlled by CV_TEMPLATE_REMOVE_EMPTY_SECTIONS):
    #   Wrap heading + content together.  Empty sections vanish completely —
    #   no orphan heading, no placeholder "N/A".
    # Legacy mode (CV_TEMPLATE_REMOVE_EMPTY_SECTIONS=0):
    #   Heading remains visible; body renders "N/A" when data is missing.
    _SECTION_CONDITIONS = {
        section: SECTION_DATA_KEY[section]
        for section in (
            "experience", "education", "projects", "certifications",
            "skills", "languages", "awards", "interests", "volunteer",
            "references",
        )
        if section in SECTION_DATA_KEY
    }

    strict_remove = _tagger_remove_empty_sections()

    for section in sections:
        cond_var = _SECTION_CONDITIONS.get(section.section_type)
        if not cond_var:
            continue
        if section.heading_idx is None and not section.paragraph_indices:
            continue

        logger.info(
            "[DEBUG] Wrapping section '%s' in {%% if %s %%} (strict_remove=%s)",
            section.section_type, cond_var, strict_remove,
        )

        section_strict_remove = strict_remove
        if section_strict_remove and section.heading_idx is not None:
            section_strict_remove = _section_supports_strict_remove(
                all_paras[section.heading_idx],
                section.section_type,
            )

        if section_strict_remove:
            # Wrap from the heading paragraph to the last content paragraph
            # so an empty section disappears entirely (heading included).
            first_idx = section.heading_idx
            if first_idx is None and section.paragraph_indices:
                first_idx = section.paragraph_indices[0]
            last_idx = (
                section.paragraph_indices[-1]
                if section.paragraph_indices else section.heading_idx
            )
            if first_idx is None or last_idx is None:
                continue
            _insert_paragraph_before(all_paras[first_idx], f"{{%p if {cond_var} %}}")
            _insert_paragraph_after(all_paras[last_idx], "{%p endif %}")
        else:
            # Legacy: keep heading visible, only body is conditional, with
            # "N/A" fallback when data is missing.
            if not section.paragraph_indices:
                continue
            first_para = all_paras[section.paragraph_indices[0]]
            last_para = all_paras[section.paragraph_indices[-1]]
            _insert_paragraph_before(first_para, f"{{%p if {cond_var} %}}")
            # Insert in reverse — addnext inserts directly after the anchor.
            _insert_paragraph_after(last_para, "{%p endif %}")
            _insert_paragraph_after(last_para, "N/A")
            _insert_paragraph_after(last_para, "{%p else %}")

    # --- Step 7: inject for-loops for repeating sections ---
    for section in sections:
        if section.section_type in _LOOP_CONFIG:
            logger.info(f"[DEBUG] Processing repeating loop for section: {section.section_type}")
            _inject_for_loop(doc, all_paras, section)
        elif section.section_type == "skills" and len(section.paragraph_indices) > 1:
            logger.info("[DEBUG] Processing repeating loop for section: skills")
            _inject_skills_loop(doc, all_paras, section)

    # --- Step 7.5: remove leftover placeholder lines ---
    for para in list(all_paras):
        text = (para.text or "").strip()
        if not text:
            continue
        if _PLACEHOLDER_TEXT_RE.search(text):
            _remove_paragraph(para)
            continue
        if _DATE_PLACEHOLDER_RE.search(text):
            _remove_paragraph(para)
            continue
        if _PLACEHOLDER_COMPANY_RE.search(text) or _PLACEHOLDER_ROLE_RE.search(text) or _PLACEHOLDER_COMPANY_ROLE_RE.search(text):
            _remove_paragraph(para)
            continue
        if _PLACEHOLDER_CONTACT_RE.search(text) or _PLACEHOLDER_ZEROS_RE.search(text):
            _remove_paragraph(para)

    # --- Step 8: save tagged copy ---
    tagged_dir = tempfile.mkdtemp()
    base_name = os.path.splitext(os.path.basename(docx_path))[0]
    tagged_path = os.path.join(tagged_dir, f"{base_name}_tagged.docx")
    doc.save(tagged_path)

    logger.info(f"[DEBUG] Auto-tagged template generated successfully at: {tagged_path}")
    return tagged_path


# ============================================================================
# DETECTION HELPERS
# ============================================================================

def _has_jinja_tags(paragraphs) -> bool:
    """Return True if any paragraph already contains ``{{ }}`` or ``{% %}``."""
    for para in paragraphs:
        text = para.text or ""
        if "{{" in text or "{%" in text:
            return True
    return False


def _is_heading(para) -> bool:
    """Check if a paragraph looks like a section heading."""
    text = (para.text or "").strip()
    if not text or len(text) > 80:
        return False

    # 1. Word heading styles
    # We only blindly trust Heading 1 (or Titre 1). Many templates incorrectly use
    # Heading 2 or Heading 3 for job titles or dates, which would shatter the section!
    style_name = (para.style.name or "").lower()
    if style_name in ["heading 1", "heading1", "titre 1", "titre1"]:
        return True

    # 2. Synonym-aware keyword match: detect section even when title contains extra words
    # (e.g. "Professional Experience", "Skills Summary", "Career History")
    is_keyword = _classify_heading_text(text) != "other"
    if is_keyword and len(text) < 50:
        return True

    runs = para.runs
    if not runs:
        return False

    # 3. Visual Prominence — large font only
    is_all_caps = (text == text.upper() and len(text) > 3)

    max_size = 0
    for run in runs:
        if run.font.size:
            max_size = max(max_size, run.font.size)

    # EMU to pt: 1 pt = 12700 EMU; >= 152400 EMU ~ 12 pt
    is_large = max_size >= 152400

    # When relying on visual style alone (no keyword match), only accept ALL CAPS text.
    # This avoids misclassifying bold content lines (job titles, company names, short
    # bullet points) that happen to share the same font size as the section heading.
    if is_large and is_all_caps and len(text) < 50:
        return True

    return False


def _classify_heading_text(text: str) -> str:
    """Classify a heading's text into a section type.

    Uses the shared ``cv_section_taxonomy.classify_heading`` so the parser,
    tagger and fallback engine all agree on what counts as a section
    header.  Returns ``"other"`` (the legacy sentinel) when no section type
    matches.
    """
    section = classify_heading(text)
    return section if section is not None else "other"


def _detect_sections(paragraphs) -> List[Section]:
    """Walk paragraphs and group them into logical sections."""
    sections: List[Section] = []
    heading_indices: List[Tuple[int, str]] = []

    # Find all heading candidates
    for i, para in enumerate(paragraphs):
        if _is_heading(para):
            section_type = _classify_heading_text(para.text)
            heading_indices.append((i, section_type))

    # Post-processing: demote "other"-typed headings that were detected purely by
    # visual style but are no more prominent than the content that follows them.
    # This prevents bold job titles / company names from being misclassified as
    # section boundaries when the CV uses the same font style for headings and content.
    filtered_indices: List[Tuple[int, str]] = []
    for pos, (h_idx, h_type) in enumerate(heading_indices):
        if h_type != "other":
            # Keyword-matched heading — always keep
            filtered_indices.append((h_idx, h_type))
            continue

        next_h = (
            heading_indices[pos + 1][0] if pos + 1 < len(heading_indices)
            else len(paragraphs)
        )
        # Sample up to 5 non-empty content paragraphs after this candidate
        content_paras = [
            p for p in paragraphs[h_idx + 1 : min(h_idx + 6, next_h)]
            if (p.text or "").strip()
        ]
        if not content_paras:
            # Nothing follows — keep it (could be last heading)
            filtered_indices.append((h_idx, h_type))
            continue

        heading_score = _get_paragraph_prominence(paragraphs[h_idx])
        max_content_score = max(_get_paragraph_prominence(p) for p in content_paras)

        if heading_score > max_content_score:
            filtered_indices.append((h_idx, h_type))
        # else: content has equal or higher prominence — discard this false-positive heading

    heading_indices = filtered_indices

    # Everything before the first heading = "header"
    first_heading_idx = heading_indices[0][0] if heading_indices else len(paragraphs)
    if first_heading_idx > 0:
        header = Section(section_type="header")
        header.paragraph_indices = list(range(0, first_heading_idx))
        sections.append(header)

    # Each heading starts a new section, ending at the next heading
    for pos, (h_idx, h_type) in enumerate(heading_indices):
        next_idx = (
            heading_indices[pos + 1][0] if pos + 1 < len(heading_indices)
            else len(paragraphs)
        )
        section = Section(
            section_type=h_type,
            heading_idx=h_idx,
            paragraph_indices=list(range(h_idx + 1, next_idx)),
        )
        sections.append(section)

    return sections


def _get_paragraph_prominence(para) -> float:
    """Score a paragraph's visual prominence (higher = more prominent)."""
    score = 0.0
    runs = para.runs
    if not runs:
        return 0.0

    for run in runs:
        if run.bold:
            score += 2.0
        if run.font.size:
            # Convert EMU to points (1 pt = 12700 EMU)
            pt_size = run.font.size / 12700.0
            score += pt_size * 0.5
        else:
            score += 5.5  # default ~11pt

    return score


# ============================================================================
# RUN MERGING
# ============================================================================

def _merge_split_runs(paragraph):
    """Merge adjacent runs with identical formatting.

    Word often splits text across multiple ``<w:r>`` elements even when
    they share the same formatting (due to spell-check, tracked changes,
    or arbitrary XML splitting). This makes text replacement unreliable.

    After merging, ``"Joh" + "n Doe"`` becomes a single run ``"John Doe"``.
    """
    runs = paragraph.runs
    if len(runs) <= 1:
        return

    i = 0
    while i < len(runs) - 1:
        current = runs[i]
        next_run = runs[i + 1]

        if _runs_have_same_format(current, next_run):
            # Merge: append next's text to current, remove next from XML
            current.text = (current.text or "") + (next_run.text or "")
            next_run._element.getparent().remove(next_run._element)
            # Re-fetch runs since the list changed
            runs = paragraph.runs
        else:
            i += 1


def _runs_have_same_format(r1, r2) -> bool:
    """Check if two runs share the same formatting properties."""
    if r1.bold != r2.bold:
        return False
    if r1.italic != r2.italic:
        return False
    if r1.underline != r2.underline:
        return False

    # Font name
    f1 = r1.font.name or ""
    f2 = r2.font.name or ""
    if f1 != f2:
        return False

    # Font size
    s1 = r1.font.size
    s2 = r2.font.size
    if s1 != s2:
        return False

    # Color
    c1 = r1.font.color.rgb if r1.font.color and r1.font.color.rgb else None
    c2 = r2.font.color.rgb if r2.font.color and r2.font.color.rgb else None
    if c1 != c2:
        return False

    return True


# ============================================================================
# HEADER SECTION TAGGING
# ============================================================================

def _tag_header_section(paragraphs, section: Section) -> List[TagReplacement]:
    """Tag the header section (before any heading).

    Strategy:
      - Most prominent (biggest/boldest) paragraph → ``{{ full_name }}``
      - Second most prominent → ``{{ current_position }}``
      - Regex-detected email → ``{{ email }}``
      - Regex-detected phone → ``{{ phone }}``
      - Longer text (>60 chars) → ``{{ professional_summary }}``
      - Remaining short text → ``{{ address }}``
    """
    replacements: List[TagReplacement] = []
    if not section.paragraph_indices:
        return replacements

    # Score each paragraph by prominence
    scored: List[Tuple[int, float, str]] = []
    for idx in section.paragraph_indices:
        para = paragraphs[idx]
        text = (para.text or "").strip()
        if not text:
            continue
        prominence = _get_paragraph_prominence(para)
        scored.append((idx, prominence, text))

    if not scored:
        return replacements

    # Sort by prominence (descending)
    scored.sort(key=lambda x: x[1], reverse=True)

    tagged_para_indices: set = set()

    # --- Regex pass first (email, phone) ---
    for idx, _, text in scored:
        if _EMAIL_RE.search(text):
            # Replace just the email part
            email_match = _EMAIL_RE.search(text)
            if email_match and email_match.group() == text.strip():
                replacements.append(TagReplacement(idx, text, "{{ email }}"))
                tagged_para_indices.add(idx)
            elif email_match:
                replacements.append(
                    TagReplacement(idx, email_match.group(), "{{ email }}")
                )
                tagged_para_indices.add(idx)

        if _PHONE_RE.search(text) and idx not in tagged_para_indices:
            phone_match = _PHONE_RE.search(text)
            if phone_match:
                matched = phone_match.group().strip()
                # Only tag if it looks like a real phone (at least 7 digits)
                digits = re.sub(r"\D", "", matched)
                if len(digits) >= 7:
                    if matched == text.strip():
                        replacements.append(TagReplacement(idx, text, "{{ phone }}"))
                    else:
                        replacements.append(TagReplacement(idx, matched, "{{ phone }}"))
                    tagged_para_indices.add(idx)

    # --- Prominence-based assignment ---
    name_assigned = False
    position_assigned = False

    for idx, prominence, text in scored:
        if idx in tagged_para_indices:
            continue

        # Skip very long text for name/position (it's probably a summary)
        if len(text) > 100:
            replacements.append(TagReplacement(idx, text, "{{ professional_summary }}"))
            tagged_para_indices.add(idx)
            continue

        if not name_assigned:
            replacements.append(TagReplacement(idx, text, "{{ full_name }}"))
            tagged_para_indices.add(idx)
            name_assigned = True
            continue

        if not position_assigned:
            replacements.append(TagReplacement(idx, text, "{{ current_position }}"))
            tagged_para_indices.add(idx)
            position_assigned = True
            continue

        # Remaining untagged header paragraphs → address
        if len(text) < 80:
            replacements.append(TagReplacement(idx, text, "{{ address }}"))
            tagged_para_indices.add(idx)

    return replacements


# ============================================================================
# SUMMARY SECTION TAGGING
# ============================================================================

def _tag_summary_section(paragraphs, section: Section) -> List[TagReplacement]:
    """Tag the summary/profile section with ``{{ professional_summary }}``."""
    replacements: List[TagReplacement] = []
    for idx in section.paragraph_indices:
        text = (paragraphs[idx].text or "").strip()
        if text and len(text) > 10:
            replacements.append(TagReplacement(idx, text, "{{ professional_summary }}"))
            break  # Only tag the first substantial paragraph
    return replacements


# ============================================================================
# SKILLS SECTION TAGGING
# ============================================================================

def _tag_skills_section(paragraphs, section: Section) -> List[TagReplacement]:
    """Tag the skills section.

    If it's a single paragraph (comma-separated list), replace with a join.
    If it's bullet points, wrap with a for-loop.
    """
    replacements: List[TagReplacement] = []
    content_indices = [
        idx for idx in section.paragraph_indices
        if (paragraphs[idx].text or "").strip()
    ]

    if not content_indices:
        return replacements

    if len(content_indices) == 1:
        # Single paragraph — replace entire text with joined skills
        idx = content_indices[0]
        text = paragraphs[idx].text.strip()
        replacements.append(
            TagReplacement(idx, text, "{{ skills | join(\", \") }}")
        )
    else:
        # Multiple paragraphs (bullet points) — replace first with for-loop,
        # delete the rest (handled by _inject_skills_loop)
        idx = content_indices[0]
        text = paragraphs[idx].text.strip()
        replacements.append(TagReplacement(idx, text, "{{ skill }}"))
        # Mark remaining for deletion (will be handled separately)

    return replacements


# ============================================================================
# CONTACT SECTION TAGGING
# ============================================================================

def _tag_contact_section(paragraphs, section: Section) -> List[TagReplacement]:
    """Tag a dedicated contact section with regex + rules."""
    replacements: List[TagReplacement] = []
    tagged: set = set()

    for idx in section.paragraph_indices:
        text = (paragraphs[idx].text or "").strip()
        if not text:
            continue

        if _EMAIL_RE.search(text) and idx not in tagged:
            email = _EMAIL_RE.search(text).group()
            if email == text:
                replacements.append(TagReplacement(idx, text, "{{ email }}"))
            else:
                replacements.append(TagReplacement(idx, email, "{{ email }}"))
            tagged.add(idx)
            continue

        if _PHONE_RE.search(text) and idx not in tagged:
            phone_match = _PHONE_RE.search(text)
            phone = phone_match.group().strip()
            digits = re.sub(r"\D", "", phone)
            if len(digits) >= 7:
                placeholder_match = _PHONE_PLACEHOLDER_RE.search(text)
                if placeholder_match:
                    replacements.append(TagReplacement(idx, placeholder_match.group(), "{{ phone }}"))
                elif phone == text:
                    replacements.append(TagReplacement(idx, text, "{{ phone }}"))
                else:
                    replacements.append(TagReplacement(idx, phone, "{{ phone }}"))
                tagged.add(idx)
                continue

        # Remaining → address
        if idx not in tagged and len(text) < 100:
            replacements.append(TagReplacement(idx, text, "{{ address }}"))
            tagged.add(idx)

    return replacements


# ============================================================================
# REGEX PASS (catches anything missed across all paragraphs)
# ============================================================================

def _tag_with_regex(paragraphs, already_tagged: set) -> List[TagReplacement]:
    """Scan all paragraphs for regex-matchable patterns."""
    replacements: List[TagReplacement] = []

    for i, para in enumerate(paragraphs):
        if i in already_tagged:
            continue
        text = (para.text or "").strip()
        if not text:
            continue

        # Email
        m = _EMAIL_RE.search(text)
        if m:
            replacements.append(TagReplacement(i, m.group(), "{{ email }}"))
            already_tagged.add(i)
            continue

        # Phone
        m = _PHONE_RE.search(text)
        if m:
            phone = m.group().strip()
            digits = re.sub(r"\D", "", phone)
            if len(digits) >= 7:
                placeholder_match = _PHONE_PLACEHOLDER_RE.search(text)
                if placeholder_match:
                    replacements.append(TagReplacement(i, placeholder_match.group(), "{{ phone }}"))
                else:
                    replacements.append(TagReplacement(i, phone, "{{ phone }}"))
                already_tagged.add(i)

    return replacements


# ============================================================================
# APPLY REPLACEMENTS
# ============================================================================

def _apply_replacements(paragraphs, replacements: List[TagReplacement]):
    """Apply all collected text replacements to the document."""
    for rep in replacements:
        para = paragraphs[rep.para_idx]
        _replace_text_in_paragraph(para, rep.old_text, rep.new_text)


def _replace_text_in_paragraph(paragraph, old_text: str, new_text: str):
    """Replace ``old_text`` with ``new_text`` in a paragraph's runs.

    Preserves all XML formatting of the run(s) containing the text.
    """
    # Try simple per-run replacement first
    for run in paragraph.runs:
        if old_text in (run.text or ""):
            run.text = run.text.replace(old_text, new_text, 1)
            return

    # Cross-run replacement: the old_text may span multiple runs
    full_text = paragraph.text or ""
    if old_text not in full_text:
        logger.debug(
            "Could not find '%s' in paragraph '%s'", old_text[:40], full_text[:40]
        )
        return

    # Find the start position in the concatenated text
    start_pos = full_text.index(old_text)
    end_pos = start_pos + len(old_text)

    # Map character positions to runs
    char_offset = 0
    for run in paragraph.runs:
        run_text = run.text or ""
        run_start = char_offset
        run_end = char_offset + len(run_text)

        if run_start >= end_pos:
            break

        if run_end <= start_pos:
            char_offset = run_end
            continue

        # This run overlaps with the target text
        overlap_start = max(start_pos, run_start) - run_start
        overlap_end = min(end_pos, run_end) - run_start

        before = run_text[:overlap_start]
        after = run_text[overlap_end:]

        if run_start <= start_pos:
            # First run containing the match: insert replacement here
            run.text = before + new_text + after
        else:
            # Subsequent runs: remove the overlapping portion
            run.text = after

        char_offset = run_end


# ============================================================================
# FOR-LOOP INJECTION (repeating sections)
# ============================================================================

def _inject_for_loop(doc, paragraphs, section: Section):
    """Inject ``{% for %}`` / ``{% endfor %}`` around repeating sections.

    Strategy:
      1. Detect entry boundaries using the "title paragraph" heuristic.
      2. Tag the first entry's content with field tags.
      3. Wrap the first entry with for/endfor.
      4. Delete subsequent dummy entries.
    """
    config = _LOOP_CONFIG.get(section.section_type)
    if not config or not section.paragraph_indices:
        return

    content_indices = [
        idx for idx in section.paragraph_indices
        if (paragraphs[idx].text or "").strip()
    ]
    if not content_indices:
        return

    # --- Detect entry boundaries ---
    entries = _detect_entry_boundaries(paragraphs, content_indices)

    if not entries:
        return

    logger.info(
        "Section '%s': detected %d entries (keeping first, deleting rest)",
        section.section_type,
        len(entries),
    )

    first_entry = entries[0]

    first_entry = entries[0]

    # --- Insert outer {% for %} before the first paragraph of the first entry ---
    first_para = paragraphs[first_entry[0]]
    var_name = config["var"]
    list_key = config["list_key"]
    _insert_paragraph_before(
        first_para, f"{{%p for {var_name} in {list_key} %}}"
    )

    # --- Insert outer {% endfor %} after the last paragraph of the first entry ---
    last_para = paragraphs[first_entry[-1]]
    _insert_paragraph_after(last_para, "{%p endfor %}")

    # --- Tag the internal entry contents (this inserts {% if %} blocks INSIDE the outer {% for %}) ---
    _tag_entry_content(paragraphs, first_entry, section.section_type, config)

    # --- Delete all subsequent entries ---
    for entry in entries[1:]:
        for idx in entry:
            _remove_paragraph(paragraphs[idx])

    # --- Sweep out trailing empty paragraphs within the section block ---
    # Dummy templates often inject empty lines between fake entries. Since we delete the fake entries,
    # the empty lines stack up at the bottom of the section creating massive vertical whitespace gaps.
    last_valid_idx = first_entry[-1]
    for idx in section.paragraph_indices:
        if idx > last_valid_idx and idx not in [i for e in entries[1:] for i in e]:
            para = paragraphs[idx]
            if not (para.text or "").strip():
                _remove_paragraph(para)


def _inject_skills_loop(doc, paragraphs, section: Section):
    """Wrap bullet point skills in a simple string for-loop."""
    content_indices = [idx for idx in section.paragraph_indices if (paragraphs[idx].text or "").strip()]
    if len(content_indices) < 2:
        return

    first_idx = content_indices[0]
    first_para = paragraphs[first_idx]

    _insert_paragraph_before(first_para, "{%p for skill in skills %}")
    _insert_paragraph_after(first_para, "{%p endfor %}")

    # Remove the rest of the bullet points
    for idx in content_indices[1:]:
        _remove_paragraph(paragraphs[idx])

    # Sweep trailing empty paragraphs
    for idx in section.paragraph_indices:
        if idx > first_idx and idx not in content_indices:
            para = paragraphs[idx]
            if not (para.text or "").strip():
                _remove_paragraph(para)


def _detect_entry_boundaries(
    paragraphs, content_indices: List[int]
) -> List[List[int]]:
    """Detect repeating entry boundaries within a section.

    Heuristic: each entry starts with a "title-like" paragraph that shares
    the same formatting characteristics as the first paragraph.
    """
    if not content_indices:
        return []

    first_idx = content_indices[0]
    first_para = paragraphs[first_idx]
    first_bold = any(r.bold for r in first_para.runs if r.text.strip())
    first_size = None
    for r in first_para.runs:
        if r.font.size:
            first_size = r.font.size
            break

    entries: List[List[int]] = []
    current_entry: List[int] = []

    for idx in content_indices:
        para = paragraphs[idx]
        text = (para.text or "").strip()
        if not text:
            continue

        is_boundary = False

        if idx == first_idx:
            is_boundary = True
        else:
            # Check if this paragraph looks like the start of a new entry
            para_bold = any(r.bold for r in para.runs if r.text.strip())
            para_size = None
            for r in para.runs:
                if r.font.size:
                    para_size = r.font.size
                    break

            # Same formatting as the first paragraph = new entry boundary
            same_dummy_text = (first_para.text.strip().lower() == para.text.strip().lower() and len(para.text.strip()) > 3)
            
            if same_dummy_text:
                if len(current_entry) >= 2:
                    is_boundary = True
            elif first_bold and para_bold:
                if first_size is None or para_size is None or first_size == para_size:
                    # Only if we've accumulated some content (not just consecutive titles)
                    if len(current_entry) >= 2:
                        is_boundary = True

        if is_boundary and current_entry:
            entries.append(current_entry)
            current_entry = [idx]
        else:
            current_entry.append(idx)

    if current_entry:
        entries.append(current_entry)

    return entries


def _tag_entry_content(
    paragraphs,
    entry_indices: List[int],
    section_type: str,
    config: dict,
):
    """Replace dummy text in one entry's paragraphs with Jinja2 field tags."""
    fields = config["fields"]
    var = config["var"]

    if not entry_indices:
        return

    # --- Classify each paragraph in the entry ---
    title_tagged = False
    date_tagged = False
    company_tagged = False
    desc_tagged = False

    placeholder_desc_indices = [
        idx for idx in entry_indices
        if _PLACEHOLDER_TEXT_RE.search((paragraphs[idx].text or "").strip())
    ]
    bullet_indices = [
        idx for idx in entry_indices
        if _is_bullet_paragraph(paragraphs[idx]) and (paragraphs[idx].text or "").strip()
    ]

    # Optional LLM classification (always on for experience/education).
    llm_labels: Dict[int, str] = {}
    forced_desc_indices = bullet_indices or placeholder_desc_indices
    if ALWAYS_USE_LLM_ENTRY_TAGGING and section_type in LLM_ENTRY_SECTIONS:
        entry_indices_for_llm = [
            idx for idx in entry_indices if idx not in forced_desc_indices
        ]
        llm_labels = _classify_entry_with_ai(section_type, paragraphs, entry_indices_for_llm)

    used_by_llm: set[int] = set()
    if forced_desc_indices and section_type in {"experience", "projects"}:
        if bullet_indices and _apply_bullet_lines_loop(
            paragraphs,
            bullet_indices,
            f"{var}.description_lines",
        ):
            desc_tagged = True
            used_by_llm.update(bullet_indices)
        elif placeholder_desc_indices and _apply_description_lines_loop(
            paragraphs,
            placeholder_desc_indices,
            f"{var}.description_lines",
        ):
            desc_tagged = True
            used_by_llm.update(placeholder_desc_indices)

    for idx in entry_indices:
        para = paragraphs[idx]
        text = (para.text or "").strip()
        if not text:
            continue

        if idx in llm_labels:
            label = llm_labels.get(idx)
            if not label or label == "skip":
                # Fall back to rule-based tagging.
                label = None
            if section_type == "experience":
                company_key = fields.get("company", f"{var}.companyName")
                title_key = fields.get("title", f"{var}.jobTitle")
                desc_key = fields.get("description", f"{var}.description")

                # Combined placeholder line should always map to company + title.
                if _PLACEHOLDER_COMPANY_ROLE_RE.search(text):
                    separator = " / " if "/" in text else " - "
                    combined = (
                        f"{{{{ {company_key} }}}}"
                        f"{{% if {company_key} and {title_key} %}}{separator}{{% endif %}}"
                        f"{{{{ {title_key} }}}}"
                    )
                    _replace_text_in_paragraph(para, text, combined)
                    _insert_paragraph_before(para, f"{{%p if {company_key} or {title_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    title_tagged = True
                    company_tagged = True
                    used_by_llm.add(idx)
                    continue

                if label in {"company_title", "title_company", "company_role"}:
                    separator = " / " if "/" in text else " - "
                    combined = (
                        f"{{{{ {company_key} }}}}"
                        f"{{% if {company_key} and {title_key} %}}{separator}{{% endif %}}"
                        f"{{{{ {title_key} }}}}"
                    )
                    _replace_text_in_paragraph(para, text, combined)
                    _insert_paragraph_before(para, f"{{%p if {company_key} or {title_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    title_tagged = True
                    company_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label == "title":
                    _replace_text_in_paragraph(para, text, f"{{{{ {title_key} }}}}")
                    _insert_paragraph_before(para, f"{{%p if {title_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    title_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label == "company":
                    _replace_text_in_paragraph(para, text, f"{{{{ {company_key} }}}}")
                    _insert_paragraph_before(para, f"{{%p if {company_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    company_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label == "dates":
                    if date_tagged:
                        _remove_paragraph(para)
                        used_by_llm.add(idx)
                        continue
                    start_var = fields.get('start_date', var + '.startDate')
                    end_var = fields.get('end_date', var + '.endDate')
                    date_text = _build_date_line(text, start_var, end_var)
                    _replace_text_in_paragraph(para, text, date_text)
                    _insert_paragraph_before(para, f"{{%p if {start_var} or {end_var} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    date_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label == "description":
                    if idx in bullet_indices and _apply_bullet_lines_loop(
                        paragraphs,
                        bullet_indices,
                        f"{var}.description_lines",
                    ):
                        desc_tagged = True
                        used_by_llm.update(bullet_indices)
                    elif idx in placeholder_desc_indices and _apply_description_lines_loop(
                        paragraphs,
                        placeholder_desc_indices,
                        f"{var}.description_lines",
                    ):
                        desc_tagged = True
                        used_by_llm.update(placeholder_desc_indices)
                    else:
                        _replace_text_in_paragraph(para, text, f"{{{{ {desc_key} }}}}")
                        _insert_paragraph_before(para, f"{{%p if {desc_key} %}}")
                        _insert_paragraph_after(para, "{%p endif %}")
                        desc_tagged = True
                        used_by_llm.add(idx)
                    continue

            if section_type == "education":
                degree_key = fields.get("title", f"{var}.degree")
                institution_key = fields.get("institution", f"{var}.institution")
                field_key = fields.get("field", f"{var}.fieldOfStudy")
                if label in {"degree", "title"}:
                    _replace_text_in_paragraph(para, text, f"{{{{ {degree_key} }}}}")
                    _insert_paragraph_before(para, f"{{%p if {degree_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    title_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label in {"institution", "school"}:
                    _replace_text_in_paragraph(para, text, f"{{{{ {institution_key} }}}}")
                    _insert_paragraph_before(para, f"{{%p if {institution_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    company_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label in {"field", "major"}:
                    _replace_text_in_paragraph(para, text, f"{{{{ {field_key} }}}}")
                    _insert_paragraph_before(para, f"{{%p if {field_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    desc_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label in {"dates", "date", "year"}:
                    if date_tagged:
                        _remove_paragraph(para)
                        used_by_llm.add(idx)
                        continue
                    start_var = fields.get('start_date', var + '.startDate')
                    end_var = fields.get('end_date', var + '.endDate')
                    date_text = _build_date_line(text, start_var, end_var)
                    _replace_text_in_paragraph(para, text, date_text)
                    _insert_paragraph_before(para, f"{{%p if {start_var} or {end_var} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    date_tagged = True
                    used_by_llm.add(idx)
                    continue

            if section_type == "certifications":
                name_key = fields.get("title", f"{var}.name")
                issuer_key = fields.get("issuer", f"{var}.issuingOrganization")
                credential_key = fields.get("credential", f"{var}.credentialId")
                date_key = fields.get("date", f"{var}.issueDate")

                if label in {"name", "title", "certification"}:
                    _replace_text_in_paragraph(para, text, f"{{{{ {name_key} }}}}")
                    _insert_paragraph_before(para, f"{{%p if {name_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    title_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label in {"issuer", "organization", "organisation"}:
                    _replace_text_in_paragraph(para, text, f"{{{{ {issuer_key} }}}}")
                    _insert_paragraph_before(para, f"{{%p if {issuer_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    company_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label in {"credential", "id", "license", "licence"}:
                    _replace_text_in_paragraph(para, text, f"{{{{ {credential_key} }}}}")
                    _insert_paragraph_before(para, f"{{%p if {credential_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    desc_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label in {"dates", "date", "issued", "issue_date", "year"}:
                    if date_tagged:
                        _remove_paragraph(para)
                        used_by_llm.add(idx)
                        continue
                    _replace_text_in_paragraph(para, text, f"{{{{ {date_key} }}}}")
                    _insert_paragraph_before(para, f"{{%p if {date_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    date_tagged = True
                    used_by_llm.add(idx)
                    continue

            if section_type == "projects":
                title_key = fields.get("title", f"{var}.displayTitle")
                role_key = fields.get("role", f"{var}.role")
                client_key = fields.get("client", f"{var}.client")
                desc_key = fields.get("description", f"{var}.description")
                skills_key = f"{var}.skills"

                if label in {"name", "title", "project"}:
                    _replace_text_in_paragraph(para, text, f"{{{{ {title_key} }}}}")
                    _insert_paragraph_before(para, f"{{%p if {title_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    title_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label in {"role", "position"}:
                    _replace_text_in_paragraph(para, text, f"{{{{ {role_key} }}}}")
                    _insert_paragraph_before(para, f"{{%p if {role_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    company_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label in {"client", "company"}:
                    _replace_text_in_paragraph(para, text, f"{{{{ {client_key} }}}}")
                    _insert_paragraph_before(para, f"{{%p if {client_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    company_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label in {"dates", "date", "year"}:
                    if date_tagged:
                        _remove_paragraph(para)
                        used_by_llm.add(idx)
                        continue
                    start_var = fields.get('start_date', var + '.startDate')
                    end_var = fields.get('end_date', var + '.endDate')
                    date_text = _build_date_line(text, start_var, end_var)
                    _replace_text_in_paragraph(para, text, date_text)
                    _insert_paragraph_before(para, f"{{%p if {start_var} or {end_var} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    date_tagged = True
                    used_by_llm.add(idx)
                    continue
                if label in {"description"}:
                    if idx in bullet_indices and _apply_bullet_lines_loop(
                        paragraphs,
                        bullet_indices,
                        f"{var}.description_lines",
                    ):
                        desc_tagged = True
                        used_by_llm.update(bullet_indices)
                    elif idx in placeholder_desc_indices and _apply_description_lines_loop(
                        paragraphs,
                        placeholder_desc_indices,
                        f"{var}.description_lines",
                    ):
                        desc_tagged = True
                        used_by_llm.update(placeholder_desc_indices)
                    else:
                        _replace_text_in_paragraph(para, text, f"{{{{ {desc_key} }}}}")
                        _insert_paragraph_before(para, f"{{%p if {desc_key} %}}")
                        _insert_paragraph_after(para, "{%p endif %}")
                        desc_tagged = True
                        used_by_llm.add(idx)
                    continue
                if label in {"skills", "tech", "stack"}:
                    _replace_text_in_paragraph(para, text, f"{{{{ {skills_key} | join(', ') }}}}")
                    _insert_paragraph_before(para, f"{{%p if {skills_key} %}}")
                    _insert_paragraph_after(para, "{%p endif %}")
                    desc_tagged = True
                    used_by_llm.add(idx)
                    continue
            # If LLM provided a label we didn't apply, fall back to rule-based tagging.

        if idx in used_by_llm:
            continue

        # Check for date range
        if (_DATE_RANGE_RE.search(text) or _DATE_PLACEHOLDER_RE.search(text)) and not date_tagged:
            # Replace the entire text with start_date - end_date tags
            start_var = fields.get('start_date', var + '.startDate')
            end_var = fields.get('end_date', var + '.endDate')
            date_text = _build_date_line(text, start_var, end_var)
            _replace_text_in_paragraph(para, text, date_text)
            
            # Collapse paragraph natively if both dates missing
            date_cond = f"{start_var} or {end_var}"
            _insert_paragraph_before(para, f"{{%p if {date_cond} %}}")
            _insert_paragraph_after(para, "{%p endif %}")
            
            date_tagged = True
            continue

        if date_tagged and (_DATE_RANGE_RE.search(text) or _DATE_PLACEHOLDER_RE.search(text)):
            _remove_paragraph(para)
            continue

        # Combined company/role placeholder (e.g., "Nom de l'entreprise/Fonction")
        if section_type == "experience" and _PLACEHOLDER_COMPANY_ROLE_RE.search(text):
            company_key = fields.get("company", f"{var}.companyName")
            title_key = fields.get("title", f"{var}.jobTitle")
            separator = " / " if "/" in text else " - "
            combined = (
                f"{{{{ {company_key} }}}}"
                f"{{% if {company_key} and {title_key} %}}{separator}{{% endif %}}"
                f"{{{{ {title_key} }}}}"
            )
            _replace_text_in_paragraph(para, text, combined)
            _insert_paragraph_before(para, f"{{%p if {company_key} or {title_key} %}}")
            _insert_paragraph_after(para, "{%p endif %}")
            title_tagged = True
            company_tagged = True
            continue

        # First prominent paragraph → title
        if not title_tagged:
            is_bold = any(r.bold for r in para.runs if r.text.strip())
            if is_bold or idx == entry_indices[0]:
                title_key = fields.get("title", f"{var}.name")
                _replace_text_in_paragraph(
                    para, text, f"{{{{ {title_key} }}}}"
                )
                _insert_paragraph_before(para, f"{{%p if {title_key} %}}")
                _insert_paragraph_after(para, "{%p endif %}")
                title_tagged = True
                continue

        # Company / institution (short, non-bullet text)
        if not company_tagged and len(text) < 80 and not text.startswith(("•", "-", "–")):
            if section_type == "experience":
                key = fields.get("company", f"{var}.companyName")
            elif section_type == "education":
                key = fields.get("institution", f"{var}.institution")
            elif section_type == "certifications":
                key = fields.get("issuer", f"{var}.issuingOrganization")
            elif section_type == "projects":
                key = fields.get("client", f"{var}.client")
            else:
                key = f"{var}.detail"
            _replace_text_in_paragraph(para, text, f"{{{{ {key} }}}}")
            _insert_paragraph_before(para, f"{{%p if {key} %}}")
            _insert_paragraph_after(para, "{%p endif %}")
            company_tagged = True
            continue

        # Description (longer text or bullet points)
        if not desc_tagged:
            desc_key = fields.get("description", f"{var}.description")
            if idx in bullet_indices and _apply_bullet_lines_loop(
                paragraphs,
                bullet_indices,
                f"{var}.description_lines",
            ):
                desc_tagged = True
                continue
            if idx in placeholder_desc_indices and _apply_description_lines_loop(
                paragraphs,
                placeholder_desc_indices,
                f"{var}.description_lines",
            ):
                desc_tagged = True
                continue
            _replace_text_in_paragraph(para, text, f"{{{{ {desc_key} }}}}")
            _insert_paragraph_before(para, f"{{%p if {desc_key} %}}")
            _insert_paragraph_after(para, "{%p endif %}")
            desc_tagged = True
            continue

        # Remove extra placeholder lines after description is tagged.
        if desc_tagged and _PLACEHOLDER_TEXT_RE.search(text):
            _remove_paragraph(para)


# ============================================================================
# XML PARAGRAPH MANIPULATION
# ============================================================================

def _should_skip_conditional_tag(text: str) -> bool:
    if _tagger_enable_conditionals():
        return False
    stripped = (text or "").strip()
    if not stripped.startswith("{%"):
        return False
    return (
        stripped.startswith("{%p if")
        or stripped.startswith("{%p else")
        or stripped.startswith("{%p endif")
        or stripped.startswith("{% if")
        or stripped.startswith("{% else")
        or stripped.startswith("{% endif")
    )


def _insert_paragraph_before(paragraph, text: str):
    """Insert a new paragraph containing ``text`` before the given paragraph."""
    if _should_skip_conditional_tag(text):
        return
    new_p = OxmlElement("w:p")
    new_r = OxmlElement("w:r")
    new_t = OxmlElement("w:t")
    new_t.text = text
    # Preserve spaces
    new_t.set(qn("xml:space"), "preserve")
    new_r.append(new_t)
    new_p.append(new_r)
    paragraph._element.addprevious(new_p)


def _insert_paragraph_after(paragraph, text: str):
    """Insert a new paragraph containing ``text`` after the given paragraph."""
    if _should_skip_conditional_tag(text):
        return
    new_p = OxmlElement("w:p")
    new_r = OxmlElement("w:r")
    new_t = OxmlElement("w:t")
    new_t.text = text
    new_t.set(qn("xml:space"), "preserve")
    new_r.append(new_t)
    new_p.append(new_r)
    paragraph._element.addnext(new_p)


def _remove_paragraph(paragraph):
    """Remove a paragraph from the document, preserving structural section breaks."""
    p = paragraph._element
    
    # If the paragraph contains section properties (e.g. continuous section breaks for columns),
    # deleting the <w:p> would shatter the layout flow and force a hard page-break.
    # We must only clear its contents.
    if p.xpath('.//w:sectPr'):
        logger.info("[DEBUG] Preserving empty paragraph because it contains <w:sectPr> structural layout")
        for r in paragraph.runs:
            r._element.getparent().remove(r._element)
        return

    parent = p.getparent()
    if parent is not None:
        parent.remove(p)


# ============================================================================
# AI / LLM FALLBACK (optional — for ambiguous classification)
# ============================================================================

def _classify_with_ai(snippets: List[Dict[str, Any]]) -> Dict[int, str]:
    """Send ambiguous text snippets to the local LLM for classification.

    Args:
        snippets: List of dicts with ``id``, ``text``, ``section``, ``is_bold``.

    Returns:
        Dict mapping snippet ``id`` to a tag name (e.g. ``"full_name"``).
    """
    if not snippets:
        return {}

    try:
        from app.config import settings
        from app.utils.llm import parse_json_object, resolve_llm_model
        from langchain_ollama import ChatOllama
        from langchain_core.messages import SystemMessage, HumanMessage

        model = (settings.TRANSLATION_MODEL or "").strip() or resolve_llm_model()
        llm = ChatOllama(
            model=model,
            base_url=settings.OLLAMA_URL,
            temperature=0.0,
            disable_streaming=True,
        )

        snippet_lines = []
        for s in snippets:
            snippet_lines.append(
                f"  {s['id']}: \"{s['text'][:100]}\" "
                f"(section={s.get('section', '?')}, bold={s.get('is_bold', '?')})"
            )

        prompt = (
            "You are analyzing a CV/resume template. Classify each text snippet below.\n"
            "For each ID, return the most appropriate tag name from this list:\n"
            "  full_name, current_position, email, phone, address,\n"
            "  professional_summary, total_experience_years, SKIP\n\n"
            "Snippets:\n" + "\n".join(snippet_lines) + "\n\n"
            "Return ONLY a JSON object like {\"1\": \"full_name\", \"2\": \"address\"}."
        )

        response = llm.invoke([
            SystemMessage(content="You are a CV template analysis assistant."),
            HumanMessage(content=prompt),
        ])
        content = str(getattr(response, "content", "") or "").strip()
        result = parse_json_object(content)

        if isinstance(result, dict):
            return {int(k): v for k, v in result.items() if v != "SKIP"}

    except Exception as exc:
        logger.warning("AI classification failed (non-fatal): %s", exc)

    return {}


def _classify_entry_with_ai(
    section_type: str,
    paragraphs,
    entry_indices: List[int],
) -> Dict[int, str]:
    """Classify each paragraph in a section entry using the LLM."""
    if section_type not in {"experience", "education"}:
        return {}

    snippets: List[Dict[str, Any]] = []
    for idx in entry_indices:
        para = paragraphs[idx]
        text = (para.text or "").strip()
        if not text:
            continue
        is_bold = any(r.bold for r in para.runs if r.text.strip())
        snippets.append({"id": idx, "text": text, "is_bold": is_bold})

    if not snippets:
        return {}

    if section_type == "experience":
        allowed = {
            "title",
            "company",
            "dates",
            "description",
            "company_title",
            "title_company",
            "company_role",
            "location",
            "skip",
        }
    elif section_type == "education":
        allowed = {
            "degree",
            "title",
            "institution",
            "school",
            "field",
            "major",
            "dates",
            "date",
            "year",
            "skip",
        }
    elif section_type == "certifications":
        allowed = {
            "name",
            "title",
            "certification",
            "issuer",
            "organization",
            "organisation",
            "credential",
            "id",
            "license",
            "licence",
            "dates",
            "date",
            "issue_date",
            "issued",
            "year",
            "skip",
        }
    else:
        allowed = {
            "name",
            "title",
            "project",
            "role",
            "position",
            "client",
            "company",
            "dates",
            "date",
            "year",
            "description",
            "skills",
            "tech",
            "stack",
            "skip",
        }

    prompt_lines = []
    for s in snippets:
        prompt_lines.append(
            f'  {s["id"]}: "{s["text"][:120]}" (bold={s["is_bold"]})'
        )

    prompt = (
        "You are labeling lines inside a CV template entry.\n"
        f"Section type: {section_type}\n"
        "Choose a label for each line from this list:\n"
        f"{sorted(allowed)}\n\n"
        "Guidelines:\n"
        "- Title/degree lines are short and describe role/degree.\n"
        "- Company/institution lines are organization names.\n"
        "- Dates lines contain ranges, months, years, or words like AUJOURD'HUI/PRESENT/CURRENT.\n"
        "- Description lines are longer sentences.\n"
        "- Use company_title/title_company when a line combines both.\n"
        "- Use skip for separators or decorative lines.\n\n"
        "Lines:\n" + "\n".join(prompt_lines) + "\n\n"
        "Return ONLY a JSON object like {\"12\": \"title\", \"13\": \"company\"}."
    )

    try:
        from app.config import settings
        from app.utils.llm import parse_json_object, resolve_llm_model
        from langchain_ollama import ChatOllama
        from langchain_core.messages import SystemMessage, HumanMessage

        model = (settings.TRANSLATION_MODEL or "").strip() or resolve_llm_model()
        llm = ChatOllama(
            model=model,
            base_url=settings.OLLAMA_URL,
            temperature=0.0,
            disable_streaming=True,
        )

        response = llm.invoke(
            [
                SystemMessage(content="You are a CV template labeling assistant."),
                HumanMessage(content=prompt),
            ]
        )
        content = str(getattr(response, "content", "") or "").strip()
        result = parse_json_object(content)
        if not isinstance(result, dict):
            return {}

        label_aliases = {
            "companyname": "company",
            "employer": "company",
            "organisation": "company",
            "organization": "company",
            "role": "title",
            "job": "title",
            "position": "title",
            "dates_range": "dates",
            "date_range": "dates",
            "school_name": "institution",
            "university": "institution",
            "college": "institution",
        }

        normalized: Dict[int, str] = {}
        for key, value in result.items():
            try:
                idx = int(key)
            except Exception:
                continue
            label = str(value or "").strip().lower()
            label = label_aliases.get(label, label)
            if label in allowed:
                normalized[idx] = label

        if normalized:
            logger.info("[LLM] Entry classification result: %s", normalized)
        return normalized
    except Exception as exc:
        logger.warning("Entry LLM classification failed (non-fatal): %s", exc)
        return {}
