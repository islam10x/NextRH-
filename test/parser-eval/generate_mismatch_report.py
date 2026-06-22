import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List


ROOT = Path(__file__).resolve().parent
RESULTS_PATH = ROOT / "results.json"
REPORT_JSON_PATH = ROOT / "mismatch_report.json"
REPORT_MD_PATH = ROOT / "mismatch_report.md"


def _norm(s: str) -> str:
    return (s or "").strip().lower()


def _norm_phone(s: str) -> str:
    return " ".join((s or "").strip().split())


def _set_norm(items: List[str]) -> set:
    return {_norm(x) for x in items if (x or "").strip()}


def _tokens(s: str) -> List[str]:
    return [t for t in _norm(s).split() if t]


def _same_tokens(a: str, b: str) -> bool:
    return Counter(_tokens(a)) == Counter(_tokens(b))


def _list_preview(items: List[str], max_items: int = 6) -> List[str]:
    if len(items) <= max_items:
        return items
    return items[:max_items] + [f"... (+{len(items) - max_items} more)"]


def build_report(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    per_cv = []
    summary_counts = {
        "full_name": 0,
        "email": 0,
        "phone": 0,
        "work_experience": 0,
        "education": 0,
        "skills": 0,
        "certifications": 0,
    }

    for row in results:
        cv = row["cv_file"]
        gt = row["gt"]
        parsed = row["parsed"]
        mismatches = []

        gt_name = gt.get("full_name", "")
        p_name = parsed.get("full_name", "")
        if _norm(gt_name) != _norm(p_name):
            reason = "different"
            if _same_tokens(gt_name, p_name):
                reason = "same tokens, reversed/reshuffled order"
            mismatches.append(
                {
                    "field": "full_name",
                    "reason": reason,
                    "gt": gt_name,
                    "parsed": p_name,
                }
            )
            summary_counts["full_name"] += 1

        gt_email = gt.get("email", "")
        p_email = parsed.get("email", "")
        if _norm(gt_email) != _norm(p_email):
            mismatches.append(
                {
                    "field": "email",
                    "reason": "exact mismatch",
                    "gt": gt_email,
                    "parsed": p_email,
                }
            )
            summary_counts["email"] += 1

        gt_phone = gt.get("phone", "")
        p_phone = parsed.get("phone", "")
        if _norm_phone(gt_phone) != _norm_phone(p_phone):
            mismatches.append(
                {
                    "field": "phone",
                    "reason": "exact mismatch",
                    "gt": gt_phone,
                    "parsed": p_phone,
                }
            )
            summary_counts["phone"] += 1

        gt_exp = _set_norm(gt.get("work_experience", []))
        p_exp = _set_norm(parsed.get("work_experience", []))
        exp_overlap = sorted(gt_exp & p_exp)
        if not exp_overlap and gt_exp:
            mismatches.append(
                {
                    "field": "work_experience",
                    "reason": "no overlapping entry",
                    "gt": _list_preview(gt.get("work_experience", [])),
                    "parsed": _list_preview(parsed.get("work_experience", [])),
                }
            )
            summary_counts["work_experience"] += 1

        gt_edu = _set_norm(gt.get("education", []))
        p_edu = _set_norm(parsed.get("education", []))
        edu_overlap = sorted(gt_edu & p_edu)
        if not edu_overlap and gt_edu:
            mismatches.append(
                {
                    "field": "education",
                    "reason": "no overlapping entry",
                    "gt": _list_preview(gt.get("education", [])),
                    "parsed": _list_preview(parsed.get("education", [])),
                }
            )
            summary_counts["education"] += 1

        gt_sk = _set_norm(gt.get("skills", []))
        p_sk = _set_norm(parsed.get("skills", []))
        sk_overlap = sorted(gt_sk & p_sk)
        if gt_sk:
            recall = len(sk_overlap) / len(gt_sk)
            if recall < 1.0:
                missing = sorted(gt_sk - p_sk)
                extra = sorted(p_sk - gt_sk)
                mismatches.append(
                    {
                        "field": "skills",
                        "reason": f"recall {recall:.2f}",
                        "gt_count": len(gt_sk),
                        "parsed_count": len(p_sk),
                        "overlap": _list_preview(sk_overlap),
                        "missing_from_parsed": _list_preview(missing),
                        "extra_in_parsed": _list_preview(extra),
                    }
                )
                summary_counts["skills"] += 1

        gt_cert = _set_norm(gt.get("certifications", []))
        p_cert = _set_norm(parsed.get("certifications", []))
        cert_overlap = sorted(gt_cert & p_cert)
        if not cert_overlap and gt_cert:
            mismatches.append(
                {
                    "field": "certifications",
                    "reason": "no overlapping entry",
                    "gt": _list_preview(gt.get("certifications", [])),
                    "parsed": _list_preview(parsed.get("certifications", [])),
                }
            )
            summary_counts["certifications"] += 1

        if mismatches:
            per_cv.append(
                {
                    "cv_file": cv,
                    "mismatch_count": len(mismatches),
                    "mismatches": mismatches,
                }
            )

    return {
        "total_cvs": len(results),
        "cvs_with_any_mismatch": len(per_cv),
        "summary_mismatch_counts": summary_counts,
        "details": per_cv,
    }


def write_markdown(report: Dict[str, Any]) -> None:
    lines: List[str] = []
    lines.append("# Parser Mismatch Report")
    lines.append("")
    lines.append(f"- Total CVs: **{report['total_cvs']}**")
    lines.append(f"- CVs with at least one mismatch: **{report['cvs_with_any_mismatch']}**")
    lines.append("")
    lines.append("## Mismatch Counts by Field")
    lines.append("")
    for k, v in report["summary_mismatch_counts"].items():
        lines.append(f"- `{k}`: **{v}**")
    lines.append("")
    lines.append("## Per-CV Details")
    lines.append("")

    for item in report["details"]:
        lines.append(f"### {item['cv_file']}")
        lines.append("")
        for mm in item["mismatches"]:
            lines.append(f"- Field: `{mm['field']}`")
            lines.append(f"- Reason: {mm['reason']}")
            if "gt" in mm:
                lines.append(f"- GT: `{mm['gt']}`")
            if "parsed" in mm:
                lines.append(f"- Parsed: `{mm['parsed']}`")
            if "gt_count" in mm:
                lines.append(f"- GT Count: `{mm['gt_count']}`")
            if "parsed_count" in mm:
                lines.append(f"- Parsed Count: `{mm['parsed_count']}`")
            if "overlap" in mm:
                lines.append(f"- Overlap: `{mm['overlap']}`")
            if "missing_from_parsed" in mm:
                lines.append(f"- Missing From Parsed: `{mm['missing_from_parsed']}`")
            if "extra_in_parsed" in mm:
                lines.append(f"- Extra In Parsed: `{mm['extra_in_parsed']}`")
            lines.append("")

    REPORT_MD_PATH.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    results = json.loads(RESULTS_PATH.read_text(encoding="utf-8"))
    report = build_report(results)
    REPORT_JSON_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(report)

    print(f"Wrote {REPORT_JSON_PATH}")
    print(f"Wrote {REPORT_MD_PATH}")
    print("Summary mismatch counts:")
    for k, v in report["summary_mismatch_counts"].items():
        print(f"- {k}: {v}")


if __name__ == "__main__":
    main()
