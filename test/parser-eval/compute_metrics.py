import json
from pathlib import Path
from typing import Dict, List


ROOT = Path(__file__).resolve().parent
RESULTS_PATH = ROOT / "results.json"
METRICS_PATH = ROOT / "metrics_summary.json"


def _norm(s: str) -> str:
    return (s or "").strip().lower()


def _norm_phone(s: str) -> str:
    return " ".join((s or "").strip().split())


def _set_norm(items: List[str]) -> set:
    return { _norm(x) for x in items if (x or "").strip() }


def main() -> None:
    results = json.loads(RESULTS_PATH.read_text(encoding="utf-8"))
    n = len(results)
    if n == 0:
        raise RuntimeError("results.json is empty")

    counters: Dict[str, float] = {
        "full_name": 0.0,
        "email": 0.0,
        "phone": 0.0,
        "work_experience": 0.0,
        "education": 0.0,
        "skills": 0.0,
        "certifications": 0.0,
    }

    for r in results:
        gt = r["gt"]
        p = r["parsed"]

        if _norm(p.get("full_name", "")) == _norm(gt.get("full_name", "")):
            counters["full_name"] += 1

        if _norm(p.get("email", "")) == _norm(gt.get("email", "")):
            counters["email"] += 1

        if _norm_phone(p.get("phone", "")) == _norm_phone(gt.get("phone", "")):
            counters["phone"] += 1

        gt_exp = _set_norm(gt.get("work_experience", []))
        p_exp = _set_norm(p.get("work_experience", []))
        if gt_exp and (gt_exp & p_exp):
            counters["work_experience"] += 1

        gt_edu = _set_norm(gt.get("education", []))
        p_edu = _set_norm(p.get("education", []))
        if gt_edu and (gt_edu & p_edu):
            counters["education"] += 1

        gt_sk = _set_norm(gt.get("skills", []))
        p_sk = _set_norm(p.get("skills", []))
        recall = (len(gt_sk & p_sk) / len(gt_sk)) if gt_sk else 0.0
        counters["skills"] += recall

        gt_cert = _set_norm(gt.get("certifications", []))
        p_cert = _set_norm(p.get("certifications", []))
        if gt_cert and (gt_cert & p_cert):
            counters["certifications"] += 1

    metrics = {k: (v / n * 100.0) for k, v in counters.items()}

    print(f"{'Field':<20} {'Accuracy':>10}")
    print("-" * 32)
    for field in [
        "full_name",
        "email",
        "phone",
        "work_experience",
        "education",
        "skills",
        "certifications",
    ]:
        print(f"{field:<20} {metrics[field]:>8.1f}%")

    METRICS_PATH.write_text(
        json.dumps(
            {
                "sample_size": n,
                "metrics_percent": metrics,
                "counters": counters,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nSaved metrics to {METRICS_PATH}")


if __name__ == "__main__":
    main()
