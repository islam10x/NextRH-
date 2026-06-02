import argparse
import difflib
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[1]
AI_SERVICE_ROOT = REPO_ROOT / "ai-service"
CERT_DIR = ROOT.parent / "test-certs"
GROUND_TRUTH_PATH = ROOT / "cert_ground_truth.json"
RESULTS_PATH = ROOT / "cert_results.json"
METRICS_PATH = ROOT / "cert_metrics_summary.json"
MISMATCH_JSON_PATH = ROOT / "cert_mismatch_report.json"
MISMATCH_MD_PATH = ROOT / "cert_mismatch_report.md"


def _norm(value: Any) -> str:
    text = "" if value is None else str(value)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _candidates(item: dict[str, Any], field: str) -> list[str]:
    values = [str(item.get(field) or "")]
    values.extend(str(alias) for alias in item.get(f"{field}_aliases", []) or [])
    return [value for value in values if value.strip()]


def _matches_name(actual: str, expected_item: dict[str, Any]) -> bool:
    actual_norm = _norm(actual)
    if not actual_norm:
        return False

    for candidate in _candidates(expected_item, "certification_name"):
        candidate_norm = _norm(candidate)
        if not candidate_norm:
            continue
        if actual_norm == candidate_norm:
            return True
        ratio = difflib.SequenceMatcher(None, actual_norm, candidate_norm).ratio()
        if ratio >= 0.86:
            return True

    return False


def _matches_issuer(actual: str, expected_item: dict[str, Any]) -> bool:
    actual_norm = _norm(actual)
    if not actual_norm:
        return False

    for candidate in _candidates(expected_item, "issuer"):
        candidate_norm = _norm(candidate)
        if not candidate_norm:
            continue
        if actual_norm == candidate_norm:
            return True
        if len(candidate_norm) >= 4 and (candidate_norm in actual_norm or actual_norm in candidate_norm):
            return True
        ratio = difflib.SequenceMatcher(None, actual_norm, candidate_norm).ratio()
        if ratio >= 0.88:
            return True

    return False


def _configure_environment(allow_llm: bool) -> None:
    os.environ.setdefault("OCR_ENGINE", "both")
    os.environ.setdefault("EASYOCR_MODULE_PATH", str(REPO_ROOT / "tmp" / "easyocr"))
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    if not allow_llm:
        os.environ["GROQ_API_KEY"] = ""

    sys.path.insert(0, str(AI_SERVICE_ROOT))


def _load_parser(allow_llm: bool):
    _configure_environment(allow_llm)
    from app.ocr.certification_ocr import CertificationOCR

    parser = CertificationOCR()
    if not allow_llm:
        parser._llm_fallback_extraction = lambda text: {}
    return parser


def main() -> None:
    arg_parser = argparse.ArgumentParser(
        description="Evaluate certification OCR parsing against curated one-page certificate ground truth."
    )
    arg_parser.add_argument(
        "--allow-llm",
        action="store_true",
        help="Allow the parser's Groq fallback. By default the evaluator measures OCR/rules only.",
    )
    arg_parser.add_argument(
        "--api-url",
        default="",
        help="Optional certification parsing endpoint URL. When set, the evaluator calls the real HTTP pipeline.",
    )
    arg_parser.add_argument(
        "--user-id",
        default="00000000-0000-0000-0000-000000000001",
        help="User ID sent to the endpoint in --api-url mode.",
    )
    arg_parser.add_argument(
        "--merge-existing",
        action="store_true",
        help="Keep existing cert_results.json rows and replace only files evaluated in this run.",
    )
    arg_parser.add_argument(
        "--only-missing",
        action="store_true",
        help="Evaluate only ground-truth files that are missing from cert_results.json.",
    )
    arg_parser.add_argument(
        "--files",
        nargs="*",
        default=[],
        help="Specific ground-truth filenames to evaluate.",
    )
    args = arg_parser.parse_args()

    ground_truth = json.loads(GROUND_TRUTH_PATH.read_text(encoding="utf-8"))
    parser = None if args.api_url else _load_parser(allow_llm=args.allow_llm)
    existing_results: list[dict[str, Any]] = []
    if args.merge_existing and RESULTS_PATH.exists():
        existing_results = json.loads(RESULTS_PATH.read_text(encoding="utf-8"))

    results_by_file = {
        row["file"]: row
        for row in existing_results
        if isinstance(row, dict) and row.get("file")
    }
    files_with_results = set(results_by_file)
    items_to_run = ground_truth
    if args.files:
        requested_files = set(args.files)
        known_files = {item["file"] for item in ground_truth}
        unknown_files = sorted(requested_files - known_files)
        if unknown_files:
            raise RuntimeError(
                "Requested files are not in cert_ground_truth.json: "
                + ", ".join(unknown_files)
            )
        items_to_run = [item for item in ground_truth if item["file"] in requested_files]
    if args.only_missing:
        items_to_run = [item for item in ground_truth if item["file"] not in files_with_results]

    if args.only_missing and not items_to_run:
        print("No missing ground-truth files to evaluate.")

    for item in items_to_run:
        filename = item["file"]
        cert_path = CERT_DIR / filename
        if not cert_path.exists():
            raise FileNotFoundError(f"Missing certificate file: {cert_path}")

        started = time.perf_counter()
        if args.api_url:
            parsed = _parse_via_endpoint(args.api_url, cert_path, filename, args.user_id)
        else:
            parsed = parser.parse_certification(str(cert_path), filename)
        elapsed = time.perf_counter() - started

        parsed_name = parsed.get("certification_name") or ""
        parsed_issuer = parsed.get("issuer") or ""
        name_ok = _matches_name(parsed_name, item)
        issuer_ok = _matches_issuer(parsed_issuer, item)

        row = {
            "file": filename,
            "expected": {
                "certification_name": item["certification_name"],
                "issuer": item["issuer"],
                "issuer_aliases": item.get("issuer_aliases", []),
                "certification_name_aliases": item.get("certification_name_aliases", []),
            },
            "parsed": {
                "success": parsed.get("success"),
                "certification_name": parsed_name,
                "issuer": parsed_issuer,
                "issue_date": parsed.get("issue_date"),
                "expiration_date": parsed.get("expiration_date"),
                "credential_id": parsed.get("credential_id"),
                "raw_text": parsed.get("raw_text"),
            },
            "correct": {
                "certification_name": name_ok,
                "issuer": issuer_ok,
            },
            "latency_seconds": round(elapsed, 3),
        }
        results_by_file[filename] = row

        print(
            f"{filename}: name={'ok' if name_ok else 'MISS'}, "
            f"issuer={'ok' if issuer_ok else 'MISS'}, {elapsed:.1f}s"
        )

    missing_after_run = [item["file"] for item in ground_truth if item["file"] not in results_by_file]
    if missing_after_run:
        raise RuntimeError(
            "No result row exists for these ground-truth files: "
            + ", ".join(missing_after_run)
        )

    results = [results_by_file[item["file"]] for item in ground_truth]
    mismatches = [
        row
        for row in results
        if not row["correct"]["certification_name"] or not row["correct"]["issuer"]
    ]

    sample_size = len(results)
    correct_names = sum(1 for row in results if row["correct"]["certification_name"])
    correct_issuers = sum(1 for row in results if row["correct"]["issuer"])
    both_fields = sum(
        1
        for row in results
        if row["correct"]["certification_name"] and row["correct"]["issuer"]
    )
    total_seconds = sum(float(row.get("latency_seconds") or 0.0) for row in results)
    metrics = {
        "sample_size": sample_size,
        "ocr_engine": os.environ.get("OCR_ENGINE", ""),
        "execution_mode": "endpoint" if args.api_url else "direct",
        "api_url": args.api_url,
        "llm_fallback_enabled": "server_default" if args.api_url else bool(args.allow_llm),
        "files_evaluated_this_run": len(items_to_run),
        "merged_existing_results": bool(args.merge_existing),
        "metrics_percent": {
            "certification_name": correct_names / sample_size * 100.0,
            "issuer": correct_issuers / sample_size * 100.0,
            "both_fields": both_fields / sample_size * 100.0,
        },
        "counters": {
            "certification_name": correct_names,
            "issuer": correct_issuers,
            "both_fields": both_fields,
        },
        "latency_seconds": {
            "total": round(total_seconds, 3),
            "average": round(total_seconds / sample_size, 3),
        },
        "notes": [
            "Ground truth covers one-page certificate PDFs listed in cert_ground_truth.json.",
            "The two 24-page CV/diploma/certificate bundle PDFs are excluded because the certification parser expects a single certificate document.",
        ],
    }

    RESULTS_PATH.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    METRICS_PATH.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    MISMATCH_JSON_PATH.write_text(json.dumps(mismatches, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_mismatch_markdown(metrics, mismatches)

    print("\nField Category                          Correctly Populated (%)")
    print("Cert. Name (scanned image, EasyOCR)     "
          f"{metrics['metrics_percent']['certification_name']:.1f}")
    print("Issuing Organisation (scanned, EasyOCR) "
          f"{metrics['metrics_percent']['issuer']:.1f}")
    print(f"\nSaved results to {RESULTS_PATH}")
    print(f"Saved metrics to {METRICS_PATH}")
    print(f"Saved mismatch report to {MISMATCH_MD_PATH}")


def _write_mismatch_markdown(metrics: dict[str, Any], mismatches: list[dict[str, Any]]) -> None:
    lines = [
        "# Certification Parser Mismatch Report",
        "",
        f"- Sample size: {metrics['sample_size']}",
        f"- OCR engine: {metrics['ocr_engine']}",
        f"- Execution mode: {metrics['execution_mode']}",
        f"- API URL: {metrics['api_url'] or 'n/a'}",
        f"- LLM fallback enabled: {metrics['llm_fallback_enabled']}",
        f"- Files evaluated this run: {metrics['files_evaluated_this_run']}",
        f"- Merged existing results: {metrics['merged_existing_results']}",
        f"- Certification name accuracy: {metrics['metrics_percent']['certification_name']:.1f}%",
        f"- Issuer accuracy: {metrics['metrics_percent']['issuer']:.1f}%",
        f"- Both fields accuracy: {metrics['metrics_percent']['both_fields']:.1f}%",
        "",
    ]

    if not mismatches:
        lines.append("No mismatches.")
    else:
        for row in mismatches:
            expected = row["expected"]
            parsed = row["parsed"]
            correct = row["correct"]
            lines.extend(
                [
                    f"## {row['file']}",
                    "",
                    f"- Expected name: {expected['certification_name']}",
                    f"- Parsed name: {parsed['certification_name']}",
                    f"- Name correct: {correct['certification_name']}",
                    f"- Expected issuer: {expected['issuer']}",
                    f"- Parsed issuer: {parsed['issuer']}",
                    f"- Issuer correct: {correct['issuer']}",
                    "",
                ]
            )

    MISMATCH_MD_PATH.write_text("\n".join(lines), encoding="utf-8")


def _parse_via_endpoint(api_url: str, cert_path: Path, filename: str, user_id: str) -> dict[str, Any]:
    with cert_path.open("rb") as handle:
        response = requests.post(
            api_url,
            files={"file": (filename, handle, "application/pdf")},
            data={"user_id": user_id},
            timeout=300,
        )

    if response.status_code != 200:
        raise RuntimeError(
            f"Endpoint call failed for {filename}: {response.status_code} - {response.text[:500]}"
        )

    data = response.json()
    if not isinstance(data, dict):
        raise RuntimeError(f"Endpoint returned non-object JSON for {filename}: {data!r}")
    return data


if __name__ == "__main__":
    main()
