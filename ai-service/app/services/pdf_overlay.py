import logging
import os
import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

import fitz

logger = logging.getLogger(__name__)


def _normalize_text(value: str) -> str:
    if not value:
        return ""
    normalized = unicodedata.normalize("NFD", value)
    normalized = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    normalized = normalized.lower()
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def _extract_lines(page) -> List[Dict[str, Any]]:
    words = page.get_text("words") or []
    grouped: Dict[Tuple[int, int], Dict[str, Any]] = {}
    for x0, y0, x1, y1, text, block_no, line_no, _word_no in words:
        clean = (text or "").strip()
        if not clean:
            continue
        key = (block_no, line_no)
        entry = grouped.setdefault(
            key,
            {"words": [], "x0": float("inf"), "y0": float("inf"), "x1": 0.0, "y1": 0.0},
        )
        entry["words"].append((clean, x0, x1))
        entry["x0"] = min(entry["x0"], x0)
        entry["y0"] = min(entry["y0"], y0)
        entry["x1"] = max(entry["x1"], x1)
        entry["y1"] = max(entry["y1"], y1)

    lines: List[Dict[str, Any]] = []
    for entry in grouped.values():
        ordered = sorted(entry["words"], key=lambda w: w[1])
        text = " ".join(w[0] for w in ordered).strip()
        if not text:
            continue
        lines.append(
            {
                "text": text,
                "x0": entry["x0"],
                "y0": entry["y0"],
                "x1": entry["x1"],
                "y1": entry["y1"],
                "words": ordered,
            }
        )
    lines.sort(key=lambda l: (l["y0"], l["x0"]))
    return lines


def _line_anchor_x(line: Dict[str, Any]) -> float:
    for word, _x0, x1 in reversed(line.get("words", [])):
        if re.search(r"[A-Za-zÀ-ÿ]", word):
            return x1 + 6.0
    return float(line.get("x0", 0.0)) + 6.0


def _format_date_range(start: Optional[str], end: Optional[str], open_end_label: str) -> str:
    if start and end:
        if start == end: return start
        return f"{start} - {end}"
    if start and not end:
        return f"{start} - {open_end_label}"
    if end and not start:
        return str(end)
    return ""


def _latest_education(context: Dict[str, Any]) -> Tuple[str, str]:
    educations = context.get("educations") or []
    if not educations:
        return "", ""
    def sort_key(edu: Dict[str, Any]) -> str:
        return str(edu.get("endDate") or edu.get("startDate") or "")
    latest = sorted(educations, key=sort_key, reverse=True)[0]
    degree = latest.get("degree") or latest.get("fieldOfStudy") or ""
    year = str(latest.get("endDate") or latest.get("startDate") or "")
    if year and len(year) >= 4:
        # Extract year from string like "2014" or "June 2014"
        m = re.search(r"(\d{4})", year)
        if m: year = m.group(1)
    return degree, year


def build_auto_overlay_mapping(template_path: str, context: Dict[str, Any]) -> Dict[str, Any]:
    mapping: Dict[str, Any] = {"fields": [], "tables": []}
    
    last_degree, last_degree_year = _latest_education(context)
    open_end_label = context.get("open_end_label") or "Present"

    label_rules = [
        ("full_name", r"nom et prenom"),
        ("birth_date", r"date de naissance"),
        ("marital_status", r"situation familiale"),
        ("hire_date", r"date de recrutement"),
        ("current_position", r"fonction .*mission"),
        ("professional_summary", r"profil et connaissances"),
        ("last_degree", r"dernier diplome obtenu"),
    ]

    derived_values = {
        "last_degree": last_degree,
        "last_degree_year": last_degree_year,
    }

    with fitz.open(template_path) as doc:
        for p_idx in range(doc.page_count):
            page = doc[p_idx]
            lines = _extract_lines(page)

            for line in lines:
                norm = _normalize_text(line["text"])
                line_height = max(6.0, line["y1"] - line["y0"])
                
                # Check field labels
                for key, pattern in label_rules:
                    if re.search(pattern, norm):
                        value = derived_values.get(key) or context.get(key) or ""
                        if not value:
                            continue
                        mapping["fields"].append({
                            "type": "text", "key": key, "page": p_idx,
                            "x": _line_anchor_x(line), "y": line["y0"] + line_height * 0.8,
                            "font_size": 10,
                        })
                        break

                if "annee" in norm and last_degree_year:
                    mapping["fields"].append({
                        "type": "text", "key": "last_degree_year", "page": p_idx,
                        "x": _line_anchor_x(line), "y": line["y0"] + line_height * 0.8,
                        "font_size": 10,
                    })

            # Check for table headers on this page
            words = page.get_text("words") or []
            label_hits = []
            for x0, y0, x1, y1, text, _b, _l, _w in words:
                norm = _normalize_text(text)
                if norm.startswith("periode") or norm == "annee":
                    label_hits.append({"label": "period", "x0": x0, "y0": y0, "y1": y1})
                elif norm.startswith("projet"):
                    label_hits.append({"label": "project", "x0": x0, "y0": y0, "y1": y1})
                elif norm.startswith("client"):
                    label_hits.append({"label": "client", "x0": x0, "y0": y0, "y1": y1})
                elif norm.startswith("duree") or norm.startswith("delai") or norm == "duree":
                    label_hits.append({"label": "duration", "x0": x0, "y0": y0, "y1": y1})
                elif norm.startswith("formation") or norm.startswith("diplome"):
                    label_hits.append({"label": "education", "x0": x0, "y0": y0, "y1": y1})
                elif norm.startswith("certificat") or norm.startswith("certification"):
                    label_hits.append({"label": "certification", "x0": x0, "y0": y0, "y1": y1})

            if not label_hits:
                continue

            label_hits.sort(key=lambda h: h["y0"])
            header_rows = []
            row = []
            row_y = None
            for hit in label_hits:
                if row_y is None or abs(hit["y0"] - row_y) <= 12.0:
                    row.append(hit)
                    row_y = hit["y0"] if row_y is None else (row_y + hit["y0"]) / 2
                else:
                    header_rows.append(row)
                    row = [hit]
                    row_y = hit["y0"]
            if row: header_rows.append(row)

            for hits in header_rows:
                labels = {h["label"] for h in hits}
                table_source = None
                columns = []
                
                # Determine table type
                if "education" in labels:
                    table_source = "educations"
                    for h in hits:
                        if h["label"] == "period": columns.append({"x": h["x0"], "value": "{period}"})
                        elif h["label"] == "education": columns.append({"x": h["x0"], "value": "{degree}"})
                elif "certification" in labels:
                    table_source = "certifications"
                    for h in hits:
                        if h["label"] == "period": columns.append({"x": h["x0"], "value": "{period}"})
                        elif h["label"] == "certification": columns.append({"x": h["x0"], "value": "{name}"})
                elif len({"period", "project", "client", "institution", "degree"} & labels) >= 1:
                    # Precise differentiation for Annexe 9
                    page_text = (page.get_text() or "").lower()
                    if "duree" in page_text and "delai" in page_text:
                        # Both exist, check visual proximity or context
                        table_source = "work_experiences" if "duree" in (page.get_text() or "").lower() else "projects"
                    elif "duree" in page_text:
                        table_source = "work_experiences"
                    elif "delai" in page_text:
                        table_source = "projects"
                    elif "certification" in page_text:
                        table_source = "certifications"
                    elif "diplôme" in page_text or "formation" in page_text:
                        table_source = "educations"
                    else:
                        # Fallback based on labels
                        if "project" in labels or "client" in labels: table_source = "projects"
                        elif "degree" in labels or "institution" in labels: table_source = "educations"
                        else: table_source = "work_experiences"
                    
                    for h in hits:
                        if h["label"] == "period": columns.append({"x": h["x0"], "value": "{period}"})
                        elif h["label"] == "project": columns.append({"x": h["x0"], "value": "{project}"})
                        elif h["label"] == "client": columns.append({"x": h["x0"], "value": "{client}"})
                        elif h["label"] == "duration": columns.append({"x": h["x0"], "value": "{duration}"})

                if table_source and columns:
                    # Precise y-offset for Annexe 9 lines
                    start_y = max(h["y1"] for h in hits) + 12.0
                    mapping["tables"].append({
                        "type": "table", "source": table_source, "page": p_idx,
                        "start_y": start_y, "row_height": 22.0, "max_rows": 20,
                        "font_size": 9, "columns": columns, "open_end_label": open_end_label,
                    })

    return mapping


def _render_template_value(template: str, row: Dict[str, Any], defaults: Dict[str, Any]) -> str:
    def repl(match: re.Match) -> str:
        key = match.group(1)
        if key in row and row[key] is not None:
            return str(row[key])
        if key in defaults and defaults[key] is not None:
            return str(defaults[key])
        return ""
    return re.sub(r"\{([a-zA-Z0-9_\.]+)\}", repl, template)


def apply_pdf_overlay(template_path: str, output_path: str, context: Dict[str, Any], mapping: Dict[str, Any]) -> str:
    with fitz.open(template_path) as doc:
        # Apply fields
        for field in mapping.get("fields", []):
            key = field.get("key")
            value = str(context.get(key) or derived_val(key, context) or "N/A")
            page = doc[field["page"]]
            page.insert_text((field["x"], field["y"]), value, fontsize=field.get("font_size", 10))

        # Apply tables
        for table in mapping.get("tables", []):
            rows = context.get(table["source"]) or []
            if not isinstance(rows, list): continue
            page = doc[table["page"]]
            start_y = table["start_y"]
            row_height = table["row_height"]
            columns = table["columns"]
            
            for idx, item in enumerate(rows[:table["max_rows"]]):
                y = start_y + row_height * idx
                if y > page.rect.height - 30: break # Simple page break safety
                
                period = _format_date_range(item.get("startDate"), item.get("endDate"), table["open_end_label"])
                project = item.get("displayTitle") or item.get("name") or item.get("degree") or ""
                client = item.get("client") or item.get("companyName") or item.get("institution") or ""
                duration = item.get("duration") or ""
                
                defaults = {"period": period, "project": project, "client": client, "duration": duration, 
                            "name": project, "degree": project, "institution": client}
                
                for col in columns:
                    val = _render_template_value(col["value"], item, defaults)
                    page.insert_text((col["x"], y), val or "N/A", fontsize=table.get("font_size", 9))

        doc.save(output_path)
    return output_path

def derived_val(key: str, context: Dict[str, Any]) -> str:
    if key == "last_degree":
        d, _ = _latest_education(context)
        return d
    if key == "last_degree_year":
        _, y = _latest_education(context)
        return y
    return ""
