import json
from pathlib import Path
from typing import Any, Dict, List

import requests


ROOT = Path(__file__).resolve().parent
CV_DIR = ROOT.parent / "test-cvs"
GROUND_TRUTH_PATH = ROOT / "ground_truth.json"
RESULTS_PATH = ROOT / "results.json"

API_URL = "http://127.0.0.1:8000/api/v1/parsing/cv"
USER_ID = "00000000-0000-0000-0000-000000000001"


def _norm_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _full_name(sd: Dict[str, Any]) -> str:
    first = _norm_text(sd.get("first_name"))
    last = _norm_text(sd.get("last_name"))
    if first or last:
        return f"{first} {last}".strip()
    return _norm_text(sd.get("full_name"))


def _experience_to_strings(sd: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    for item in sd.get("experience", []) or []:
        if isinstance(item, dict):
            title = _norm_text(item.get("title"))
            company = _norm_text(item.get("company"))
            if title and company:
                out.append(f"{title} chez {company}")
            elif title:
                out.append(title)
            elif company:
                out.append(company)
        elif isinstance(item, str):
            txt = _norm_text(item)
            if txt:
                out.append(txt)
    return out


def _education_to_strings(sd: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    for item in sd.get("education", []) or []:
        if isinstance(item, dict):
            degree = _norm_text(item.get("degree"))
            institution = _norm_text(item.get("institution"))
            if degree and institution:
                out.append(f"{degree} - {institution}")
            elif degree:
                out.append(degree)
            elif institution:
                out.append(institution)
        elif isinstance(item, str):
            txt = _norm_text(item)
            if txt:
                out.append(txt)
    return out


def _skills_to_strings(sd: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    for item in sd.get("skills", []) or []:
        if isinstance(item, str):
            txt = _norm_text(item)
            if txt:
                out.append(txt)
        elif isinstance(item, dict):
            txt = _norm_text(item.get("name") or item.get("skill"))
            if txt:
                out.append(txt)
    return out


def _certifications_to_strings(sd: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    for item in sd.get("certifications", []) or []:
        if isinstance(item, dict):
            txt = _norm_text(item.get("name") or item.get("title") or item.get("certification"))
            if txt:
                out.append(txt)
        elif isinstance(item, str):
            txt = _norm_text(item)
            if txt:
                out.append(txt)
    return out


def normalize_parsed(response_json: Dict[str, Any]) -> Dict[str, Any]:
    sd = (response_json or {}).get("structured_data") or {}
    return {
        "full_name": _full_name(sd),
        "email": _norm_text(sd.get("email")),
        "phone": _norm_text(sd.get("phone")),
        "work_experience": _experience_to_strings(sd),
        "education": _education_to_strings(sd),
        "skills": _skills_to_strings(sd),
        "certifications": _certifications_to_strings(sd),
    }


def main() -> None:
    ground_truth = json.loads(GROUND_TRUTH_PATH.read_text(encoding="utf-8"))
    results = []

    for item in ground_truth:
        cv_name = item["cv_file"]
        cv_path = CV_DIR / cv_name
        if not cv_path.exists():
            raise FileNotFoundError(f"CV file not found: {cv_path}")

        with cv_path.open("rb") as f:
            resp = requests.post(
                API_URL,
                files={"file": (cv_name, f)},
                data={"user_id": USER_ID},
                timeout=240,
            )

        if resp.status_code != 200:
            raise RuntimeError(
                f"Parser call failed for {cv_name}: {resp.status_code} - {resp.text[:500]}"
            )

        parsed_norm = normalize_parsed(resp.json())
        results.append(
            {
                "cv_file": cv_name,
                "gt": item,
                "parsed": parsed_norm,
            }
        )
        print(f"{cv_name}: ok")

    RESULTS_PATH.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(results)} rows to {RESULTS_PATH}")


if __name__ == "__main__":
    main()
