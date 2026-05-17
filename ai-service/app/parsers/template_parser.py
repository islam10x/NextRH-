import fitz
import re
import unicodedata
from bisect import bisect_right
from typing import Any, Dict, List, Optional, Tuple

from app.utils.logger import logger
from app.services.cv_section_taxonomy import classify_heading as _classify_section_heading


class TemplateCVParser:
    BULLET_RE = re.compile(r"[\u2022\u25cf\u25cb\u25aa\u25ab\u2023\u2219\u00b7\uf0b7\uf0d7]")
    DASH_RE = r"[-\u2013\u2014]"
    MONTH_RE = (
        r"(?:janvier|f(?:e|\u00e9)vrier|mars|avril|mai|juin|juillet|ao(?:u|\u00fb)t|"
        r"septembre|octobre|novembre|d(?:e|\u00e9)cembre|january|february|march|"
        r"april|may|june|july|august|september|october|november|december)"
    )
    def parse(self, file_path: str) -> Dict[str, Any]:
        """
        Parse CV files following the Next Step IT template format.
        Handles bilingual (French/English) CVs with table-like structures.
        """
        text = ""
        self._layout_lines: List[Dict[str, Any]] = []
        try:
            with fitz.open(file_path) as doc:
                page_offset = 0.0
                for page_index, page in enumerate(doc):
                    text += page.get_text("text", sort=True)
                    self._layout_lines.extend(
                        self._build_layout_lines(page, page_index, page_offset)
                    )
                    page_offset += float(page.rect.height) + 120.0
        except Exception as exc:
            logger.error(f"Failed to read PDF: {exc}")
            raise ValueError("Could not read file")

        self._layout_lines.sort(key=lambda item: (item["page"], item["y0"], item["x0"]))
        for order, item in enumerate(self._layout_lines):
            item["order"] = order

        text = text.replace("\xa0", " ")
        text = re.sub(r"\n{3,}", "\n\n", text)

        # Keep raw spacing for table parsing while still supporting normalized matching.
        lines = [line.rstrip() for line in text.splitlines() if line.strip()]

        data: Dict[str, Any] = {
            "first_name": "",
            "last_name": "",
            "email": "",
            "phone": "",
            "address": "",
            "experience": [],
            "certifications": [],
            "education": [],
            "projects": [],
            "skills": [],
        }

        data["first_name"], data["last_name"] = self._extract_name(text, lines)
        data["email"] = self._extract_email(text)
        data["phone"] = self._extract_phone(text)
        data["address"] = self._extract_address(text)
        data["experience"] = self._extract_experience(text, lines)
        data["certifications"] = self._extract_certifications(text, lines, file_path)
        data["education"] = self._extract_education(text, lines, file_path)
        data["projects"] = self._extract_projects(text, lines)
        data["skills"] = self._extract_skills(text, lines)

        # DOCX files are table-first; prefer native table extraction to avoid row shifts.
        if file_path.lower().endswith(".docx"):
            docx_data = self._extract_docx_structured_data(file_path)
            if docx_data.get("experience"):
                data["experience"] = docx_data["experience"]
            if docx_data.get("certifications"):
                data["certifications"] = docx_data["certifications"]
            if docx_data.get("education"):
                data["education"] = docx_data["education"]
            if docx_data.get("projects"):
                data["projects"] = docx_data["projects"]

        return data

    def _extract_docx_structured_data(self, file_path: str) -> Dict[str, List[Dict[str, str]]]:
        """
        Extract table-backed sections directly from DOCX.
        This bypasses text-flow issues where cell rows get merged/shuffled.
        """
        try:
            import docx  # type: ignore
            from docx.document import Document as DocxDocument  # type: ignore
            from docx.oxml.table import CT_Tbl  # type: ignore
            from docx.oxml.text.paragraph import CT_P  # type: ignore
            from docx.table import Table  # type: ignore
            from docx.text.paragraph import Paragraph  # type: ignore
        except Exception as exc:
            logger.warning(f"DOCX parser dependency unavailable: {exc}")
            return {"experience": [], "certifications": [], "education": [], "projects": []}

        def iter_block_items(parent: DocxDocument):
            for child in parent.element.body.iterchildren():
                if isinstance(child, CT_P):
                    yield Paragraph(child, parent)
                elif isinstance(child, CT_Tbl):
                    yield Table(child, parent)

        def cell_text(cell: Any) -> str:
            parts = [self._clean_text(paragraph.text) for paragraph in getattr(cell, "paragraphs", [])]
            return self._clean_text(" ".join(part for part in parts if part))

        extracted: Dict[str, List[Dict[str, str]]] = {
            "experience": [],
            "certifications": [],
            "education": [],
            "projects": [],
        }
        cert_anchor_pattern = re.compile(
            r"(?i)\b("
            r"certified|certification|certificate|certificat|associate|professional|"
            r"network|routing|switching|cisco|ccna|ccnp|dell|hp|kemp|acfe|acps|acsr"
            r")\b"
        )

        try:
            doc = docx.Document(file_path)
        except Exception as exc:
            logger.warning(f"Failed to open DOCX for table extraction: {exc}")
            return extracted

        current_section = ""
        for block in iter_block_items(doc):
            if block.__class__.__name__ == "Paragraph":
                paragraph_text = self._clean_text(getattr(block, "text", ""))
                if not paragraph_text:
                    continue

                norm = self._normalize_for_match(paragraph_text)
                if "experience professionnelle" in norm:
                    current_section = "experience"
                elif re.search(r"\bcertification(s)?\b|\bcertificat(s)?\b", norm):
                    current_section = "certifications"
                elif "formation academique" in norm or norm in {"education", "formation", "formations"}:
                    current_section = "education"
                elif "experience academique" in norm or re.search(r"\bprojects?\b|\bprojets?\b", norm):
                    current_section = "projects"
                elif re.search(r"\bskills?\b|\bcompetence(s)?\b", norm):
                    current_section = ""
                continue

            rows: List[List[str]] = []
            for row in getattr(block, "rows", []):
                rows.append([cell_text(cell) for cell in getattr(row, "cells", [])])
            if not rows:
                continue

            header = rows[0]
            header_cells_norm = [self._normalize_for_match(cell) for cell in header if cell]
            header_norm = " ".join(header_cells_norm)

            table_type = ""
            if ("certificat" in header_norm or "certification" in header_norm or "certificate" in header_norm) and "date" in header_norm:
                table_type = "certifications"
            elif "institution" in header_norm and ("diplome" in header_norm or "degree" in header_norm):
                table_type = "education"
            elif "periode" in header_norm and ("organisme" in header_norm or "fonction" in header_norm):
                table_type = "experience"
            else:
                has_period_col = any(
                    re.search(r"\b(annee|annees|year|years|periode|period|date)\b", cell_norm)
                    for cell_norm in header_cells_norm
                )
                has_client_col = any(
                    re.search(r"\b(client|clients|company|societe|entreprise|organisme)\b", cell_norm)
                    for cell_norm in header_cells_norm
                )
                has_project_col = any(
                    re.search(r"\b(project|projects|projet|projets|description|mission)\b", cell_norm)
                    for cell_norm in header_cells_norm
                )
                data_rows_preview = rows[1:] if len(rows) > 1 else rows
                has_cert_content = any(
                    cert_anchor_pattern.search(
                        self._normalize_for_match(" ".join(cell for cell in row if cell))
                    )
                    for row in data_rows_preview
                )
                has_training_header = (
                    ("periode" in header_norm or "period" in header_norm)
                    and ("formation" in header_norm or "training" in header_norm)
                )
                if has_period_col and has_client_col and has_project_col:
                    table_type = "projects"
                elif has_training_header and has_cert_content:
                    table_type = "certifications"
                elif current_section in {"experience", "certifications", "education", "projects"}:
                    table_type = current_section
            if not table_type:
                continue

            data_rows = rows[1:] if header_norm else rows
            if table_type == "certifications":
                for row in data_rows:
                    first_cell = self._clean_text(row[0] if len(row) > 0 else "")
                    second_cell = self._clean_text(row[1] if len(row) > 1 else "")
                    first_date = self._extract_date_token(first_cell)
                    first_has_anchor = bool(cert_anchor_pattern.search(self._normalize_for_match(first_cell)))
                    second_has_anchor = bool(cert_anchor_pattern.search(self._normalize_for_match(second_cell)))

                    # "Formation professionnelle" rows can include non-cert training entries.
                    if first_date and not first_has_anchor and not second_has_anchor:
                        continue

                    # Training tables can use [period, certification name].
                    if first_date and second_has_anchor and not first_has_anchor:
                        name = second_cell
                        date_raw = first_cell
                    else:
                        name = first_cell
                        date_raw = second_cell

                    name = self._collapse_repeated_phrase(self._strip_date_noise_from_cert_name(name))
                    if not name or self._is_cert_header_or_column_line(name):
                        continue

                    full_date = self._extract_date_token(date_raw) or self._extract_month_year(date_raw) or date_raw

                    extracted["certifications"].append(
                        {
                            "name": name,
                            "date_obtained": self._clean_text(full_date),
                        }
                    )
                continue

            if table_type == "education":
                for row in data_rows:
                    period = self._clean_text(row[0] if len(row) > 0 else "")
                    institution = self._clean_text(row[1] if len(row) > 1 else "")
                    degree = self._clean_text(" ".join(row[2:]) if len(row) > 2 else "")
                    if not period and not institution and not degree:
                        continue

                    period_norm = self._normalize_for_match(period)
                    if period_norm in {"periode", "period"} and self._normalize_for_match(institution) == "institution":
                        continue

                    end_date = self._extract_docx_period_end(period)
                    extracted["education"].append(
                        {
                            "end_date": end_date,
                            "institution": institution,
                            "degree": degree,
                        }
                    )
                continue

            if table_type == "experience":
                for row in data_rows:
                    period = self._clean_text(row[0] if len(row) > 0 else "")
                    company = self._clean_text(row[1] if len(row) > 1 else "")
                    title = self._clean_text(" ".join(row[2:]) if len(row) > 2 else "")
                    if not period and not company and not title:
                        continue

                    period_norm = self._normalize_for_match(period)
                    if period_norm in {"periode", "period"} and self._normalize_for_match(company) == "organisme":
                        continue

                    # Heuristic: some DOCX tables shift columns so a month token lands in the "company" column.
                    # Example observed: period="Mai 2023", company="Février", title="Next Generation IT Stage PFE ..."
                    if company and re.fullmatch(rf"(?i){self.MONTH_RE}", company.strip()):
                        year_match = re.search(r"\b(19|20)\d{2}\b", period)
                        if year_match:
                            period = self._clean_text(f"{company} {year_match.group(0)} - {period}")
                            recovered_company, recovered_title = self._split_company_and_title(title)
                            if recovered_company and not recovered_title:
                                recovered_company, recovered_title = self._split_company_title_fallback(title)
                            if recovered_company:
                                company = recovered_company
                                title = recovered_title

                    extracted["experience"].append(
                        {
                            "start_date": period,
                            "company": company,
                            "title": title,
                            "end_date": "",
                            "description": "",
                        }
                    )
                continue

            if table_type == "projects":
                for row in data_rows:
                    date_value = self._clean_text(row[0] if len(row) > 0 else "")
                    client_value = self._clean_text(row[1] if len(row) > 2 else "")
                    if len(row) > 2:
                        description_value = self._clean_text(" ".join(row[2:]))
                    else:
                        description_value = self._clean_text(" ".join(row[1:]) if len(row) > 1 else "")

                    if not date_value and not client_value and not description_value:
                        continue

                    date_norm = self._normalize_for_match(date_value)
                    client_norm = self._normalize_for_match(client_value)
                    desc_norm = self._normalize_for_match(description_value)
                    if (
                        date_norm in {"annee", "annees", "year", "years", "periode", "period", "date"}
                        and client_norm in {"client", "clients", "company", "societe", "entreprise", "organisme", ""}
                        and desc_norm in {"project", "projects", "projet", "projets", "description", "mission", "formation"}
                    ):
                        continue

                    extracted["projects"].append(
                        {
                            "date": date_value,
                            "client": client_value,
                            "description": description_value,
                        }
                    )
                continue

        return extracted

    def _extract_docx_period_end(self, value: str) -> str:
        text = self._clean_text(value)
        if not text:
            return ""

        text_norm = self._normalize_for_match(text)
        if re.search(r"\b(present|pr[eé]sent|current|en cours)\b", text_norm):
            return "Present"

        # If we have a range, keep the right side.
        parts = re.split(rf"\s*{self.DASH_RE}\s*", text)
        if len(parts) >= 2 and self._clean_text(parts[-1]):
            right = self._clean_text(parts[-1])
            right_norm = self._normalize_for_match(right)
            if re.search(r"\b(present|pr[eé]sent|current|en cours)\b", right_norm):
                return "Present"
            return right

        date_candidates = re.findall(
            rf"(?i)(?:{self.MONTH_RE}\s+\d{{4}}|\d{{1,2}}/\d{{4}}|(?:19|20)\d{{2}})",
            text,
        )
        if date_candidates:
            return self._clean_text(date_candidates[-1])

        return text

    def _build_layout_lines(
        self, page: fitz.Page, page_index: int, page_offset: float
    ) -> List[Dict[str, Any]]:
        """Build line-level layout items from PyMuPDF text spans."""
        try:
            text_dict = page.get_text("dict")
        except Exception:
            return []

        layout_lines: List[Dict[str, Any]] = []
        for block in text_dict.get("blocks", []):
            if block.get("type") != 0:
                continue

            for line in block.get("lines", []):
                spans = [span for span in line.get("spans", []) if span.get("text")]
                if not spans:
                    continue

                ordered_spans = sorted(
                    spans, key=lambda span: float(span.get("bbox", [0.0])[0])
                )
                parts: List[str] = []
                previous_x1: Optional[float] = None
                for span in ordered_spans:
                    bbox = span.get("bbox", [0.0, 0.0, 0.0, 0.0])
                    x0 = float(bbox[0])
                    x1 = float(bbox[2])
                    span_text = str(span.get("text", ""))
                    if not span_text:
                        continue
                    if previous_x1 is not None and x0 - previous_x1 > 1.5:
                        parts.append(" ")
                    parts.append(span_text)
                    previous_x1 = x1

                line_text = re.sub(r"\s+", " ", "".join(parts)).strip()
                if not line_text:
                    continue

                x0 = min(float(span.get("bbox", [0.0, 0.0, 0.0, 0.0])[0]) for span in spans)
                y0 = min(float(span.get("bbox", [0.0, 0.0, 0.0, 0.0])[1]) for span in spans)
                x1 = max(float(span.get("bbox", [0.0, 0.0, 0.0, 0.0])[2]) for span in spans)
                y1 = max(float(span.get("bbox", [0.0, 0.0, 0.0, 0.0])[3]) for span in spans)

                layout_lines.append(
                    {
                        "page": page_index,
                        "x0": x0,
                        "y0": y0,
                        "x1": x1,
                        "y1": y1,
                        "global_y": page_offset + ((y0 + y1) / 2.0),
                        "text": line_text,
                    }
                )

        return layout_lines

    def _normalize_for_match(self, value: str) -> str:
        value = unicodedata.normalize("NFKD", value or "")
        value = "".join(ch for ch in value if not unicodedata.combining(ch))
        value = value.lower().replace("\u2019", "'").replace("`", "'").replace("â€™", "'")
        value = re.sub(r"\s+", " ", value).strip()
        return value

    def _clean_text(self, value: str) -> str:
        if not value:
            return ""

        value = self.BULLET_RE.sub(" ", value)
        value = re.sub(r"\s+", " ", value).strip()
        value = re.sub(r"^[\-\u2013\u2014,:;|\u00ab\u00bb']+", "", value).strip()
        value = re.sub(r"[\-\u2013\u2014,:;|\u00ab\u00bb']+$", "", value).strip()
        return value

    def _collapse_repeated_phrase(self, value: str) -> str:
        """Collapse duplicated sentence fragments caused by wrapped table extraction."""
        cleaned = self._clean_text(value)
        if not cleaned:
            return ""

        sentence_parts = [self._clean_text(part) for part in re.split(r"[.;]", cleaned) if self._clean_text(part)]
        if len(sentence_parts) >= 2:
            first = sentence_parts[0]
            second = sentence_parts[1]
            first_norm = self._normalize_for_match(first)
            second_norm = self._normalize_for_match(second)
            if first_norm.startswith(second_norm) or second_norm.startswith(first_norm):
                longer = first if len(first) >= len(second) else second
                remainder = sentence_parts[2:]
                if remainder:
                    return self._clean_text(" ".join([longer] + remainder))
                return longer

        return cleaned

    def _extract_date_token(self, line: str) -> Optional[str]:
        """Extract a date token from a line (full date preferred over year-only)."""
        if not line:
            return None

        patterns = [
            r"\b\d{1,2}[/-]\d{1,2}[/-](?:19|20)\d{2}\b",
            rf"(?i)\b{self.MONTH_RE}\s+\d{{1,2}}[/-](?:19|20)\d{{2}}\b",
            rf"(?i)\b{self.MONTH_RE}\s+\d{{1,2}},?\s*(?:19|20)\d{{2}}\b",
            rf"(?i)\b{self.MONTH_RE}\s+(?:19|20)\d{{2}}\b",
            r"\b\d{1,2}[/-](?:19|20)\d{2}\b",
            r"\b(?:19|20)\d{2}\b",
        ]

        for pattern in patterns:
            match = re.search(pattern, line)
            if match:
                return self._clean_text(match.group(0))
        return None

    def _strip_date_noise_from_cert_name(self, value: str) -> str:
        """Remove trailing date fragments accidentally glued to certification names."""
        cleaned = self._clean_text(value)
        if not cleaned:
            return ""

        patterns = [
            r"\b\d{1,2}[/-]\d{1,2}[/-](?:19|20)\d{2}\b",
            r"\b\d{1,2}[/-](?:19|20)\d{2}\b",
            rf"(?i)\b{self.MONTH_RE}\s+\d{{1,2}},?\s*(?:19|20)\d{{2}}\b",
            rf"(?i)\b{self.MONTH_RE}\s+(?:19|20)\d{{2}}\b",
            r"\b(?:19|20)\d{2}\b",
        ]
        for pattern in patterns:
            cleaned = self._clean_text(re.sub(pattern, " ", cleaned))

        # Remove dangling month/day tokens after date stripping (e.g. "Novembre 9")
        cleaned = self._clean_text(
            re.sub(rf"(?i)\b{self.MONTH_RE}\b\s*\d{{1,2}}?$", " ", cleaned)
        )
        return cleaned

    def _looks_like_date_only(self, value: str) -> bool:
        cleaned = self._clean_text(value)
        if not cleaned:
            return False
        token = self._extract_date_token(cleaned)
        if not token:
            return False
        remainder = self._clean_text(cleaned.replace(token, "", 1))
        if not remainder:
            return True
        remainder_norm = self._normalize_for_match(remainder)
        # Keep date-only shards out of cert names.
        return bool(
            re.fullmatch(rf"(?:{self.MONTH_RE}|\d{{1,2}}|[-/]+)", remainder_norm, re.IGNORECASE)
        )
    def _match_keyword(self, line: str, keyword: str) -> bool:
        line_norm = self._normalize_for_match(line)
        keyword_norm = self._normalize_for_match(keyword)

        if not line_norm or not keyword_norm:
            return False
        if line_norm == keyword_norm:
            return True

        return re.search(rf"\b{re.escape(keyword_norm)}\b", line_norm) is not None

    def _is_page_artifact(self, line: str) -> bool:
        return bool(re.fullmatch(r"\d+", line.strip()))

    def _extract_month_year(self, line: str) -> Optional[str]:
        patterns = [
            rf"(?i)\b{self.MONTH_RE}\s+\d{{4}}\b",
            r"\b\d{1,2}/\d{4}\b",
            r"\b(?:19|20)\d{2}\b"
        ]
        for pattern in patterns:
            match = re.search(pattern, line)
            if match:
                return match.group(0).strip()
        return None

    def _extract_date_from_line(self, line: str) -> Optional[str]:
        present_pattern = r"(?:present|pr(?:[eéè\u00e9\ufffd]|&eacute;)sent|current|aujourd['’\u2019]?hui|en\s+cours|[àa]\s+ce\s+jour|maintenant|now)"
        dash_or_to = rf"(?:{self.DASH_RE}|[àa\ufffd]|to|-|jusqu['’\u2019\ufffd]?\s*[aà\ufffd]?)"
        
        date_patterns = [
            rf"(?i)\b(?:depuis|since)\s+{self.MONTH_RE}\s+\d{{4}}\b",
            rf"(?i)\b\d{{1,2}}/\d{{1,2}}/\d{{4}}\s*{dash_or_to}\s*(?:\d{{1,2}}/\d{{1,2}}/\d{{4}}|\d{{1,2}}/\d{{4}}|\d{{4}}|{present_pattern})\b",
            rf"(?i)\b{self.MONTH_RE}\s+\d{{4}}\s*{dash_or_to}\s*(?:{self.MONTH_RE}\s+\d{{4}}|\d{{4}}|{present_pattern})\b",
            rf"(?i)\b{self.MONTH_RE}\s+\d{{4}}\s*{dash_or_to}\s*{self.MONTH_RE}\b",
            rf"(?i)\b\d{{1,2}}/\d{{4}}\s*{dash_or_to}\s*(?:\d{{1,2}}/\d{{4}}|\d{{4}}|{present_pattern})\b",
            rf"(?i)\b\d{{4}}\s*{dash_or_to}\s*(?:\d{{4}}|{present_pattern})\b",
            rf"\b\d{{4}}\s*{self.DASH_RE}\s*\d{{4}}\b",
            rf"(?i)\b\d{{1,2}}/\d{{1,2}}/\d{{4}}\b",
            rf"(?i)\b{self.MONTH_RE}\s+\d{{4}}\b",
            rf"(?i)\b(?:depuis|since)\s+\d{{1,2}}/\d{{4}}\b",
            rf"(?i)\b(?:depuis|since)\s+\d{{4}}\b",
            r"\b\d{1,2}/\d{4}\b",
            r"\b(?:19|20)\d{2}\b",
        ]

        for pattern in date_patterns:
            match = re.search(pattern, line)
            if match:
                date_str = match.group(0).strip()
                # If the date is followed by a connector, include it
                remaining = line[match.end():].strip()
                connector_match = re.match(rf"^{dash_or_to}", remaining, re.IGNORECASE)
                if connector_match:
                    date_str += " " + connector_match.group(0).strip()
                return date_str
        return None

    def _split_company_and_title(self, value: str) -> Tuple[str, str]:
        if not value:
            return "", ""

        bullet_parts = [
            self._clean_text(part)
            for part in re.split(r"[\u2022\u25cf\u25cb\u25aa\u25ab\u2023\u2219\u00b7\uf0b7\uf0d7]+", value)
            if self._clean_text(part)
        ]
        if len(bullet_parts) >= 2:
            return bullet_parts[0], " / ".join(bullet_parts[1:])

        cleaned = self._clean_text(value)
        if not cleaned:
            return "", ""

        spaced_parts = [
            self._clean_text(part)
            for part in re.split(r"\s{2,}|\t+", value)
            if self._clean_text(part)
        ]
        if len(spaced_parts) >= 2:
            return spaced_parts[0], " ".join(spaced_parts[1:])

        title_patterns = [
            r"\bcontract manager\b",
            r"\bchef de projet\b",
            r"\bproject manager\b",
            r"\bstage\b",
            r"\bpfe\b",
            r"\bintern(?:ship)?\b",
            r"\bing[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e]nieur\b",
            r"\bengineer\b",
            r"\bconsultant\b",
            r"\bmanager\b",
            r"\badministrateur\b",
            r"\badministrator\b",
            r"\btechnicien\b",
            r"\btechnician\b",
            r"\barchitecte\b",
            r"\barchitect\b",
            r"\bgestionnaire\b",
            r"\bdeveloppeur\b",
            r"\bd[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e]veloppeur\b",
            r"\binfrastructure\b",
            r"\bavant[- ]vente\b",
            r"\bsupport\b",
            r"\bs[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e]curit[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e]\b",
        ]

        split_idx: Optional[int] = None
        for pattern in title_patterns:
            match = re.search(pattern, cleaned, re.IGNORECASE)
            if match and match.start() > 0:
                if split_idx is None or match.start() < split_idx:
                    split_idx = match.start()

        if split_idx is not None and split_idx > 0:
            company = self._clean_text(cleaned[:split_idx])
            title = self._clean_text(cleaned[split_idx:])
            if company and title:
                return company, title

        return cleaned, ""

    def _split_company_title_fallback(self, value: str) -> Tuple[str, str]:
        """
        Fallback splitter for merged rows like:
        'Groupe El Kateb Ingenieur Reseaux et Securite'
        """
        text = self._clean_text(value)
        if not text:
            return "", ""

        tokens = [token for token in text.split() if token]
        if len(tokens) < 2:
            return text, ""

        normalized_tokens: List[str] = []
        for token in tokens:
            token_norm = self._normalize_for_match(token)
            token_norm = re.sub(r"[^a-z0-9]+", "", token_norm)
            normalized_tokens.append(token_norm)

        phrase_markers = [
            ("chef", "de", "projet"),
            ("project", "manager"),
            ("contract", "manager"),
            ("avant", "vente"),
        ]
        word_markers = {
            "ingenieur",
            "ingnieur",
            "consultant",
            "manager",
            "administrateur",
            "administrator",
            "technicien",
            "technician",
            "architecte",
            "architect",
            "developpeur",
            "developer",
            "analyste",
            "analyst",
            "support",
            "expert",
            "lead",
            "specialiste",
            "specialist",
        }
        marker_prefixes = (
            "ingen",
            "ingni",
            "ing",
            "consult",
            "manag",
            "admin",
            "techn",
            "arch",
            "develop",
            "analys",
            "suppor",
            "expert",
            "lead",
            "special",
        )

        split_pos: Optional[int] = None
        for idx in range(1, len(normalized_tokens)):
            for phrase in phrase_markers:
                phrase_len = len(phrase)
                if tuple(normalized_tokens[idx : idx + phrase_len]) == phrase:
                    split_pos = idx
                    break
            if split_pos is not None:
                break
            token_norm = normalized_tokens[idx]
            if token_norm in word_markers:
                split_pos = idx
                break
            if any(token_norm.startswith(prefix) for prefix in marker_prefixes):
                split_pos = idx
                break

        if split_pos is None:
            return text, ""

        company = self._clean_text(" ".join(tokens[:split_pos]))
        title = self._clean_text(" ".join(tokens[split_pos:]))
        if company and title:
            return company, title
        return text, ""

    def _split_institution_and_degree(self, value: str) -> Tuple[str, str]:
        text = self._clean_text(value)
        if not text:
            return "", ""

        degree_patterns = [
            r"\bdipl[oÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´]me\b",
            r"\blicence\b",
            r"\bmaster\b",
            r"\bbaccalaur[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e]at\b",
            r"\bing[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e]nieur\b",
            r"\btechnicien\b",
            r"\bdoctorat\b",
            r"\bphd\b",
            r"\bbachelor\b",
            r"\bdegree\b",
        ]

        split_idx: Optional[int] = None
        for pattern in degree_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match and match.start() > 0:
                if split_idx is None or match.start() < split_idx:
                    split_idx = match.start()

        if split_idx is None:
            return text, ""

        institution = self._clean_text(text[:split_idx])
        degree = self._clean_text(text[split_idx:])
        return institution, degree

    def _split_table_columns(self, raw_line: str, max_columns: int = 3) -> List[str]:
        """Split a row into table-like columns using preserved spacing."""
        if not raw_line:
            return []

        parts = re.split(r"\s{2,}|\t+", raw_line.strip(), maxsplit=max_columns - 1)
        return [self._clean_text(part) for part in parts if self._clean_text(part)]

    def _split_bullet_segments(self, raw_line: str) -> List[str]:
        """Split lines that contain one or more bullet items into independent segments."""
        if not raw_line:
            return []

        segments = [
            self._clean_text(segment)
            for segment in self.BULLET_RE.split(raw_line)
            if self._clean_text(segment)
        ]
        return segments

    def _should_merge_cert_line(self, previous: str, current: str) -> bool:
        if not previous:
            return False
        if previous.endswith((",", ";", ":", "-", "ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“", "ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â")):
            return True
        return bool(re.match(r"^[a-zÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â -ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¶ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸-ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿]", current))

    def _find_section_lines(self, start_keywords: List[str], end_keywords: List[str], lines: List[str]) -> List[str]:
        """Find lines between section start and end markers."""
        start_idx = -1
        end_idx = len(lines)

        for i, line in enumerate(lines):
            if any(self._match_keyword(line, keyword) for keyword in start_keywords):
                start_idx = i
                break

        if start_idx == -1:
            return []

        for i in range(start_idx + 1, len(lines)):
            # Section headers should be short; ignore long natural sentences
            if len(lines[i].split()) > 7:
                continue
            if any(self._match_keyword(lines[i], keyword) for keyword in end_keywords):
                end_idx = i
                break

        return lines[start_idx:end_idx]

    def _is_cert_section_header_line(self, line: str) -> bool:
        line_clean = self._clean_text(line)
        line_norm = self._normalize_for_match(line_clean)
        if not line_norm:
            return False

        if line_norm in {
            "certification",
            "certifications",
            "certificat",
            "certificats",
            "certificats obtenus",
            "certificate",
            "certificates",
        }:
            return True

        has_cert_col = bool(
            re.search(
                r"\b(certificat|certificats|certification|certifications|certificate|certificates)\b",
                line_norm,
            )
        )
        has_date_col = bool(re.search(r"\b(date|obtention|obtained)\b", line_norm))
        if has_cert_col and has_date_col:
            return True

        word_count = len(line_norm.split())
        starts_with_cert = bool(
            re.match(
                r"^(certificat|certificats|certification|certifications|certificate|certificates)\b",
                line_norm,
            )
        )
        ends_with_cert = bool(
            re.search(
                r"\b(certificat|certificats|certification|certifications|certificate|certificates)$",
                line_norm,
            )
        )
        return word_count <= 6 and (starts_with_cert or ends_with_cert)

    def _find_certification_section_lines(self, end_keywords: List[str], lines: List[str]) -> List[str]:
        """Find certification lines while avoiding false starts inside project descriptions."""
        start_idx = -1
        end_idx = len(lines)

        for i, line in enumerate(lines):
            if self._is_cert_section_header_line(line):
                start_idx = i
                break

        if start_idx == -1:
            return []

        for i in range(start_idx + 1, len(lines)):
            current_line = lines[i]
            if any(self._match_keyword(current_line, keyword) for keyword in end_keywords):
                end_idx = i
                break
            if self._is_cert_section_header_line(current_line):
                end_idx = i
                break

        return lines[start_idx:end_idx]

    def _is_header_line(self, line: str, section_type: str = "") -> bool:
        line_norm = self._normalize_for_match(line)

        if not line_norm:
            return True
        if self._is_page_artifact(line_norm):
            return True

        header_patterns = [
            r"^(periode|period|date|annee|organisme|company|entreprise|fonction|function|title|position|titre)\b",
            r"^(certificat|certification|certificats|certifications)\b",
            r"^(date d[' ]obtention|date obtained)\b",
            r"^(diplome|degree|diploma|institution|etablissement)\b",
            r"^(projet|project|client|description)\b",
            r"^(competence|competences|skill|skills|technologie|technology)\b",
            r"^(competences supplementaires|additional skills)\b",
        ]

        for pattern in header_patterns:
            if re.search(pattern, line_norm):
                return True

        # Use the shared taxonomy to detect section heading lines so that
        # compound titles like "Professional Experience & Projects" or
        # "Certifications & Hackathons" are recognized and skipped as headers.
        if section_type:
            _detected = _classify_section_heading(line)
            # Map parser's legacy singular names to taxonomy plural names.
            _parser_to_taxonomy = {"certification": "certifications", "project": "projects"}
            _expected = _parser_to_taxonomy.get(section_type, section_type)
            if _detected == _expected:
                return True

        return False

    def _is_cert_header_or_column_line(self, line: str) -> bool:
        """Detect certification section headers without dropping real cert names."""
        line_norm = self._normalize_for_match(line)
        if not line_norm:
            return True

        if line_norm in {
            "certification",
            "certifications",
            "certificat",
            "certificats",
            "certificats obtenus",
            "certificate",
            "certificates",
        }:
            return True

        # Column header rows like "Certificats  Date d'obtention".
        has_cert_col = bool(re.search(r"\b(certificat|certificats|certification|certifications|certificate|certificates)\b", line_norm))
        has_date_col = bool(re.search(r"\b(date|obtention|obtained)\b", line_norm))
        if has_cert_col and has_date_col:
            return True
        if re.fullmatch(r"date(?:\s+d[' ]?obtention|\s+obtention|\s+obtained)?", line_norm):
            return True

        return False

    def _extract_name(self, text: str, lines: List[str]) -> Tuple[str, str]:
        """Extract first and last name from CV header."""
        first_name, last_name = "", ""

        if lines:
            first_line = lines[0]
            first_line_norm = self._normalize_for_match(first_line)
            blocked_keywords = [
                "experience",
                "formation",
                "education",
                "email",
                "tel",
                "phone",
                "adresse",
                "address",
                "certification",
                "skills",
            ]
            if not any(keyword in first_line_norm for keyword in blocked_keywords):
                name_parts = first_line.split()
                if len(name_parts) >= 2:
                    first_name = name_parts[0]
                    last_name = " ".join(name_parts[1:])

        if not first_name:
            text_norm = self._normalize_for_match(text)
            email_pos = text_norm.find("email")
            phone_pos = text_norm.find("tel")
            if phone_pos == -1:
                phone_pos = text_norm.find("phone")

            search_end = min(
                email_pos if email_pos != -1 else len(text),
                phone_pos if phone_pos != -1 else len(text),
            )

            if search_end < len(text):
                header_text = text[:search_end]
                header_lines = [l.strip() for l in header_text.split("\n") if l.strip()]
                for line in header_lines[:3]:
                    words = line.split()
                    if 2 <= len(words) <= 4 and not any(kw in line.lower() for kw in ["cv", "resume", "curriculum", "vitae"]):
                        first_name = words[0]
                        last_name = " ".join(words[1:])
                        break

        # Reorder probable "LAST FIRST" headers using email hint for uppercase-style names.
        email = self._extract_email(text)
        candidate_tokens = [t for t in ([first_name] + last_name.split()) if t]
        if email and len(candidate_tokens) >= 2 and candidate_tokens[0].isupper():
            local_part = email.split("@", 1)[0].strip().lower()
            local_tokens = [token for token in re.split(r"[._-]+", local_part) if token]
            first_initial = local_tokens[0][0] if local_tokens else ""

            if first_initial:
                lead_idx = -1
                for idx, token in enumerate(candidate_tokens[1:], start=1):
                    token_norm = self._normalize_for_match(token)
                    if token_norm.startswith(first_initial):
                        lead_idx = idx
                        break

                if lead_idx != -1:
                    reordered = [candidate_tokens[lead_idx]] + [
                        token for idx, token in enumerate(candidate_tokens) if idx != lead_idx
                    ]
                    first_name = reordered[0]
                    last_name = " ".join(reordered[1:])
        elif email and len(candidate_tokens) >= 3:
            local_part = email.split("@", 1)[0].strip().lower()
            local_tokens = [token for token in re.split(r"[._-]+", local_part) if token]
            if len(local_tokens) >= 2:
                surname_norm = self._normalize_for_match(local_tokens[-1]).replace(" ", "")
                first_token_norm = self._normalize_for_match(candidate_tokens[0]).replace(" ", "")
                first_two_norm = self._normalize_for_match("".join(candidate_tokens[:2])).replace(" ", "")
                # Handle "Surname Middle First" while preserving compound surnames like "Bou Amor".
                if first_token_norm == surname_norm and first_two_norm != surname_norm:
                    first_name = " ".join(candidate_tokens[1:])
                    last_name = candidate_tokens[0]

        return first_name, last_name

    def _extract_email(self, text: str) -> str:
        """Extract email address."""
        patterns = [
            r"Email\s*:\s*([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})",
            r"E-mail\s*:\s*([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})",
            r"Mail\s*:\s*([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})",
            r"([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})",
        ]

        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                email = match.group(1) if match.groups() else match.group(0)
                if "@" in email and "." in email.split("@")[1]:
                    return email.strip()
        return ""

    def _extract_phone_legacy(self, text: str) -> str:
        """Extract phone number."""
        patterns = [
            r"T[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e]l(?:[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e]phone)?\s*:\s*([\+\d\s\-\(\)]+)",
            r"Tel\s*:\s*([\+\d\s\-\(\)]+)",
            r"Phone\s*:\s*([\+\d\s\-\(\)]+)",
            r"(\+\d{1,3}[\s\-]?\d{1,4}[\s\-]?\d{1,4}[\s\-]?\d{1,4}[\s\-]?\d{1,4})",
        ]

        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                phone = match.group(1) if match.groups() else match.group(0)
                phone = re.sub(r"\s+", " ", phone).strip()
                digits = re.sub(r"\D", "", phone)
                if len(digits) >= 8:
                    return phone
        return ""

    def _extract_phone(self, text: str) -> str:
        """Extract phone number using resilient header-first heuristics."""
        number_pattern = re.compile(r"(?<!\d)(?:\+\s*\d[\d\s().-]{6,}\d|\d[\d\s().-]{6,}\d)(?!\d)")

        def normalize_candidate(raw_value: str) -> str:
            candidate = self._clean_text(raw_value.replace("\xa0", " "))
            candidate = re.sub(r"[^\d+()\-\s./]", "", candidate)
            candidate = candidate.replace("(", " ").replace(")", " ")
            candidate = re.sub(r"\s+", " ", candidate).strip(" .;,:-")
            if not candidate:
                return ""
            if candidate.count("+") > 1:
                return ""
            if "+" in candidate and not candidate.lstrip().startswith("+"):
                return ""

            # Common false positives: year ranges and date fragments.
            compact = candidate.replace(" ", "")
            if re.fullmatch(r"(?:19|20)\d{2}[-/](?:19|20)\d{2}", compact):
                return ""
            if "/" in candidate and re.search(r"\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b", candidate):
                return ""

            digits = re.sub(r"\D", "", candidate)
            if len(digits) < 8 or len(digits) > 15:
                return ""
            return candidate

        lines = [line for line in text.replace("\xa0", " ").splitlines() if line.strip()]

        # Prefer header-area lines (where "Tél : ..." lives in template CVs).
        for line in lines[:60]:
            line_clean = self._clean_text(line)
            line_norm = self._normalize_for_match(line_clean)
            if "fax" in line_norm:
                continue

            has_label = bool(re.search(r"\b(tel|telephone|phone|mobile|gsm|contact)\b", line_norm))
            if not has_label and ":" not in line_clean:
                continue

            for match in number_pattern.finditer(line_clean):
                phone = normalize_candidate(match.group(0))
                if phone:
                    return phone

        # Fallback: anywhere in text.
        for match in number_pattern.finditer(text.replace("\xa0", " ")):
            phone = normalize_candidate(match.group(0))
            if phone:
                return phone
        return ""

    def _extract_address(self, text: str) -> str:
        """Extract address information."""
        stop_pattern = r"(?:Exp[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e]rience|Professional|Work|Formation|Education|Certification|Projets?|Projects?|Comp[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e]tences?|Skills?)"
        patterns = [
            rf"Adresse\s*:\s*(.+?)(?=\n\s*{stop_pattern}|\Z)",
            rf"Address\s*:\s*(.+?)(?=\n\s*{stop_pattern}|\Z)",
        ]

        for pattern in patterns:
            match = re.search(pattern, text, re.DOTALL | re.IGNORECASE)
            if not match:
                continue

            address = self._clean_text(match.group(1).replace("\n", " "))
            if len(address) > 5:
                return address
        return ""

    def _merge_broken_dates(self, lines: List[str]) -> List[str]:
        """
        Merge dates that have been fragmented across multiple lines by PyMuPDF
        (e.g., due to narrow table columns wrapping text like 'Janvier 2017 - Octobre\\n2017').
        """
        merged_lines = []
        present_pattern = r"(?:present|pr(?:[eéè\u00e9\ufffd]|&eacute;)sent|current|aujourd['’\u2019]?hui|en\s+cours|[àa]\s+ce\s+jour|maintenant|now)"
        dash_or_to = rf"(?:{self.DASH_RE}|[àa\ufffd]|to|-|jusqu['’\u2019\ufffd]?\s*[aà\ufffd]?)"
        month_re = self.MONTH_RE
        
        dangling_date_pat = re.compile(
            rf"(?i)(\b{month_re}\s+\d{{4}}\s*{dash_or_to}\s*{month_re}|\b\d{{1,2}}/\d{{4}}\s*{dash_or_to}|\b{month_re}\s+\d{{4}}\s*{dash_or_to}|\b(?:depuis|since)\s+(?:{month_re}\s+\d{{4}}|\d{{4}}))\s*$"
        )
        completion_pat = re.compile(
            rf"(?i)^(?:\d{{4}}\s*{dash_or_to}\s*{present_pattern}|\d{{4}}|\s*{dash_or_to}\s*(?:{present_pattern}|\d{{4}})|{present_pattern})"
        )
        
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            while i + 1 < len(lines):
                next_line = lines[i+1].strip()
                is_dangling = dangling_date_pat.search(line)
                is_completion = completion_pat.search(next_line) or re.fullmatch(r"(?i)\d{4}", next_line)

                ends_with_date = re.search(rf"(?i)(\b{month_re}\s+\d{{4}}|\b\d{{1,2}}/\d{{4}}|\b\d{{4}})\s*$", line)
                starts_with_dash = re.match(rf"(?i)^{dash_or_to}", next_line)
                
                if (is_dangling and is_completion) or (ends_with_date and starts_with_dash):
                    line = f"{line} {next_line}"
                    i += 1
                else:
                    break
            
            merged_lines.append(line)
            i += 1
            
        return merged_lines

    def _extract_experience(self, text: str, lines: List[str]) -> List[Dict[str, str]]:
        """Extract work experience entries."""
        start_keywords = [
            "Experience professionnelle",
            "Experiences professionnelles",
            "Professional Experience",
            "Work Experience",
            "Career History",
            "Employment History",
            "Work History",
            "Professional Background",
            "Professional History",
            "Career Summary",
            "Employment",
            "Career",
            "Experience",
            "professionnelle",
            "professionnelles",
            "Parcours professionnel",
            "Postes occupes",
            "Historique professionnel",
        ]
        end_keywords = [
            "Certification",
            "Certifications",
            "Certificat",
            "Certificats",
            "Formation",
            "Formations",
            "Education",
            "Projets",
            "Projects",
            "Skills",
            "Competences",
            "Languages",
            "Langues",
        ]

        section_lines = self._find_section_lines(start_keywords, end_keywords, lines)
        if not section_lines:
            return []

        section_lines = self._merge_broken_dates(section_lines)

        experiences: List[Dict[str, str]] = []
        current_exp: Dict[str, str] = {}

        label_mode = False
        current_label = None

        for raw_line in section_lines:
            raw_payload = raw_line.strip()
            line = self._clean_text(raw_payload)
            if not line or self._is_page_artifact(line):
                continue
            if self._is_header_line(line, "experience"):
                continue

            # Handle PyMuPDF glued lines e.g. "➔ CiscoDate : 2019"
            # Split on label keywords that appear mid-line
            split_line = re.sub(
                r"(?<!^)(Date\s*:|Soci(?:e|é)t(?:e|é)\s*:|Fonction\s*:|Description\s*:|Technologies\s*:|Pays\s*:)",
                r"\n\1", line, flags=re.IGNORECASE
            )

            handled_by_label = False
            for sub_line in split_line.split("\n"):
                sub_line = sub_line.strip()
                if not sub_line:
                    continue

                # Check for Label-Value format (Next Step template style)
                label_match = re.match(r"^(Date|Soci(?:e|é)t(?:e|é)|Fonction|Description|Technologies|Pays)\s*:\s*(.*)", sub_line, re.IGNORECASE)
                if label_match:
                    label_mode = True
                    handled_by_label = True
                    label_name = label_match.group(1).capitalize()
                    label_name = re.sub(r'Soci(?:e|é)t(?:e|é)', 'Société', label_name, flags=re.IGNORECASE)
                    label_value = label_match.group(2)
                    current_label = label_name

                    if label_name == "Date":
                        if current_exp.get("start_date") or current_exp.get("company"):
                            experiences.append(current_exp)
                            current_exp = {}
                        current_exp["start_date"] = label_value
                    elif label_name == "Société":
                        current_exp["company"] = label_value
                    elif label_name == "Fonction":
                        current_exp["title"] = label_value
                    elif label_name in ["Description", "Technologies", "Pays"]:
                        existing_desc = current_exp.get("description", "")
                        separator = "\n" if existing_desc else ""
                        current_exp["description"] = f"{existing_desc}{separator}{label_name} : {label_value}"
                    continue

                if label_mode and current_label:
                    handled_by_label = True
                    # Only Description/Technologies/Pays accumulate multi-line content.
                    # Société and Fonction are single-line; unlabeled continuations go to description.
                    if current_label in ["Description", "Technologies", "Pays", "Date"]:
                        existing_desc = current_exp.get("description", "")
                        separator = "\n" if existing_desc else ""
                        current_exp["description"] = f"{existing_desc}{separator}{sub_line}".strip()
                    else:
                        # Société/Fonction continuation lines are really description overflow
                        existing_desc = current_exp.get("description", "")
                        separator = "\n" if existing_desc else ""
                        current_exp["description"] = f"{existing_desc}{separator}{sub_line}".strip()
                    continue

            if handled_by_label:
                continue

            # Standard parsing
            line_clean = line
            if not line_clean:
                continue

            # Intercept orphaned date completions (e.g., "- Aujourd'hui", "2017") at START of line
            # before they trigger a new experience extraction.
            if current_exp.get("start_date"):
                dash_or_to = rf"(?:{self.DASH_RE}|[àa\ufffd]|to|-|jusqu['’\u2019\ufffd]?\s*[aà\ufffd]?)"
                present_pattern = r"(?:present|pr(?:[eéè\u00e9\ufffd]|&eacute;)sent|current|aujourd['’\u2019]?hui|en\s+cours|[àa]\s+ce\s+jour|maintenant|now)"
                
                is_incomplete = re.search(rf"(?i)({dash_or_to}|{self.MONTH_RE}|depuis|since)\s*$", current_exp["start_date"].strip())
                if is_incomplete:
                    completion_pat = re.compile(
                        rf"(?i)^(?:\s*{dash_or_to}\s*(?:{present_pattern}|\d{{4}})|{present_pattern}|\d{{4}}\s*{dash_or_to}\s*{present_pattern}|\d{{4}})"
                    )
                    completion_match = completion_pat.search(line_clean)
                    if completion_match:
                        completion_str = completion_match.group(0).strip()
                        if completion_str.lower() != current_exp["start_date"].strip().lower():
                            current_exp["start_date"] = self._clean_text(
                                f"{current_exp['start_date']} {completion_str}"
                            )
                        remaining = self._clean_text(line_clean[completion_match.end():])
                        company, title = self._split_company_and_title(remaining)
                        if company and title:
                             if not current_exp.get("company"): current_exp["company"] = company
                             if not current_exp.get("title"): current_exp["title"] = title
                        elif company:
                             current_exp["title"] = f"{current_exp.get('title', '')} {company}".strip()
                        
                        continue

            date_str = self._extract_date_from_line(raw_payload)
            if date_str:
                if current_exp.get("start_date") or current_exp.get("company"):
                    experiences.append(current_exp)

                remaining = raw_payload.replace(date_str, "", 1)
                company, title = self._split_company_and_title(remaining)
                current_exp = {
                    "start_date": date_str,
                    "company": company,
                    "title": title,
                }
                continue

            if not current_exp.get("start_date") and not current_exp.get("company"):
                continue

            line_clean = line
            if not line_clean:
                continue

            # Handle orphaned date completions (e.g., "- Aujourd'hui", "2017") at START of line
            # that belong to the previous date range, due to PyMuPDF column table fusing.
            present_pattern = r"(?:present|pr(?:[eéè\u00e9\ufffd]|&eacute;)sent|current|aujourd['’\u2019]?hui|en\s+cours|[àa]\s+ce\s+jour|maintenant|now)"
            dash_or_to = rf"(?:{self.DASH_RE}|[àa\ufffd]|to|-|jusqu['’\u2019\ufffd]?\s*[aà\ufffd]?)"
            completion_pat = re.compile(
                rf"(?i)^(?:\s*{dash_or_to}\s*(?:{present_pattern}|\d{{4}})|{present_pattern}|\d{{4}}\s*{dash_or_to}\s*{present_pattern}|\d{{4}})"
            )
            completion_match = completion_pat.search(line_clean)
            if completion_match and current_exp.get("start_date"):
                completion_str = completion_match.group(0).strip()
                current_exp["start_date"] = self._clean_text(
                    f"{current_exp['start_date']} {completion_str}"
                )
                line_clean = self._clean_text(line_clean[completion_match.end():])
                if not line_clean:
                    continue

            if not current_exp.get("company") and not current_exp.get("title"):
                company, title = self._split_company_and_title(line_clean)
                current_exp["company"] = company
                current_exp["title"] = title
            elif not current_exp.get("title"):
                company, title = self._split_company_and_title(line_clean)
                if title:
                    if not current_exp.get("company"):
                        current_exp["company"] = company
                    current_exp["title"] = title
                else:
                    current_exp["title"] = line_clean
            elif not current_exp.get("company"):
                company, title = self._split_company_and_title(line_clean)
                if company and title:
                    current_exp["company"] = company
                    current_exp["title"] = self._clean_text(f"{title} {current_exp['title']}")
                else:
                    current_exp["company"] = line_clean
            else:
                separator = " / " if self.BULLET_RE.search(raw_payload) else " "
                current_exp["title"] = self._clean_text(f"{current_exp['title']}{separator}{line_clean}")

        if current_exp.get("start_date") or current_exp.get("company"):
            experiences.append(current_exp)

        cleaned_experience: List[Dict[str, str]] = []
        for exp in experiences:
            start_date = self._clean_text(exp.get("start_date", ""))
            company = self._clean_text(exp.get("company", ""))
            title = self._clean_text(exp.get("title", ""))

            # Heuristic: some parsers/table extractions can shift columns so a date range ends up
            # in the "company" field. Example observed:
            #   start_date="Juillet 2015"
            #   company="Juillet 2015-Septembre2015"
            #   title="Next Step IT (Mission à ...)"
            if company and start_date:
                start_is_month_year = re.fullmatch(rf"(?i)\s*{self.MONTH_RE}\s+\d{{4}}\s*", start_date) is not None
                company_has_year = re.search(r"\b(19|20)\d{2}\b", company) is not None
                company_has_dash = re.search(rf"\s*{self.DASH_RE}\s*", company) is not None
                company_has_month = re.search(rf"(?i)\b{self.MONTH_RE}\b", company) is not None
                if start_is_month_year and company_has_year and company_has_dash and company_has_month:
                    normalized_range = self._clean_text(company)
                    # Fix common "Septembre2015" missing space.
                    normalized_range = re.sub(
                        rf"(?i)({self.MONTH_RE})(\d{{4}})\b",
                        r"\1 \2",
                        normalized_range,
                    )
                    start_date = normalized_range

                    if title:
                        paren_match = re.match(r"^(.*?)\s*\((.+)\)\s*$", title)
                        if paren_match:
                            maybe_company = self._clean_text(paren_match.group(1))
                            maybe_title = self._clean_text(paren_match.group(2))
                            if maybe_company:
                                company = maybe_company
                                title = maybe_title
                        else:
                            split_company, split_title = self._split_company_and_title(title)
                            if split_company and not split_title:
                                split_company, split_title = self._split_company_title_fallback(title)
                            if split_company:
                                company = split_company
                                title = split_title

            if company and title:
                company_norm = self._normalize_for_match(company)
                title_norm = self._normalize_for_match(title)
                if title_norm.startswith(company_norm):
                    title = self._clean_text(title[len(company):])

            if company and not title:
                split_company, split_title = self._split_company_and_title(company)
                if split_company and not split_title:
                    split_company, split_title = self._split_company_title_fallback(company)
                if split_company and split_title:
                    company, title = split_company, split_title

            if not company and title:
                split_company, split_title = self._split_company_and_title(title)
                if split_company and not split_title:
                    split_company, split_title = self._split_company_title_fallback(title)
                if split_company and split_title:
                    company, title = split_company, split_title

            if not start_date and not company:
                continue

            cleaned_entry = {
                "start_date": start_date,
                "company": company,
                "title": title,
            }
            if "description" in exp:
                cleaned_entry["description"] = self._clean_text(exp["description"])
            
            cleaned_experience.append(cleaned_entry)

        return cleaned_experience

    def _extract_certifications_from_tables(self, file_path: str) -> List[Dict[str, str]]:
        """Extract certifications using detected PDF table cells when available."""
        if not file_path.lower().endswith(".pdf"):
            return []

        cert_rows: List[Dict[str, str]] = []
        cert_anchor_pattern = re.compile(
            r"(?i)\b("
            r"certified|certification|certificate|certificat|associate|professional|"
            r"network|routing|switching|cisco|ccna|ccnp|dell|hp|kemp|acfe|acps|acsr"
            r")\b"
        )
        cert_code_pattern = re.compile(r"(?i)(\b[A-Z]{2,}\d{2,}\b|\(\d{3}[-/]\d{3}\))")

        try:
            with fitz.open(file_path) as doc:
                for page in doc:
                    page_text = self._normalize_for_match(page.get_text("text"))
                    if not any(
                        keyword in page_text
                        for keyword in ("certification", "certifications", "certificat", "certificats", "certificate")
                    ):
                        continue

                    try:
                        tables = page.find_tables().tables
                    except Exception:
                        continue

                    for table in tables:
                        rows = table.extract() or []
                        if not rows:
                            continue

                        clean_rows: List[List[str]] = []
                        for row in rows:
                            cells = [self._clean_text(str(cell) if cell is not None else "") for cell in row]
                            clean_rows.append(cells)

                        header = clean_rows[0] if clean_rows else []
                        header_norm = " ".join(self._normalize_for_match(cell) for cell in header if cell)
                        has_cert_header = "certificat" in header_norm or "certification" in header_norm or "certificate" in header_norm
                        has_date_header = "date" in header_norm and (
                            "obtention" in header_norm or "obtained" in header_norm or "obten" in header_norm
                        )
                        data_rows = clean_rows[1:] if has_cert_header else clean_rows
                        if not data_rows:
                            continue

                        cert_like_rows = 0
                        date_like_rows = 0
                        for row in data_rows:
                            joined = self._clean_text(" ".join(cell for cell in row if cell))
                            if not joined:
                                continue
                            if self._extract_date_token(joined):
                                date_like_rows += 1
                            if cert_anchor_pattern.search(joined) or cert_code_pattern.search(joined):
                                cert_like_rows += 1

                        is_cert_table = (has_cert_header and has_date_header) or (
                            cert_like_rows >= max(2, len(data_rows) // 2) and date_like_rows >= 1
                        )
                        if not is_cert_table:
                            continue

                        date_col_idx = -1
                        if has_date_header:
                            for idx, cell in enumerate(header):
                                norm_cell = self._normalize_for_match(cell)
                                if "date" in norm_cell and (
                                    "obtention" in norm_cell or "obtained" in norm_cell or "obten" in norm_cell
                                ):
                                    date_col_idx = idx
                                    break

                        for row in data_rows:
                            if not row:
                                continue
                            if all(not self._clean_text(cell) for cell in row):
                                continue

                            date = ""
                            name_parts: List[str] = []

                            for idx, raw_cell in enumerate(row):
                                cell = self._clean_text(raw_cell)
                                if not cell:
                                    continue
                                if self._is_cert_header_or_column_line(cell):
                                    continue

                                if date_col_idx >= 0 and idx == date_col_idx:
                                    detected = self._extract_date_token(cell)
                                    if detected:
                                        date = detected
                                        remainder = self._clean_text(cell.replace(detected, "", 1))
                                        if remainder and not self._looks_like_date_only(remainder):
                                            name_parts.append(remainder)
                                    else:
                                        name_parts.append(cell)
                                    continue

                                detected = self._extract_date_token(cell)
                                if detected and not date:
                                    remainder = self._clean_text(cell.replace(detected, "", 1))
                                    if remainder and self._looks_like_date_only(remainder):
                                        date = detected
                                    elif remainder and len(remainder.split()) <= 3:
                                        name_parts.append(remainder)
                                        date = detected
                                    elif not remainder:
                                        date = detected
                                    else:
                                        name_parts.append(cell)
                                    continue

                                name_parts.append(cell)

                            name = self._clean_text(" ".join(name_parts))
                            name = self._collapse_repeated_phrase(self._strip_date_noise_from_cert_name(name))
                            if not name:
                                continue
                            if self._looks_like_date_only(name):
                                continue
                            cert_rows.append({"name": name, "date_obtained": date})
        except Exception:
            return []

        return cert_rows

    def _extract_certifications(self, text: str, lines: List[str], file_path: Optional[str] = None) -> List[Dict[str, str]]:
        """Extract certification entries."""
        end_keywords = [
            "Formation",
            "Formations",
            "Education",
            "Academic",
            "Projets",
            "Projects",
            "Skills",
            "Experience",
        ]

        table_certifications: List[Dict[str, str]] = []
        if file_path:
            table_certifications = self._extract_certifications_from_tables(file_path)

        section_lines = self._find_certification_section_lines(end_keywords, lines)
        if not section_lines and not table_certifications:
            return []

        certifications: List[Dict[str, str]] = []
        pending_name = ""

        cert_anchor_pattern = re.compile(
            r"(?i)\b("
            r"certified|certification|certificate|certificat|associate|professional|"
            r"network|routing|switching|cisco|ccna|ccnp|dell|hp|kemp|acfe|acps|acsr"
            r")\b"
        )
        cert_code_pattern = re.compile(r"(?i)(\b[A-Z]{2,}\d{2,}\b|\(\d{3}[-/]\d{3}\))")
        cert_fragment_phrases = {
            "troubleshooting",
            "routing",
            "switching",
            "technical training",
        }

        def is_cert_fragment(value: str) -> bool:
            cleaned = self._clean_text(value)
            if not cleaned:
                return False

            norm = self._normalize_for_match(cleaned)
            if not norm:
                return False

            if re.fullmatch(r"icnd1(?:\s*[-–]\s*|\s+)icnd2", norm):
                return True

            if norm in cert_fragment_phrases:
                return True

            words = [w for w in norm.split() if w]
            if len(words) <= 2:
                # Avoid merging uppercase acronym-like standalone certifications.
                if re.search(r"\b[A-Z]{2,}\b", cleaned):
                    return False
                return True

            return False

        def should_attach_to_previous_cert(fragment: str, previous_name: str) -> bool:
            fragment_clean = self._clean_text(fragment)
            previous_clean = self._clean_text(previous_name)
            if not fragment_clean or not previous_clean:
                return False

            if fragment_clean[0].islower():
                return True

            if previous_clean.endswith((",", ";", ":", "-", "/", "(")):
                return True

            fragment_norm = self._normalize_for_match(fragment_clean)
            if fragment_norm.startswith(("et ", "and ", "de ", "du ", "des ", "d'", "l'", "(")):
                return True

            has_anchor = bool(cert_anchor_pattern.search(previous_clean) or cert_code_pattern.search(previous_clean))
            return has_anchor and is_cert_fragment(fragment_clean)

        if table_certifications:
            certifications.extend(table_certifications)

        for raw_line in section_lines:
            line = self._clean_text(raw_line)
            if not line or self._is_page_artifact(line):
                continue
            if self._is_cert_header_or_column_line(line):
                continue

            date_str = self._extract_date_token(line)
            if date_str:
                cert_name = self._collapse_repeated_phrase(
                    self._strip_date_noise_from_cert_name(
                        self._clean_text(line.replace(date_str, "", 1))
                    )
                )
                if self._looks_like_date_only(cert_name):
                    cert_name = ""
                if pending_name:
                    if certifications and should_attach_to_previous_cert(pending_name, certifications[-1]["name"]):
                        certifications[-1]["name"] = self._clean_text(
                            f"{certifications[-1]['name']} {pending_name}"
                        )
                    elif cert_name and should_attach_to_previous_cert(pending_name, cert_name):
                        cert_name = self._clean_text(f"{cert_name} {pending_name}")
                    else:
                        pending_date = date_str if len(pending_name.split()) <= 4 else ""
                        certifications.append({"name": pending_name, "date_obtained": pending_date})
                    pending_name = ""

                if cert_name:
                    certifications.append({"name": cert_name, "date_obtained": date_str})
                continue

            if certifications and not pending_name and should_attach_to_previous_cert(line, certifications[-1]["name"]):
                certifications[-1]["name"] = self._clean_text(f"{certifications[-1]['name']} {line}")
                continue

            line = self._collapse_repeated_phrase(self._strip_date_noise_from_cert_name(line))
            if not line or self._looks_like_date_only(line):
                continue

            if pending_name:
                if should_attach_to_previous_cert(line, pending_name):
                    pending_name = self._clean_text(f"{pending_name} {line}")
                else:
                    certifications.append({"name": pending_name, "date_obtained": ""})
                    pending_name = line
            else:
                pending_name = line

        if pending_name:
            if certifications and should_attach_to_previous_cert(pending_name, certifications[-1]["name"]):
                certifications[-1]["name"] = self._clean_text(f"{certifications[-1]['name']} {pending_name}")
            else:
                certifications.append({"name": pending_name, "date_obtained": ""})

        unique_certifications: List[Dict[str, str]] = []
        seen = set()

        for cert in certifications:
            name = self._clean_text(cert.get("name", ""))
            name = self._collapse_repeated_phrase(self._strip_date_noise_from_cert_name(name))
            date_obtained = self._clean_text(cert.get("date_obtained", ""))
            if not name:
                continue
            if self._looks_like_date_only(name):
                continue
            if self._is_cert_header_or_column_line(name):
                continue

            key = f"{self._normalize_for_match(name)}|{self._normalize_for_match(date_obtained)}"
            if key in seen:
                continue

            seen.add(key)
            unique_certifications.append(
                {
                    "name": name,
                    "date_obtained": date_obtained,
                }
            )

        consolidated_certifications: List[Dict[str, str]] = []
        name_to_index: Dict[str, int] = {}

        for cert in unique_certifications:
            name_key = self._normalize_for_match(cert["name"])
            date_key = self._normalize_for_match(cert["date_obtained"])
            if not name_key:
                continue

            if name_key not in name_to_index:
                name_to_index[name_key] = len(consolidated_certifications)
                consolidated_certifications.append(
                    {
                        "name": cert["name"],
                        "date_obtained": cert["date_obtained"],
                    }
                )
                continue

            existing_idx = name_to_index[name_key]
            existing = consolidated_certifications[existing_idx]
            existing_date_key = self._normalize_for_match(existing["date_obtained"])

            if existing_date_key == date_key:
                continue
            if not existing_date_key and date_key:
                consolidated_certifications[existing_idx] = {
                    "name": cert["name"],
                    "date_obtained": cert["date_obtained"],
                }
                continue
            if existing_date_key and not date_key:
                continue

            consolidated_certifications.append(
                {
                    "name": cert["name"],
                    "date_obtained": cert["date_obtained"],
                }
            )

        merged_certifications: List[Dict[str, str]] = []
        for cert in consolidated_certifications:
            if (
                merged_certifications
                and should_attach_to_previous_cert(cert["name"], merged_certifications[-1]["name"])
                and (
                    not cert["date_obtained"]
                    or cert["date_obtained"] == merged_certifications[-1]["date_obtained"]
                )
            ):
                merged_certifications[-1]["name"] = self._clean_text(
                    f"{merged_certifications[-1]['name']} {cert['name']}"
                )
                if not merged_certifications[-1]["date_obtained"] and cert["date_obtained"]:
                    merged_certifications[-1]["date_obtained"] = cert["date_obtained"]
                continue

            merged_certifications.append(
                {
                    "name": cert["name"],
                    "date_obtained": cert["date_obtained"],
                }
            )

        return merged_certifications

    def _extract_education_from_tables(self, file_path: str) -> List[Dict[str, str]]:
        """Extract education using detected PDF table cells when available."""
        if not file_path or not file_path.lower().endswith(".pdf"):
            return []

        edu_rows: List[Dict[str, str]] = []
        try:
            with fitz.open(file_path) as doc:
                for page in doc:
                    page_text = self._normalize_for_match(page.get_text("text"))
                    if not any(
                        keyword in page_text
                        for keyword in ("formation", "education", "diplome", "academic")
                    ):
                        continue

                    try:
                        tables = page.find_tables().tables
                    except Exception:
                        continue

                    for table in tables:
                        rows = table.extract() or []
                        if not rows:
                            continue

                        clean_rows: List[List[str]] = []
                        for row in rows:
                            cells = [self._clean_text(str(cell) if cell is not None else "") for cell in row]
                            clean_rows.append(cells)

                        header = clean_rows[0] if clean_rows else []
                        header_norm = " ".join(self._normalize_for_match(cell) for cell in header if cell)
                        
                        if "projet" in header_norm or "project" in header_norm or "client" in header_norm:
                            continue
                        if "certificat" in header_norm or "certification" in header_norm:
                            continue
                        if header_norm.strip() in ["periode formation", "period training", "formation periode"]:
                            continue
                            
                        has_edu_table = "diplome" in header_norm or "institution" in header_norm or "annee" in header_norm
                        
                        data_rows = clean_rows[1:] if has_edu_table else clean_rows
                        if not data_rows:
                            continue

                        # Anti-patterns: if table contains experience/project specific labels, skip
                        exp_labels = {"societe", "fonction", "client", "technologies", "description"}
                        is_exp_table = any(
                            self._normalize_for_match(cell) in exp_labels
                            for row in clean_rows for cell in row
                        )
                        if is_exp_table:
                            continue

                        year_like_rows = 0
                        for row in data_rows:
                            joined = self._clean_text(" ".join(cell for cell in row if cell))
                            if not joined:
                                continue
                            if re.search(r"\b(?:19|20)\d{2}\b", joined):
                                year_like_rows += 1

                        # Require strong degree keywords if the header doesn't explicitly look like education
                        strong_degree_keys = ("diplome", "master", "licence", "bachelor", "ingenieur", "phd", "doctorat")
                        has_strong_degree = any(
                            any(k in self._normalize_for_match(c) for k in strong_degree_keys)
                            for r in data_rows for c in r if len(c.split()) < 25
                        )
                        
                        is_edu_table = has_edu_table or (
                            year_like_rows >= max(2, len(data_rows) // 2) and has_strong_degree
                        )
                        
                        if not is_edu_table:
                            continue

                        for row in data_rows:
                            if not row:
                                continue
                            
                            dense_row = [self._clean_text(cell) for cell in row if self._clean_text(cell)]
                            if not dense_row:
                                continue

                            date = ""
                            institution = ""
                            degree = ""
                            
                            if len(dense_row) >= 3:
                                # Assume standard Année, Institution, Diplôme
                                date = dense_row[0]
                                institution = dense_row[1]
                                degree = " ".join(dense_row[2:])
                            else:
                                # Fallback scanning
                                for cell in dense_row:
                                    if re.search(r"^(annee|institution|diplome|degree)\b", self._normalize_for_match(cell)):
                                        continue

                                    detected = self._extract_month_year(cell) or (re.search(r"\b(?:19|20)\d{2}\b", cell) and re.search(r"\b(?:19|20)\d{2}\b", cell).group(0))
                                    if detected and not date:
                                        remainder = self._clean_text(cell.replace(detected, "", 1))
                                        if remainder:
                                            institution = remainder
                                        date = detected
                                    elif not institution:
                                        institution = cell
                                    else:
                                        degree = self._clean_text(f"{degree} {cell}")
                            
                            if not date and not institution and not degree:
                                continue
                            if not date and not degree:
                                # Skip floating text shards created by PyMuPDF row wraps
                                continue
                            edu_rows.append({"end_date": date, "institution": institution, "degree": degree})
        except Exception as e:
            logger.warning(f"Failed to extract education tables: {e}")
            return []

        return edu_rows

    def _extract_education(self, text: str, lines: List[str], file_path: Optional[str] = None) -> List[Dict[str, str]]:
        """Extract education entries from table and wrapped-line formats."""
        start_keywords = [
            "Formation academique",
            "Formations academiques",
            "Formation et diplomes",
            "Academic Background",
            "Academic History",
            "Academic Training",
            "Qualifications",
            "Schooling",
            "Studies",
            "Training",
            "Education",
            "Formation",
            "Formations",
            "Etudes",
            "Diplomes",
            "Diplomas",
            "Parcours academique",
            "Parcours scolaire",
        ]
        end_keywords = [
            "Projets",
            "Projects",
            "Realisations",
            "Competences",
            "Skills",
            "Core Competencies",
            "Certification",
            "Certifications",
            "Certificats",
            "Experience",
            "Career",
            "Employment",
            "Langues",
            "Languages",
        ]

        section_lines = []
        start_idx = -1
        end_idx = len(lines)

        for i, line in enumerate(lines):
            line_norm = self._normalize_for_match(line)
            if any(self._match_keyword(line, keyword) for keyword in start_keywords):
                # Ensure we don't accidentally match "Formations et certifications" as academic education
                if "certification" not in line_norm and "certificat" not in line_norm:
                    start_idx = i
                    break

        if start_idx != -1:
            for i in range(start_idx + 1, len(lines)):
                if any(self._match_keyword(lines[i], keyword) for keyword in end_keywords):
                    end_idx = i
                    break
            section_lines = lines[start_idx:end_idx]

        table_education: List[Dict[str, str]] = []
        if file_path:
            table_education = self._extract_education_from_tables(file_path)
            
        if table_education:
            normalized_table_education: List[Dict[str, str]] = []
            for edu in table_education:
                end_date = self._clean_text(edu.get("end_date", ""))
                institution = self._collapse_repeated_phrase(self._clean_text(edu.get("institution", "")))
                degree = self._collapse_repeated_phrase(self._clean_text(edu.get("degree", "")))
                institution = self._clean_text(re.sub(r"(?i)\b(et|and|de|du|des|d')\s*$", "", institution))
                degree = self._clean_text(re.sub(r"(?i)\b(et|and|de|du|des|d')\s*$", "", degree))
                if not end_date:
                    continue
                if not institution and not degree:
                    continue
                normalized_table_education.append(
                    {
                        "end_date": end_date,
                        "institution": institution,
                        "degree": degree,
                    }
                )
            return normalized_table_education

        if not section_lines:
            return []

        section_lines = self._merge_broken_dates(section_lines)

        education: List[Dict[str, str]] = []
        current_edu: Dict[str, str] = {}
        pending_institution_parts: List[str] = []
        pending_degree_parts: List[str] = []

        year_pattern = re.compile(
            rf"^\s*(?:[-\u2013\u2014]\s*)?((?:19|20)\d{{2}})(?:\s*{self.DASH_RE}\s*((?:19|20)\d{{2}}))?\b(.*)$",
            re.IGNORECASE,
        )

        degree_markers = [
            "diplome",
            "licence",
            "master",
            "baccalaureat",
            "ingenieur",
            "doctorat",
            "phd",
            "bachelor",
            "degree",
            "classes preparatoires",
            "technicien",
            "option",
            "specialite",
        ]

        connector_suffixes = (
            " de",
            " d",
            " d'",
            " du",
            " des",
            " la",
            " le",
            " l'",
            " et",
            " en",
            " au",
            " aux",
        )

        def looks_like_degree(value: str) -> bool:
            norm = self._normalize_for_match(value)
            if not norm:
                return False
            return any(marker in norm for marker in degree_markers)

        def ends_with_connector(value: str) -> bool:
            norm = self._normalize_for_match(value)
            return any(norm.endswith(suffix) for suffix in connector_suffixes)

        def should_continue_institution(current_value: str, candidate: str) -> bool:
            if not candidate:
                return False
            if ends_with_connector(current_value):
                return True
            if len(candidate.split()) <= 2:
                return True
            candidate_norm = self._normalize_for_match(candidate)
            return bool(candidate_norm and candidate_norm[0:1].islower())

        def should_continue_degree(current_value: str, candidate: str) -> bool:
            if not candidate:
                return False
            candidate_norm = self._normalize_for_match(candidate)
            if candidate_norm.startswith(("option", "specialite", "de ", "du ", "des ", "et ", "en ", "(")):
                return True
            if len(candidate.split()) <= 2:
                return True
            return ends_with_connector(current_value)

        def merge_text(base: str, extra: str, prepend: bool = False) -> str:
            base_clean = self._clean_text(base)
            extra_clean = self._clean_text(extra)
            if not base_clean:
                return extra_clean
            if not extra_clean:
                return base_clean
            if prepend:
                return self._clean_text(f"{extra_clean} {base_clean}")
            return self._clean_text(f"{base_clean} {extra_clean}")

        def split_table_tokens(raw_value: str) -> List[str]:
            if not raw_value:
                return []
            parts = re.split(r"\s{2,}|\t+", raw_value.rstrip())
            return [self._clean_text(part) for part in parts if self._clean_text(part)]

        def split_line_parts(raw_value: str) -> Tuple[str, str]:
            tokens = split_table_tokens(raw_value)
            if not tokens:
                return "", ""

            leading_spaces = len(raw_value) - len(raw_value.lstrip())
            if len(tokens) >= 2:
                institution = tokens[0]
                degree = self._clean_text(" ".join(tokens[1:]))
                return institution, degree

            token = tokens[0]
            if looks_like_degree(token) or leading_spaces >= 34:
                return "", token
            return token, ""

        def next_significant_index(start_idx: int) -> Optional[int]:
            idx = start_idx
            while idx < len(section_lines):
                raw_next = section_lines[idx].rstrip()
                line_next = self._clean_text(raw_next)
                year_next = bool(year_pattern.match(raw_next))
                if (
                    not line_next
                    or (self._is_page_artifact(line_next) and not year_next)
                    or (self._is_header_line(line_next, "education") and not year_next)
                ):
                    idx += 1
                    continue
                return idx
            return None

        def flush_current() -> None:
            nonlocal current_edu
            end_date = self._clean_text(current_edu.get("end_date", ""))
            institution = self._clean_text(current_edu.get("institution", ""))
            degree = self._clean_text(current_edu.get("degree", ""))

            if not end_date:
                current_edu = {}
                return
            if not institution and not degree:
                current_edu = {}
                return

            education.append(
                {
                    "end_date": end_date,
                    "institution": institution,
                    "degree": degree,
                }
            )
            current_edu = {}

        for idx, raw_line in enumerate(section_lines):
            raw = raw_line.rstrip()
            line = self._clean_text(raw)
            year_match = year_pattern.match(raw)
            is_year_line = bool(year_match)

            if not line:
                continue
            if self._is_page_artifact(line) and not is_year_line:
                continue

            line_norm = self._normalize_for_match(line)
            if not is_year_line:
                if line_norm in {
                    "formation",
                    "formation academique",
                    "formations academiques",
                    "education",
                    "academic background",
                    "academic",
                }:
                    continue
                if re.search(r"^(annee|year|periode|period)\b", line_norm):
                    continue
                if line_norm in {"institution", "diplome", "degree", "diploma"}:
                    continue
                if (
                    len(line_norm.split()) <= 6
                    and re.search(r"\binstitution\b", line_norm)
                    and re.search(r"\b(diplome|degree|diploma)\b", line_norm)
                ):
                    continue
            if "certification" in line_norm and not is_year_line:
                continue

            next_idx = next_significant_index(idx + 1)
            next_is_year = False
            if next_idx is not None:
                next_is_year = bool(year_pattern.match(section_lines[next_idx].rstrip()))

            if is_year_line:
                flush_current()

                end_date = self._clean_text(year_match.group(2) or year_match.group(1))
                remainder = year_match.group(3) or ""
                rem_institution, rem_degree = split_line_parts(remainder)

                current_edu = {
                    "end_date": end_date,
                    "institution": rem_institution,
                    "degree": rem_degree,
                }

                if pending_institution_parts:
                    pending_institution = self._clean_text(" ".join(pending_institution_parts))
                    current_edu["institution"] = merge_text(
                        current_edu.get("institution", ""), pending_institution, prepend=True
                    )
                    pending_institution_parts.clear()

                if pending_degree_parts:
                    pending_degree = self._clean_text(" ".join(pending_degree_parts))
                    current_edu["degree"] = merge_text(
                        current_edu.get("degree", ""), pending_degree, prepend=True
                    )
                    pending_degree_parts.clear()

                continue

            institution_part, degree_part = split_line_parts(raw)
            if not institution_part and not degree_part:
                continue

            if not current_edu.get("end_date"):
                if institution_part:
                    pending_institution_parts.append(institution_part)
                if degree_part:
                    pending_degree_parts.append(degree_part)
                continue

            current_complete = bool(current_edu.get("institution")) and bool(current_edu.get("degree"))
            seed_next = current_complete and next_is_year

            if seed_next:
                if institution_part and not degree_part and should_continue_institution(
                    current_edu.get("institution", ""), institution_part
                ):
                    seed_next = False
                elif degree_part and not institution_part and should_continue_degree(
                    current_edu.get("degree", ""), degree_part
                ):
                    seed_next = False
                elif institution_part and degree_part and should_continue_institution(
                    current_edu.get("institution", ""), institution_part
                ) and should_continue_degree(current_edu.get("degree", ""), degree_part):
                    seed_next = False

            if seed_next:
                if institution_part:
                    pending_institution_parts.append(institution_part)
                if degree_part:
                    pending_degree_parts.append(degree_part)
                continue

            if institution_part:
                current_edu["institution"] = merge_text(current_edu.get("institution", ""), institution_part)
            if degree_part:
                current_edu["degree"] = merge_text(current_edu.get("degree", ""), degree_part)

        flush_current()

        normalized_education: List[Dict[str, str]] = []
        for edu in education:
            end_date = self._clean_text(edu.get("end_date", ""))
            institution = self._clean_text(edu.get("institution", ""))
            degree = self._clean_text(edu.get("degree", ""))
            institution = self._collapse_repeated_phrase(institution)
            degree = self._collapse_repeated_phrase(degree)
            institution = self._clean_text(re.sub(r"(?i)\b(et|and|de|du|des|d')\s*$", "", institution))
            degree = self._clean_text(re.sub(r"(?i)\b(et|and|de|du|des|d')\s*$", "", degree))

            if institution and not degree:
                split_institution, split_degree = self._split_institution_and_degree(institution)
                if split_institution and split_degree:
                    institution, degree = split_institution, split_degree
            elif degree and not institution:
                split_institution, split_degree = self._split_institution_and_degree(degree)
                if split_institution and split_degree:
                    institution, degree = split_institution, split_degree

            if not end_date:
                continue
            if not institution and not degree:
                continue

            normalized_education.append(
                {
                    "end_date": end_date,
                    "institution": institution,
                    "degree": degree,
                }
            )

        return normalized_education

    def _extract_projects_from_layout(
        self,
        start_keywords: List[str],
        end_keywords: List[str],
    ) -> List[Dict[str, str]]:
        """
        Parse projects from positioned lines instead of plain text order.

        The extractor identifies project rows from the date column, then
        attaches surrounding client/description lines using vertical midpoints
        between consecutive date rows and horizontal column bands.
        """
        layout_lines = getattr(self, "_layout_lines", None) or []
        if not layout_lines:
            return []

        def extract_date_start(raw_value: str) -> Tuple[str, str]:
            year_pattern = re.compile(
                rf"^\s*((?:19|20)\d{{2}}(?:\s*{self.DASH_RE}\s*(?:19|20)\d{{2}})?)\b(.*)$",
                re.IGNORECASE,
            )
            month_pattern = re.compile(
                rf"^\s*((?:{self.MONTH_RE}\s+\d{{4}}(?:\s*{self.DASH_RE}\s*(?:{self.MONTH_RE}\s+\d{{4}}|\d{{4}}))?))\b(.*)$",
                re.IGNORECASE,
            )

            year_match = year_pattern.match(raw_value)
            if year_match:
                return self._clean_text(year_match.group(1)), year_match.group(2)

            month_match = month_pattern.match(raw_value)
            if month_match:
                return self._clean_text(month_match.group(1)), month_match.group(2)

            return "", raw_value

        def median(values: List[float]) -> float:
            if not values:
                return 0.0
            ordered = sorted(values)
            mid = len(ordered) // 2
            if len(ordered) % 2:
                return ordered[mid]
            return (ordered[mid - 1] + ordered[mid]) / 2.0

        def cluster_positions(values: List[float], tolerance: float = 24.0) -> List[Dict[str, float]]:
            if not values:
                return []
            ordered = sorted(values)
            clusters: List[List[float]] = [[ordered[0]]]
            for value in ordered[1:]:
                current = clusters[-1]
                center = sum(current) / len(current)
                if abs(value - center) <= tolerance:
                    current.append(value)
                else:
                    clusters.append([value])
            return [
                {
                    "x": sum(cluster) / len(cluster),
                    "count": float(len(cluster)),
                    "min": min(cluster),
                    "max": max(cluster),
                }
                for cluster in clusters
            ]

        def is_table_label(value: str) -> bool:
            norm = self._normalize_for_match(value)
            if not norm:
                return True
            if norm in {
                "projets",
                "projects",
                "annee",
                "year",
                "date",
                "periode",
                "period",
                "client",
                "projet",
                "project",
                "description",
            }:
                return True
            return False

        start_order: Optional[int] = None
        for line in layout_lines:
            text_value = self._clean_text(str(line.get("text", "")))
            if not text_value:
                continue
            if any(self._match_keyword(text_value, keyword) for keyword in start_keywords):
                start_order = int(line.get("order", -1))
                break

        if start_order is None:
            return []

        end_order: Optional[int] = None
        for line in layout_lines:
            order = int(line.get("order", -1))
            if order <= start_order:
                continue
            text_value = self._clean_text(str(line.get("text", "")))
            if not text_value or is_table_label(text_value):
                continue
            if any(self._match_keyword(text_value, keyword) for keyword in end_keywords):
                end_order = order
                break

        section_layout_lines = [
            line
            for line in layout_lines
            if int(line.get("order", -1)) > start_order
            and (end_order is None or int(line.get("order", -1)) < end_order)
        ]
        if not section_layout_lines:
            return []

        client_header_xs: List[float] = []
        description_header_xs: List[float] = []
        for line in section_layout_lines:
            text_value = self._clean_text(str(line.get("text", "")))
            norm = self._normalize_for_match(text_value)
            if not norm:
                continue
            x0 = float(line.get("x0", 0.0))
            if re.search(r"\b(client|company|societe|societe|organisme)\b", norm):
                client_header_xs.append(x0)
            if re.search(r"\b(project|projet|description|mission|role)\b", norm):
                description_header_xs.append(x0)

        marker_candidates: List[Dict[str, Any]] = []
        for line in section_layout_lines:
            text_value = self._clean_text(str(line.get("text", "")))
            if not text_value or is_table_label(text_value):
                continue

            date_value, remainder = extract_date_start(text_value)
            if not date_value and self._is_page_artifact(text_value):
                continue
            if not date_value:
                continue

            marker_candidates.append(
                {
                    "order": int(line.get("order", -1)),
                    "x0": float(line.get("x0", 0.0)),
                    "global_y": float(line.get("global_y", 0.0)),
                    "date": date_value,
                    "remainder": self._clean_text(remainder),
                }
            )

        if not marker_candidates:
            return []

        date_column_x = median([marker["x0"] for marker in marker_candidates])
        date_markers = [
            marker for marker in marker_candidates if marker["x0"] <= date_column_x + 36.0
        ]
        if not date_markers:
            date_markers = marker_candidates

        date_markers.sort(key=lambda item: (item["global_y"], item["x0"]))
        deduped_markers: List[Dict[str, Any]] = []
        for marker in date_markers:
            if deduped_markers:
                prev = deduped_markers[-1]
                if (
                    abs(marker["global_y"] - prev["global_y"]) <= 6.0
                    and marker["date"] == prev["date"]
                ):
                    continue
            deduped_markers.append(marker)
        date_markers = deduped_markers
        if not date_markers:
            return []

        marker_orders = {marker["order"] for marker in date_markers}
        non_marker_xs: List[float] = []
        for line in section_layout_lines:
            order = int(line.get("order", -1))
            if order in marker_orders:
                continue
            text_value = self._clean_text(str(line.get("text", "")))
            if not text_value or self._is_page_artifact(text_value) or is_table_label(text_value):
                continue
            date_value, _ = extract_date_start(text_value)
            if date_value and float(line.get("x0", 0.0)) <= date_column_x + 36.0:
                continue
            x0 = float(line.get("x0", 0.0))
            if x0 > date_column_x + 12.0:
                non_marker_xs.append(x0)

        clusters = cluster_positions(non_marker_xs)
        clusters.sort(key=lambda item: item["x"])

        client_column_x: Optional[float] = None
        description_column_x: Optional[float] = None
        if len(clusters) >= 2 and (clusters[-1]["x"] - clusters[0]["x"]) >= 42.0:
            client_column_x = clusters[0]["min"]
            right_side = [
                cluster
                for cluster in clusters
                if cluster["x"] >= (client_column_x + 42.0)
            ]
            if right_side:
                description_column_x = max(
                    right_side,
                    key=lambda cluster: (cluster["count"], cluster["x"]),
                )["min"]

        if client_column_x is None and client_header_xs:
            client_column_x = min(client_header_xs)

        if description_column_x is None:
            right_side_x = [
                cluster["min"]
                for cluster in clusters
                if client_column_x is None or cluster["x"] >= client_column_x + 42.0
            ]
            if right_side_x:
                description_column_x = max(right_side_x)

        if description_column_x is None and description_header_xs:
            header_x = min(description_header_xs)
            if client_column_x is None or header_x >= client_column_x + 24.0:
                description_column_x = header_x

        if client_column_x is None and description_column_x is not None:
            client_column_x = max(date_column_x + 36.0, description_column_x - 130.0)
        if description_column_x is None and client_column_x is not None:
            description_column_x = client_column_x + 95.0
        if client_column_x is None and description_column_x is None:
            return []

        def has_client_band_content(marker: Dict[str, Any]) -> bool:
            if client_column_x is None:
                return False
            client_upper_x = (
                description_column_x - 18.0
                if description_column_x is not None
                else client_column_x + 120.0
            )

            for line in section_layout_lines:
                if int(line.get("order", -1)) == marker["order"]:
                    continue
                text_value = self._clean_text(str(line.get("text", "")))
                if not text_value or self._is_page_artifact(text_value) or is_table_label(text_value):
                    continue
                if abs(float(line.get("global_y", 0.0)) - marker["global_y"]) > 9.0:
                    continue
                x0 = float(line.get("x0", 0.0))
                if x0 < (client_column_x - 18.0) or x0 >= client_upper_x:
                    continue
                marker_date, _ = extract_date_start(text_value)
                if marker_date:
                    continue
                return True
            return False

        merged_markers: List[Dict[str, Any]] = []
        for marker in date_markers:
            if not merged_markers:
                merged_markers.append(dict(marker))
                continue

            previous = merged_markers[-1]
            vertical_gap = marker["global_y"] - previous["global_y"]
            same_band = abs(marker["x0"] - previous["x0"]) <= 8.0
            if vertical_gap <= 16.0 and same_band and not has_client_band_content(marker):
                previous_norm = self._normalize_for_match(previous.get("date", ""))
                marker_norm = self._normalize_for_match(marker.get("date", ""))
                if marker_norm and marker_norm not in previous_norm:
                    previous["date"] = self._clean_text(f"{previous['date']} - {marker['date']}")
                continue

            merged_markers.append(dict(marker))
        date_markers = merged_markers

        def has_same_row_description(marker: Dict[str, Any]) -> bool:
            if description_column_x is None:
                return False
            for line in section_layout_lines:
                if int(line.get("order", -1)) in marker_orders:
                    continue
                text_value = self._clean_text(str(line.get("text", "")))
                if not text_value or self._is_page_artifact(text_value) or is_table_label(text_value):
                    continue
                marker_date, _ = extract_date_start(text_value)
                if marker_date:
                    continue
                y_distance = abs(float(line.get("global_y", 0.0)) - marker["global_y"])
                if y_distance > 4.0:
                    continue
                if float(line.get("x0", 0.0)) >= description_column_x - 18.0:
                    return True
            return False

        def has_month_token(date_value: str) -> bool:
            return bool(re.search(rf"(?i)\b{self.MONTH_RE}\b", date_value or ""))

        midpoints: List[float] = []
        for idx in range(len(date_markers) - 1):
            current_marker = date_markers[idx]
            next_marker = date_markers[idx + 1]
            midpoint = (current_marker["global_y"] + next_marker["global_y"]) / 2.0

            next_has_inline_description = has_same_row_description(next_marker)
            month_based_pair = has_month_token(current_marker.get("date", "")) or has_month_token(
                next_marker.get("date", "")
            )
            if month_based_pair and next_has_inline_description:
                shifted = max(midpoint, next_marker["global_y"] - 12.0)
                midpoint = min(shifted, next_marker["global_y"] - 2.0)

            midpoints.append(midpoint)

        description_signals = (
            "mise ",
            "livraison",
            "installation",
            "migration",
            "acquisition",
            "solution",
            "projet",
            "project",
            "renouvellement",
            "configuration",
            "cablage",
            "câblage",
        )

        rows: List[Dict[str, Any]] = []
        for marker in date_markers:
            row: Dict[str, Any] = {
                "date": marker["date"],
                "client_parts": [],
                "description_parts": [],
            }
            remainder = marker.get("remainder", "")
            if remainder:
                remainder_norm = self._normalize_for_match(remainder)
                if ":" in remainder or any(signal in remainder_norm for signal in description_signals):
                    row["description_parts"].append((marker["global_y"], remainder))
                else:
                    row["client_parts"].append((marker["global_y"], remainder))
            rows.append(row)

        ordered_section_lines = sorted(
            section_layout_lines, key=lambda item: (float(item.get("global_y", 0.0)), float(item.get("x0", 0.0)))
        )
        for line in ordered_section_lines:
            order = int(line.get("order", -1))
            if order in marker_orders:
                continue

            text_value = self._clean_text(str(line.get("text", "")))
            if not text_value or self._is_page_artifact(text_value) or is_table_label(text_value):
                continue

            date_value, _ = extract_date_start(text_value)
            x0 = float(line.get("x0", 0.0))
            if date_value and x0 <= date_column_x + 36.0:
                continue

            row_index = bisect_right(midpoints, float(line.get("global_y", 0.0)))
            if row_index < 0 or row_index >= len(rows):
                continue

            if description_column_x is not None and x0 >= description_column_x - 18.0:
                rows[row_index]["description_parts"].append((float(line.get("global_y", 0.0)), text_value))
                continue
            if client_column_x is not None and x0 >= client_column_x - 18.0:
                rows[row_index]["client_parts"].append((float(line.get("global_y", 0.0)), text_value))
                continue
            if x0 > date_column_x + 10.0:
                rows[row_index]["description_parts"].append((float(line.get("global_y", 0.0)), text_value))

        def merge_parts(parts: List[Tuple[float, str]]) -> str:
            if not parts:
                return ""
            merged_tokens: List[str] = []
            previous_norm = ""
            for _, raw_value in sorted(parts, key=lambda item: item[0]):
                cleaned = self._clean_text(raw_value)
                if not cleaned:
                    continue
                current_norm = self._normalize_for_match(cleaned)
                if current_norm and current_norm == previous_norm:
                    continue
                merged_tokens.append(cleaned)
                previous_norm = current_norm
            return self._clean_text(" ".join(merged_tokens))

        projects: List[Dict[str, str]] = []
        for row in rows:
            date_value = self._clean_text(str(row.get("date", "")))
            client_value = merge_parts(row.get("client_parts", []))
            description_value = merge_parts(row.get("description_parts", []))
            if not date_value and not client_value and not description_value:
                continue
            if not client_value and not description_value:
                continue
            projects.append(
                {
                    "date": date_value,
                    "client": client_value,
                    "description": description_value,
                }
            )

        if not projects:
            return []

        dated_rows = sum(1 for project in projects if project.get("date"))
        structured_rows = sum(
            1 for project in projects if project.get("client") and project.get("description")
        )
        if dated_rows >= 2 and structured_rows >= max(1, int(dated_rows * 0.4)):
            return projects

        return []

    def _extract_projects(self, text: str, lines: List[str]) -> List[Dict[str, str]]:
        """Extract project entries from table or bullet-list formats."""
        start_keywords = [
            "Projets",
            "Projects",
            "Key Projects",
            "Notable Projects",
            "Selected Projects",
            "Professional Achievements",
            "Accomplishments",
            "Portfolio",
            "Realisations",
            "Realisations professionnelles",
            "Realisations cles",
            "Projets et realisations",
            "Projets realises",
            "Projets cles",
        ]
        end_keywords = [
            "Competences",
            "Skills",
            "Core Competencies",
            "Formation",
            "Formations",
            "Education",
            "Langues",
            "Languages",
            "Certifications",
            "Certificats",
            "Attestations",
            "Experience",
            "Career",
        ]

        section_lines = self._find_section_lines(start_keywords, end_keywords, lines)
        layout_projects = self._extract_projects_from_layout(start_keywords, end_keywords)
        projects: List[Dict[str, str]] = list(layout_projects)
        if not section_lines and not projects:
            return []
        if projects:
            section_lines = []

        current_proj: Dict[str, str] = {}
        current_mode = ""
        client_col_hint: Optional[int] = None
        description_col_hint: Optional[int] = None

        action_keywords = [
            "mise en place",
            "mise a niveau",
            "realisation",
            "migration",
            "implementation",
            "installation",
            "livraison",
            "renouvellement",
            "acquisition",
            "configuration",
            "audit",
            "infogerance",
            "vulnerabilite",
            "vulnerabilit",
            "authentification",
            "monitoring",
            "load balancing",
            "cloud",
            "firewall",
            "nac",
            "scan",
            "open source",
            "antivirale",
        ]
        continuation_prefixes = (
            "et ",
            "de ",
            "du ",
            "des ",
            "la ",
            "le ",
            "l'",
            "d'",
            "pour ",
            "avec ",
            "dont ",
            "ainsi ",
            "solution ",
        )

        project_date_pattern = re.compile(
            rf"^\s*((?:19|20)\d{{2}}(?:\s*{self.DASH_RE}\s*(?:19|20)\d{{2}})?)\b(.*)$",
            re.IGNORECASE,
        )
        month_date_pattern = re.compile(
            rf"^\s*((?:{self.MONTH_RE}\s+\d{{4}}(?:\s*{self.DASH_RE}\s*(?:{self.MONTH_RE}\s+\d{{4}}|\d{{4}}))?))\b(.*)$",
            re.IGNORECASE,
        )

        def looks_like_description(value: str) -> bool:
            norm = self._normalize_for_match(value)
            if not norm:
                return False
            return any(keyword in norm for keyword in action_keywords)

        def looks_like_continuation_description(value: str) -> bool:
            cleaned = self._clean_text(value)
            if not cleaned:
                return False

            norm = self._normalize_for_match(cleaned)
            if not norm:
                return False

            if norm.startswith(continuation_prefixes):
                return True
            if cleaned[:1].islower():
                return True
            if cleaned.startswith(("(", "[", ",", ";", "/", "-", ":", "&")):
                return True
            return False

        def merge_text(base: str, extra: str, prepend: bool = False) -> str:
            base_clean = self._clean_text(base)
            extra_clean = self._clean_text(extra)
            if not base_clean:
                return extra_clean
            if not extra_clean:
                return base_clean
            if prepend:
                return self._clean_text(f"{extra_clean} {base_clean}")
            return self._clean_text(f"{base_clean} {extra_clean}")

        def split_table_segments(raw_value: str) -> List[Tuple[int, str]]:
            if not raw_value:
                return []
            value = raw_value.rstrip().replace("\t", "    ")
            segments: List[Tuple[int, str]] = []
            for match in re.finditer(r"\S(?:.*?\S)?(?=(?:\s{2,}|$))", value):
                token = self._clean_text(match.group(0))
                if token:
                    segments.append((match.start(), token))
            return segments

        def split_line_parts(raw_value: str) -> Tuple[str, str, List[str], List[int]]:
            segments = split_table_segments(raw_value)
            tokens = [token for _, token in segments]
            starts = [start for start, _ in segments]
            if not tokens:
                return "", "", [], []

            leading_spaces = len(raw_value) - len(raw_value.lstrip())
            if len(tokens) == 1:
                token = tokens[0]
                if (
                    looks_like_description(token)
                    or looks_like_continuation_description(token)
                    or leading_spaces >= 28
                ):
                    return "", token, [], starts
                return token, "", [], starts

            client = tokens[0]
            description = tokens[1]
            overflow = tokens[2:] if len(tokens) > 2 else []
            return client, description, overflow, starts

        connector_suffixes = (
            " de",
            " d",
            " d'",
            " du",
            " des",
            " la",
            " le",
            " l'",
            " et",
            " au",
            " aux",
            " pour",
        )

        def ends_with_connector(value: str) -> bool:
            norm = self._normalize_for_match(value)
            return any(norm.endswith(suffix) for suffix in connector_suffixes)

        def should_continue_client(current_client: str, candidate: str) -> bool:
            if ends_with_connector(current_client):
                return True
            return len(candidate.split()) <= 2

        def should_continue_description(current_description: str, candidate: str) -> bool:
            candidate_norm = self._normalize_for_match(candidate)
            if candidate_norm.startswith(("et ", "de ", "du ", "des ", "le ", "la ", "l'", "d'", "au ", "aux ")):
                return True
            if looks_like_continuation_description(candidate):
                return True
            if len(candidate.split()) <= 2:
                return True
            return ends_with_connector(current_description)

        def split_client_description(value: str) -> Tuple[str, str]:
            text_value = self._clean_text(value)
            if not text_value:
                return "", ""

            if ":" in text_value:
                left, right = text_value.split(":", 1)
                if self._clean_text(left):
                    return self._clean_text(left), self._clean_text(right)

            role_match = re.search(r"\s+en tant qu[' ]", self._normalize_for_match(text_value))
            if role_match:
                split_idx = role_match.start()
                return self._clean_text(text_value[:split_idx]), self._clean_text(text_value[split_idx:])

            lowered = self._normalize_for_match(text_value)
            split_idx: Optional[int] = None
            for keyword in action_keywords:
                idx = lowered.find(keyword)
                if idx > 0 and (split_idx is None or idx < split_idx):
                    split_idx = idx

            if split_idx is not None:
                return self._clean_text(text_value[:split_idx]), self._clean_text(text_value[split_idx:])

            return text_value, ""

        def extract_date_start(raw_value: str) -> Tuple[str, str]:
            year_match = project_date_pattern.match(raw_value)
            if year_match:
                return self._clean_text(year_match.group(1)), year_match.group(2)

            month_match = month_date_pattern.match(raw_value)
            if month_match:
                return self._clean_text(month_match.group(1)), month_match.group(2)

            return "", raw_value

        def flush_current() -> None:
            nonlocal current_proj, current_mode
            if not current_proj:
                return

            date = self._clean_text(current_proj.get("date", ""))
            client = self._clean_text(current_proj.get("client", ""))
            description = self._clean_text(current_proj.get("description", ""))
            if client or description:
                projects.append({"date": date, "client": client, "description": description})

            current_proj = {}
            current_mode = ""

        for idx, raw_line in enumerate(section_lines):
            raw = raw_line.rstrip()
            line = self._clean_text(raw)
            date_probe, _ = extract_date_start(raw)
            if not line or (self._is_page_artifact(line) and not date_probe):
                continue
            if self._is_header_line(line, "project") and not date_probe:
                continue

            if self.BULLET_RE.search(raw):
                flush_current()
                for segment in self._split_bullet_segments(raw):
                    client, description = split_client_description(segment)
                    if client or description:
                        projects.append({"date": "", "client": client, "description": description})
                current_mode = "bullet"
                continue

            if current_mode == "bullet":
                if projects:
                    projects[-1]["description"] = self._clean_text(
                        f"{projects[-1].get('description', '')} {line}"
                    )
                continue

            date_str, remainder = extract_date_start(raw)
            if date_str:
                flush_current()
                client_part, description_part, overflow_parts, col_starts = split_line_parts(remainder)

                current_proj = {
                    "date": date_str,
                    "client": client_part,
                    "description": description_part,
                }

                if col_starts:
                    if client_part:
                        hint = col_starts[0]
                        client_col_hint = hint if client_col_hint is None else min(client_col_hint, hint)
                    if description_part:
                        desc_idx = 1 if client_part and len(col_starts) >= 2 else 0
                        if desc_idx < len(col_starts):
                            hint = col_starts[desc_idx]
                            description_col_hint = hint if description_col_hint is None else min(description_col_hint, hint)

                if overflow_parts:
                    overflow_text = self._clean_text(" ".join(overflow_parts))
                    if overflow_text:
                        if looks_like_description(overflow_text):
                            current_proj["description"] = merge_text(
                                current_proj.get("description", ""), overflow_text
                            )
                        else:
                            current_proj["client"] = merge_text(
                                current_proj.get("client", ""), overflow_text
                            )

                current_mode = "table"
                continue

            client_part, description_part, overflow_parts, col_starts = split_line_parts(raw)
            if overflow_parts:
                overflow_text = self._clean_text(" ".join(overflow_parts))
                if overflow_text:
                    if looks_like_description(overflow_text):
                        description_part = merge_text(description_part, overflow_text)
                    else:
                        client_part = merge_text(client_part, overflow_text)

            single_segment_start = col_starts[0] if len(col_starts) == 1 else None
            if (
                current_proj
                and client_part
                and not description_part
                and (
                    (
                        single_segment_start is not None
                        and description_col_hint is not None
                        and single_segment_start >= max(0, description_col_hint - 3)
                    )
                    or looks_like_continuation_description(client_part)
                    or looks_like_description(client_part)
                )
            ):
                description_part = client_part
                client_part = ""

            if not client_part and not description_part:
                continue

            if not current_proj:
                current_proj = {
                    "date": "",
                    "client": client_part,
                    "description": description_part,
                }
                continue

            if client_part:
                client_looks_description = looks_like_description(client_part) or looks_like_continuation_description(client_part)
                if client_looks_description:
                    current_proj["description"] = merge_text(current_proj.get("description", ""), client_part)
                elif not current_proj.get("description") and should_continue_client(current_proj.get("client", ""), client_part):
                    current_proj["client"] = merge_text(current_proj.get("client", ""), client_part)
                elif (
                    single_segment_start is not None
                    and description_col_hint is not None
                    and single_segment_start >= max(0, description_col_hint - 3)
                ):
                    current_proj["description"] = merge_text(current_proj.get("description", ""), client_part)
                else:
                    current_proj["client"] = merge_text(current_proj.get("client", ""), client_part)
            if description_part:
                current_proj["description"] = merge_text(current_proj.get("description", ""), description_part)

        flush_current()

        org_hint_keywords = [
            "bank",
            "banque",
            "office",
            "societe",
            "company",
            "agence",
            "centre",
            "institut",
            "ministere",
            "ministry",
            "telecom",
            "tunisie",
            "universite",
            "clinique",
            "hospital",
            "groupe",
            "bourse",
        ]

        def is_garbled_text(value: str) -> bool:
            text_value = self._clean_text(value)
            if not text_value:
                return True

            compact = re.sub(r"\s+", "", text_value)
            if len(compact) < 2:
                return True

            alpha_count = sum(1 for ch in compact if ch.isalpha())
            if alpha_count == 0:
                return True

            alpha_ratio = alpha_count / max(len(compact), 1)
            noisy_chars = len(re.findall(r"[~`^_|\\<>]", compact))
            noisy_ratio = noisy_chars / max(len(compact), 1)
            noisy_runs = len(re.findall(r"\.{3,}|/{2,}|\\{2,}|_{2,}", text_value))

            if len(compact) > 12 and alpha_ratio < 0.35:
                return True
            if noisy_ratio > 0.08:
                return True
            if noisy_runs >= 2:
                return True
            return False

        def looks_like_org_name(value: str) -> bool:
            text_value = self._clean_text(value)
            if not text_value:
                return False
            if looks_like_description(text_value):
                return False
            if is_garbled_text(text_value):
                return False

            norm = self._normalize_for_match(text_value)
            if any(keyword in norm for keyword in org_hint_keywords):
                return True

            words = text_value.split()
            if len(words) > 10:
                return False
            if text_value.isupper() and len(text_value) >= 3:
                return True
            return len(words) >= 1

        cleaned_projects: List[Dict[str, str]] = []
        for proj in projects:
            date = self._clean_text(proj.get("date", ""))
            client = self._clean_text(proj.get("client", ""))
            description = self._clean_text(proj.get("description", ""))

            if client and not description:
                split_client, split_description = split_client_description(client)
                if split_description:
                    client = split_client
                    description = split_description

            if client and description and looks_like_description(client) and not looks_like_description(description):
                client, description = description, client

            if description and client:
                description_norm = self._normalize_for_match(description)
                client_norm = self._normalize_for_match(client)
                if description_norm.startswith(client_norm):
                    description = self._clean_text(description[len(client) :])

            if client.endswith((" L", " l")) and self._normalize_for_match(description).startswith("installation"):
                client = self._clean_text(client[:-2])
                description = self._clean_text(f"L'{description}")

            if client in {"L", "l", "L'", "l'", "L’", "l’"} and description:
                account_match = re.search(
                    r"(?i)\bpour\s+le\s+compte\s+de\s+([A-Za-z\u00C0-\u017F'()\- ]{3,})",
                    description,
                )
                extracted_client = self._clean_text(account_match.group(1)) if account_match else ""
                extracted_client = self._clean_text(re.sub(r"(?i)^(la|le|l['’])\s+", "", extracted_client))
                client = extracted_client if extracted_client else ""

            combined = self._clean_text(f"{client} {description}")
            if not date:
                if not description:
                    continue
                if len(combined) > 450:
                    continue
                if len(client) <= 2 and description:
                    continue
                if not description and not looks_like_org_name(client):
                    continue
                if is_garbled_text(combined):
                    continue

            if not client and not description:
                continue

            cleaned_projects.append(
                {
                    "date": date,
                    "client": client,
                    "description": description,
                }
            )

        return cleaned_projects

    def _extract_skills(self, text: str, lines: List[str]) -> List[str]:
        """Extract skills section."""
        start_keywords = [
            "Competences",
            "Competences techniques",
            "Competences professionnelles",
            "Competences cles",
            "Competences supplementaires",
            "Technical Skills",
            "Professional Skills",
            "Core Competencies",
            "Key Competencies",
            "Key Skills",
            "Skill Set",
            "Skills Summary",
            "Skills & Expertise",
            "Additional Skills",
            "Savoir faire",
            "Savoir-faire",
            "Outils",
            "Technologies utilisees",
            "Expertise",
            "Skills",
        ]
        end_keywords = [
            "Langues",
            "Languages",
            "References",
            "Experience",
            "Career",
            "Employment",
            "Certification",
            "Formation",
            "Education",
            "Projets",
            "Projects",
        ]

        section_lines = self._find_section_lines(start_keywords, end_keywords, lines)
        if not section_lines:
            return []

        skills: List[str] = []

        for raw_line in section_lines:
            line = self._clean_text(raw_line)
            if not line or self._is_page_artifact(line):
                continue
            if self._is_header_line(line, "skills"):
                continue

            line_norm = self._normalize_for_match(line)
            if line_norm in {
                "competence",
                "competences",
                "competences supplementaires",
                "skill",
                "skills",
                "additional skills",
            }:
                continue

            if ":" in line:
                category, right = [self._clean_text(part) for part in line.split(":", 1)]
                category_norm = self._normalize_for_match(category)
                if category and "competence" not in category_norm and category_norm not in {"skill", "skills"}:
                    skills.append(category)

                if right:
                    right_parts = [self._clean_text(part) for part in right.split(",") if self._clean_text(part)]
                    if len(right_parts) > 1 and all(len(part.split()) <= 4 for part in right_parts):
                        skills.extend(right_parts)
                    else:
                        skills.append(right)
                continue

            if "," in line and "(" not in line and ")" not in line:
                comma_parts = [self._clean_text(part) for part in line.split(",") if self._clean_text(part)]
                if len(comma_parts) > 1 and all(len(part.split()) <= 4 for part in comma_parts):
                    skills.extend(comma_parts)
                else:
                    skills.append(line)
            else:
                skills.append(line)

        unique_skills: List[str] = []
        seen = set()

        for skill in skills:
            skill = self._clean_text(skill)
            if not skill:
                continue

            skill_norm = self._normalize_for_match(skill)
            if skill_norm in {
                "competence",
                "competences",
                "skill",
                "skills",
                "technology",
                "technologie",
                "supplementaire",
                "additional",
                "competences supplementaires",
                "additional skills",
            }:
                continue

            if skill_norm not in seen:
                seen.add(skill_norm)
                unique_skills.append(skill)

        return unique_skills
