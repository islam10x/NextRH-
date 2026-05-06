"""
CV Generation — Input Validation & Schema Enforcement
======================================================
Pydantic models that enforce structure, types, and safe defaults for all
employee data BEFORE it enters the generation pipeline.

Design goals:
- Fail FAST on truly invalid input (e.g. non-dict, corrupted JSON)
- Coerce & sanitise gracefully for partial/missing data (never crash silently)
- Provide safe fallback values so the pipeline always produces a valid DOCX
- Surface all validation warnings in a structured report
"""

import re
import logging
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

logger = logging.getLogger("ai_service.cv_validation")

# ── Length limits to prevent XML/template overflow ───────────────────────
MAX_NAME_LEN = 80
MAX_FIELD_LEN = 300
MAX_SUMMARY_LEN = 2000
MAX_DESC_LEN = 1500
MAX_SKILL_LEN = 100
MAX_LANG_LEN = 50
MAX_EXPERIENCE_ENTRIES = 20
MAX_EDUCATION_ENTRIES = 15
MAX_CERTIFICATIONS = 10
MAX_PROJECTS = 10
MAX_SKILLS = 15
MAX_LANGUAGES = 20

# ── Validation regexes ──────────────────────────────────────────────────
_EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
_PHONE_RE = re.compile(r'^[\d\s+()\-./]+$')
# Section headers that APILayer injects into address fields
_ADDR_SECTION_SPLIT = re.compile(
    r'\s+(?:Exp[eé]riences?|Formation|Certifications?|Comp[eé]tences?|Skills|'
    r'Education|Projects?|P[eé]riode|Organisme|Fonction\s+occup|'
    r'Professional\s+experience|Work\s+experience)',
    re.I,
)

# Characters that could corrupt OOXML if injected raw into text elements
_XML_UNSAFE_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')


def _safe_str(value: Any, max_len: int = MAX_FIELD_LEN) -> str:
    """Coerce to trimmed string, strip control chars, cap length."""
    if value is None:
        return ""
    s = str(value).strip()
    # Strip XML-unsafe control characters (keeps \t, \n, \r)
    s = _XML_UNSAFE_RE.sub('', s)
    if len(s) > max_len:
        s = s[:max_len].rsplit(' ', 1)[0] + "…"
    return s


def _safe_list_of_str(value: Any, item_max: int, list_max: int) -> List[str]:
    """Coerce to a list of non-empty strings with length caps."""
    if isinstance(value, str):
        items = [s.strip() for s in value.split(',') if s.strip()]
    elif isinstance(value, list):
        items = [_safe_str(s, item_max) for s in value
                 if s is not None and str(s).strip()]
    else:
        items = []
    return items[:list_max]


def _dedupe_strings_case_insensitive(items: List[str]) -> List[str]:
    """Drop duplicates ignoring case + accents while preserving original casing.

    The first occurrence wins.  Used for skills and language lists where
    "Python" + "python" or "Français" + "francais" must collapse to one
    entry to keep the rendered CV clean.
    """
    seen: set = set()
    deduped: List[str] = []
    for item in items:
        key = "".join(
            ch for ch in __import__("unicodedata").normalize("NFKD", item)
            if not __import__("unicodedata").combining(ch)
        ).strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


# Recognises ranges like "2020 - 2023", "Jan 2020 — Present", "01/2020 to 12/2022".
_DATE_RANGE_RE = re.compile(
    r"(?P<start>\d{4}|\d{1,2}[/\-.]\d{4}|[A-Za-zéûô]+\s+\d{4})\s*"
    r"(?:[-–—]|to|à|au|bis|hasta|fino al)\s*"
    r"(?P<end>\d{4}|\d{1,2}[/\-.]\d{4}|[A-Za-zéûô]+\s+\d{4}|"
    r"present|current|présent|aujourd['’]hui|en cours|actuel|"
    r"heute|attuale|presente|hoy)",
    re.IGNORECASE,
)

_YEAR_ONLY_RE = re.compile(r"^\d{4}$")


def _validate_date_string(value: Any) -> tuple[str, Optional[str]]:
    """Validate a date-or-range string.  Returns ``(cleaned, warning_or_None)``.

    Empty/None input returns ``("", None)`` — missing dates are not an error.
    Strings that match neither a known range nor a year are returned as-is
    but with a warning so callers can flag them in the report.
    """
    s = _safe_str(value, MAX_FIELD_LEN)
    if not s:
        return "", None
    if _YEAR_ONLY_RE.match(s):
        return s, None
    if _DATE_RANGE_RE.search(s):
        return s, None
    if any(ch.isdigit() for ch in s):
        # Accept anything containing digits without a strong warning
        # (templates use a wide variety of date formats).
        return s, None
    return s, f"Date string contains no digits: {s!r}"


def _year_from_iso(value: str) -> str:
    """'2018-02-01' → '2018', '2018-02' → '2018', '2018' → '2018', '' → ''."""
    if not value:
        return ""
    return re.sub(r'^(\d{4})[-/]\d{2}.*$', r'\1', value.strip())


def _dates_from_range(start: Any, end: Any, is_current: Any = None) -> str:
    """Build a human-readable date range string from two ISO/year values."""
    s = _year_from_iso(str(start or "").strip())
    e = _year_from_iso(str(end or "").strip())
    if is_current:
        e = "Present"
    if s and e:
        return f"{s} - {e}"
    return s or e


class ExperienceEntry(BaseModel):
    """A single work experience entry."""
    title: str = ""
    company: str = ""
    dates: str = ""
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    isCurrent: Optional[bool] = None
    description: str = ""
    # Alternate field names from backend
    jobTitle: Optional[str] = None
    companyName: Optional[str] = None
    skills_used: List[str] = Field(default_factory=list)

    @model_validator(mode='before')
    @classmethod
    def normalize_fields(cls, values: Any) -> Any:
        if not isinstance(values, dict):
            return values
        # Consolidate alternate field names
        if not values.get('title') and values.get('jobTitle'):
            values['title'] = values['jobTitle']
        if not values.get('company') and values.get('companyName'):
            values['company'] = values['companyName']
        # Derive dates string from startDate/endDate when not already set.
        # This handles data arriving as camelCase from the frontend API.
        if not (values.get('dates') or '').strip():
            start = values.get('startDate') or values.get('start_date') or ''
            end = values.get('endDate') or values.get('end_date') or ''
            computed = _dates_from_range(start, end, values.get('isCurrent'))
            if computed:
                values['dates'] = computed
        return values

    @field_validator('title', 'company', mode='before')
    @classmethod
    def cap_string(cls, v: Any) -> str:
        return _safe_str(v, MAX_FIELD_LEN)

    @field_validator('description', mode='before')
    @classmethod
    def cap_description(cls, v: Any) -> str:
        return _safe_str(v, MAX_DESC_LEN)

    @property
    def is_valid(self) -> bool:
        return bool(self.title.strip() and self.company.strip())


class EducationEntry(BaseModel):
    """A single education entry."""
    degree: str = ""
    institution: str = ""
    fieldOfStudy: Optional[str] = None
    dates: str = ""
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    description: str = ""

    @model_validator(mode='before')
    @classmethod
    def normalize_edu_fields(cls, values: Any) -> Any:
        if not isinstance(values, dict):
            return values
        # Derive dates string from startDate/endDate when not already set.
        if not (values.get('dates') or '').strip():
            start = values.get('startDate') or values.get('start_date') or ''
            end = values.get('endDate') or values.get('end_date') or values.get('graduationDate') or ''
            computed = _dates_from_range(start, end)
            if computed:
                values['dates'] = computed
        return values

    @field_validator('degree', 'institution', mode='before')
    @classmethod
    def cap_string(cls, v: Any) -> str:
        return _safe_str(v, MAX_FIELD_LEN)

    @field_validator('description', mode='before')
    @classmethod
    def cap_description(cls, v: Any) -> str:
        return _safe_str(v, MAX_DESC_LEN)

    @model_validator(mode='after')
    def deduplicate_degree(self) -> 'EducationEntry':
        """Fix doubled degree strings: 'Foo Bar Foo Bar' → 'Foo Bar'."""
        if self.degree:
            words = self.degree.split()
            half = len(words) // 2
            if half >= 2 and words[:half] == words[half:]:
                self.degree = ' '.join(words[:half])
        return self

    @property
    def is_valid(self) -> bool:
        return bool(self.degree.strip() or self.institution.strip())


class ProjectEntry(BaseModel):
    """A single project entry."""
    name: str = ""
    description: str = ""
    role: Optional[str] = None
    skills: List[str] = Field(default_factory=list)
    client: Optional[str] = None
    startDate: Optional[str] = None
    endDate: Optional[str] = None

    @field_validator('description', mode='before')
    @classmethod
    def cap_description(cls, v: Any) -> str:
        return _safe_str(v, MAX_DESC_LEN)


class ValidationReport(BaseModel):
    """Structured report of all validation issues found during sanitisation."""
    warnings: List[str] = Field(default_factory=list)
    dropped_experiences: int = 0
    dropped_educations: int = 0
    fields_defaulted: List[str] = Field(default_factory=list)
    original_field_count: int = 0
    valid_field_count: int = 0

    @property
    def has_warnings(self) -> bool:
        return bool(self.warnings)

    def log_all(self) -> None:
        for w in self.warnings:
            logger.warning(f"[cv_validation] {w}")
        if self.dropped_experiences:
            logger.info(f"[cv_validation] Dropped {self.dropped_experiences} incomplete experience entries")
        if self.dropped_educations:
            logger.info(f"[cv_validation] Dropped {self.dropped_educations} incomplete education entries")


class EmployeeDataValidator:
    """
    Validates and sanitises an employee data dictionary.

    Usage:
        validator = EmployeeDataValidator(raw_dict)
        cleaned = validator.validated_data   # safe dict for the pipeline
        report  = validator.report           # structured issues report
    """

    def __init__(self, raw: Dict[str, Any]):
        self._report = ValidationReport()
        self._report.original_field_count = len([
            k for k, v in raw.items()
            if v is not None and str(v).strip()
        ]) if isinstance(raw, dict) else 0

        self._data = self._validate(raw)

        self._report.valid_field_count = len([
            k for k, v in self._data.items()
            if v is not None and (
                (isinstance(v, str) and v.strip()) or
                (isinstance(v, list) and v) or
                (isinstance(v, dict) and v)
            )
        ])

    @property
    def validated_data(self) -> Dict[str, Any]:
        return self._data

    @property
    def report(self) -> ValidationReport:
        return self._report

    def _warn(self, msg: str) -> None:
        self._report.warnings.append(msg)

    def _validate(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(raw, dict):
            self._warn("Input is not a dict — using empty defaults")
            raw = {}

        d: Dict[str, Any] = {}

        # ── Name ─────────────────────────────────────────────────────
        name = _safe_str(raw.get('name'), MAX_NAME_LEN)
        if not name:
            first = _safe_str(raw.get('firstName'), 40)
            last = _safe_str(raw.get('lastName'), 40)
            name = f"{first} {last}".strip()
        if name:
            d['name'] = name
        else:
            d['name'] = 'Employee'
            self._warn("No usable name — defaulting to 'Employee'")
            self._report.fields_defaulted.append('name')

        # Keep firstName/lastName for sub-components that need them
        d['firstName'] = _safe_str(raw.get('firstName'), 40)
        d['lastName'] = _safe_str(raw.get('lastName'), 40)

        # ── Scalar text fields ───────────────────────────────────────
        for field in ('title', 'linkedin'):
            d[field] = _safe_str(raw.get(field), MAX_FIELD_LEN)

        d['summary'] = _safe_str(raw.get('summary'), MAX_SUMMARY_LEN)

        # ── Email ────────────────────────────────────────────────────
        raw_email = _safe_str(raw.get('email'), MAX_FIELD_LEN)
        if raw_email and not _EMAIL_RE.match(raw_email):
            self._warn(f"Discarding invalid email: {raw_email!r}")
            d['email'] = ''
        else:
            d['email'] = raw_email

        # ── Phone ────────────────────────────────────────────────────
        raw_phone = _safe_str(raw.get('phone'), MAX_FIELD_LEN)
        if raw_phone and not _PHONE_RE.match(raw_phone):
            self._warn(f"Discarding invalid phone: {raw_phone!r}")
            d['phone'] = ''
        else:
            d['phone'] = raw_phone

        # ── Address (strip APILayer artifacts) ───────────────────────
        raw_addr = _safe_str(raw.get('address'), MAX_FIELD_LEN)
        if raw_addr:
            parts = _ADDR_SECTION_SPLIT.split(raw_addr, maxsplit=1)
            d['address'] = parts[0].strip()
            if len(parts) > 1:
                self._warn("Address had section-header artifacts — truncated")
        else:
            d['address'] = ''

        # ── Skills ───────────────────────────────────────────────────
        skills_raw = _safe_list_of_str(raw.get('skills'), MAX_SKILL_LEN, MAX_SKILLS)
        skills_dedup = _dedupe_strings_case_insensitive(skills_raw)
        if len(skills_dedup) < len(skills_raw):
            self._warn(
                f"Removed {len(skills_raw) - len(skills_dedup)} duplicate skill(s)"
            )
        d['skills'] = skills_dedup

        # ── Languages ────────────────────────────────────────────────
        langs_raw = _safe_list_of_str(raw.get('languages'), MAX_LANG_LEN, MAX_LANGUAGES)
        langs_dedup = _dedupe_strings_case_insensitive(langs_raw)
        if len(langs_dedup) < len(langs_raw):
            self._warn(
                f"Removed {len(langs_raw) - len(langs_dedup)} duplicate language(s)"
            )
        d['languages'] = langs_dedup

        # ── Experience ───────────────────────────────────────────────
        raw_exp = raw.get('experience')
        if isinstance(raw_exp, list):
            valid_exp = []
            for entry in raw_exp:
                if not isinstance(entry, dict):
                    continue
                try:
                    parsed = ExperienceEntry.model_validate(entry)
                    if parsed.is_valid:
                        # Validate the dates field (does not modify the entry —
                        # we only surface warnings).
                        dates_val = entry.get('dates') or entry.get('date_range')
                        if dates_val:
                            _, warn = _validate_date_string(dates_val)
                            if warn:
                                self._warn(f"Experience: {warn}")
                        valid_exp.append(entry)
                    else:
                        self._report.dropped_experiences += 1
                except Exception:
                    self._report.dropped_experiences += 1
            d['experience'] = valid_exp[:MAX_EXPERIENCE_ENTRIES]
        else:
            d['experience'] = []

        # ── Education ────────────────────────────────────────────────
        raw_edu = raw.get('education')
        if isinstance(raw_edu, list):
            valid_edu = []
            for entry in raw_edu:
                if not isinstance(entry, dict):
                    continue
                try:
                    parsed = EducationEntry.model_validate(entry)
                    if parsed.is_valid:
                        # Apply dedup fix back
                        entry_copy = dict(entry)
                        if parsed.degree != entry.get('degree', ''):
                            entry_copy['degree'] = parsed.degree
                        valid_edu.append(entry_copy)
                    else:
                        self._report.dropped_educations += 1
                except Exception:
                    self._report.dropped_educations += 1
            d['education'] = valid_edu[:MAX_EDUCATION_ENTRIES]
        else:
            d['education'] = []

        # ── Certifications ───────────────────────────────────────────
        raw_certs = raw.get('certifications')
        if isinstance(raw_certs, list):
            d['certifications'] = [
                c for c in raw_certs
                if c is not None and (isinstance(c, dict) or str(c).strip())
            ][:MAX_CERTIFICATIONS]
        else:
            d['certifications'] = []

        # ── Projects ─────────────────────────────────────────────────
        raw_proj = raw.get('projects')
        if isinstance(raw_proj, list):
            valid_proj = []
            for p in raw_proj:
                if not isinstance(p, dict):
                    continue
                if p.get('description'):
                    p = dict(p)
                    p['description'] = _safe_str(p['description'], MAX_DESC_LEN)
                valid_proj.append(p)
            d['projects'] = valid_proj[:MAX_PROJECTS]
        else:
            d['projects'] = []

        # ── Derive title from first experience if not set ────────────
        if not d.get('title') and d.get('experience'):
            first_exp = d['experience'][0]
            derived = (first_exp.get('title') or first_exp.get('jobTitle', '')).strip()
            if derived:
                d['title'] = _safe_str(derived, MAX_FIELD_LEN)
                d['_title_derived'] = True
                self._warn(f"Derived title from first experience: {derived!r}")

        # ── Photo path (pass through, validated in process_cv) ───────
        if raw.get('photo'):
            d['photo'] = str(raw['photo'])

        # ── Preserve any extra keys not covered above ────────────────
        # (for forward-compatibility with new fields the backend may add)
        for k, v in raw.items():
            if k not in d:
                d[k] = v

        return d


def validate_employee_data(raw: Dict[str, Any]) -> tuple[Dict[str, Any], ValidationReport]:
    """
    Convenience wrapper: validate & sanitise employee data.

    Returns:
        (cleaned_data, report)

    Never raises for partial/missing data — always returns a usable dict.
    Raises ValueError only for truly broken input (not a dict, etc).
    """
    if raw is None:
        raise ValueError("Employee data cannot be None")
    validator = EmployeeDataValidator(raw)
    return validator.validated_data, validator.report
