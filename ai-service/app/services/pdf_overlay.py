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
        year = year[:4]
    return degree, year


def build_auto_overlay_mapping(template_path: str, context: Dict[str, Any]) -> Dict[str, Any]:
    mapping: Dict[str, Any] = {"fields": [], "tables": []}
    with fitz.open(template_path) as doc:
        if doc.page_count == 0:
            return mapping
        page = doc[0]
        lines = _extract_lines(page)

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

    for line in lines:
        norm = _normalize_text(line["text"])
        line_height = max(6.0, line["y1"] - line["y0"])
        for key, pattern in label_rules:
            if re.search(pattern, norm):
                value = derived_values.get(key) or context.get(key) or ""
                if not value:
                    continue
                mapping["fields"].append(
                    {
                        "type": "text",
                        "key": key,
                        "page": 0,
                        "x": _line_anchor_x(line),
                        "y": line["y0"] + line_height * 0.8,
                        "font_size": 10,
                    }
                )
                break

        if "annee" in norm and last_degree_year:
            mapping["fields"].append(
                {
                    "type": "text",
                    "key": "last_degree_year",
                    "page": 0,
                    "x": _line_anchor_x(line),
                    "y": line["y0"] + line_height * 0.8,
                    "font_size": 10,
                }
            )

    label_hits: List[Dict[str, Any]] = []
    with fitz.open(template_path) as doc:
        page = doc[0]
        words = page.get_text("words") or []
        for x0, y0, x1, y1, text, _b, _l, _w in words:
            norm = _normalize_text(text)
            if norm.startswith("periode"):
                label_hits.append({"label": "period", "x0": x0, "y0": y0, "y1": y1})
            elif norm.startswith("projet"):
                label_hits.append({"label": "project", "x0": x0, "y0": y0, "y1": y1})
            elif norm.startswith("client"):
                label_hits.append({"label": "client", "x0": x0, "y0": y0, "y1": y1})
            elif norm.startswith("duree") or norm.startswith("delai"):
                label_hits.append({"label": "duration", "x0": x0, "y0": y0, "y1": y1})

    label_hits.sort(key=lambda h: h["y0"])
    header_rows: List[List[Dict[str, Any]]] = []
    row: List[Dict[str, Any]] = []
    row_y = None
    for hit in label_hits:
        if row_y is None or abs(hit["y0"] - row_y) <= 12.0:
            row.append(hit)
            row_y = hit["y0"] if row_y is None else (row_y + hit["y0"]) / 2
        else:
            header_rows.append(row)
            row = [hit]
            row_y = hit["y0"]
    if row:
        header_rows.append(row)

    table_headers: List[Dict[str, Any]] = []
    for hits in header_rows:
        labels = {h["label"] for h in hits}
        if len({"period", "project", "client"} & labels) >= 2:
            table_headers.append({"hits": hits})

    for index, header in enumerate(table_headers[:2]):
        hits = header["hits"]
        period_x = next((h["x0"] for h in hits if h["label"] == "period"), None)
        project_x = next((h["x0"] for h in hits if h["label"] == "project"), None)
        client_x = next((h["x0"] for h in hits if h["label"] == "client"), None)
        duration_x = next((h["x0"] for h in hits if h["label"] == "duration"), None)
        line_height = max(6.0, max(h["y1"] - h["y0"] for h in hits))
        start_y = max(h["y1"] for h in hits) + line_height * 1.4

        columns: List[Dict[str, Any]] = []
        if period_x is not None:
            columns.append({"x": period_x, "value": "{period}"})
        if project_x is not None:
            columns.append({"x": project_x, "value": "{project}"})
        if client_x is not None:
            columns.append({"x": client_x, "value": "{client}"})
        if duration_x is not None:
            columns.append({"x": duration_x, "value": "{duration}"})

        if not columns:
            continue

        table_source = "work_experiences" if index == 0 else "projects"
        mapping["tables"].append(
            {
                "type": "table",
                "source": table_source,
                "page": 0,
                "start_y": start_y,
                "row_height": max(12.0, line_height * 1.8),
                "max_rows": 6,
                "font_size": 9,
                "columns": columns,
                "open_end_label": open_end_label,
            }
        )

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


def apply_pdf_overlay(
    template_path: str,
    output_path: str,
    context: Dict[str, Any],
    mapping: Dict[str, Any],
) -> str:
    with fitz.open(template_path) as doc:
        for field in mapping.get("fields", []):
            key = field.get("key")
            value = str(context.get(key)) if key and context.get(key) is not None else "N/A"

            page_index = int(field.get("page", 0))
            if page_index < 0 or page_index >= doc.page_count:
                continue
            page = doc[page_index]
            x = float(field.get("x", 0.0))
            y = float(field.get("y", 0.0))
            font_size = float(field.get("font_size", 10))
            page.insert_text((x, y), str(value), fontsize=font_size)

        for table in mapping.get("tables", []):
            source_key = table.get("source")
            rows = context.get(source_key) or []
            if not isinstance(rows, list):
                continue
            page_index = int(table.get("page", 0))
            if page_index < 0 or page_index >= doc.page_count:
                continue
            page = doc[page_index]
            start_y = float(table.get("start_y", 0.0))
            row_height = float(table.get("row_height", 12.0))
            max_rows = int(table.get("max_rows", len(rows)))
            font_size = float(table.get("font_size", 9))
            open_end_label = str(table.get("open_end_label") or context.get("open_end_label") or "Present")

            columns = table.get("columns") or []
            for idx, item in enumerate(rows[:max_rows]):
                y = start_y + row_height * idx
                period = _format_date_range(item.get("startDate"), item.get("endDate"), open_end_label)
                project = (
                    item.get("displayTitle")
                    or item.get("name")
                    or item.get("jobTitle")
                    or item.get("role")
                    or ""
                )
                client = item.get("client") or item.get("companyName") or ""
                duration = item.get("duration") or ""
                defaults = {
                    "period": period,
                    "project": project,
                    "client": client,
                    "duration": duration,
                }
                for col in columns:
                    x = float(col.get("x", 0.0))
                    template = col.get("value")
                    if template:
                        value = _render_template_value(str(template), item, defaults)
                    else:
                        key = col.get("key")
                        value = item.get(key) if key else ""
                    if not value:
                        value = "N/A"

                    page.insert_text((x, y), str(value), fontsize=font_size)

        doc.save(output_path)
    logger.info(f"Overlay PDF generated at: {output_path}")
    return output_path
