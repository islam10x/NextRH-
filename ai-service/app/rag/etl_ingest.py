import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

from langchain_core.documents import Document
from langchain_ollama import OllamaEmbeddings
from langchain_qdrant import QdrantVectorStore
from qdrant_client import QdrantClient
from qdrant_client.http import models
from sqlalchemy import text

from app.config import settings
from app.rag.db import SessionLocal

REPO_ROOT = Path(__file__).resolve().parents[3]
QDRANT_PATH = REPO_ROOT / "qdrant_local"


@dataclass
class EmployeeRow:
    user_id: UUID
    first_name: str
    last_name: str
    email: str | None
    current_position: str | None
    total_experience_years: int | None
    professional_summary: str | None
    folder_path: str | None


def normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def resolve_metadata_roots() -> list[Path]:
    roots: list[Path] = []
    for raw_root in settings.RAG_METADATA_ROOTS.split(","):
        candidate = Path(raw_root.strip())
        if not candidate:
            continue
        if not candidate.is_absolute():
            candidate = (REPO_ROOT / candidate).resolve()
        if candidate.exists():
            roots.append(candidate)
    return roots


def discover_metadata_index(roots: list[Path]) -> dict[str, Path]:
    index: dict[str, Path] = {}
    for root in roots:
        for metadata_path in root.rglob("metadata.json"):
            folder_key = normalize_name(metadata_path.parent.name)
            index[folder_key] = metadata_path
            try:
                payload = json.loads(metadata_path.read_text(encoding="utf-8"))
                name = str(payload.get("name") or "").strip()
                if name:
                    index[normalize_name(name)] = metadata_path
            except Exception:
                continue
    return index


def find_metadata_file(employee: EmployeeRow, roots: list[Path], index: dict[str, Path]) -> Path | None:
    candidates: list[Path] = []
    if employee.folder_path:
        folder_path = Path(employee.folder_path)
        if folder_path.is_absolute():
            candidates.append(folder_path / "metadata.json")
        candidates.append((REPO_ROOT / "backend" / folder_path / "metadata.json").resolve())
        for root in roots:
            candidates.append((root / folder_path.name / "metadata.json").resolve())

    first = employee.first_name.strip()
    last = employee.last_name.strip()
    name_variants = [
        f"{first} {last}",
        f"{first}_{last}",
        f"{first}-{last}",
        f"{first.capitalize()}_{last.capitalize()}",
    ]
    for root in roots:
        for variant in name_variants:
            candidates.append((root / variant / "metadata.json").resolve())

    for candidate in candidates:
        if candidate.exists():
            return candidate

    return index.get(normalize_name(f"{first} {last}"))


def as_string_list(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    return [str(item).strip() for item in values if str(item).strip()]


def extract_certifications(payload: dict[str, Any]) -> list[str]:
    certs = as_string_list(payload.get("certifications"))
    for cert in payload.get("structured_data", {}).get("certifications", []):
        if isinstance(cert, dict):
            value = str(cert.get("name") or "").strip()
            if value:
                certs.append(value)
    # Keep order while deduplicating.
    return list(dict.fromkeys(certs))


def build_golden_record(employee: EmployeeRow, payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    structured = payload.get("structured_data", {}) if isinstance(payload.get("structured_data"), dict) else {}
    full_name = str(payload.get("name") or f"{employee.first_name} {employee.last_name}").strip()
    experience_years_raw = payload.get("experience_years")
    if isinstance(experience_years_raw, int):
        experience_years = experience_years_raw
    else:
        experience_years = int(employee.total_experience_years or 0)

    certifications = extract_certifications(payload)
    skills = as_string_list(payload.get("skills"))
    experiences = structured.get("experience", []) if isinstance(structured.get("experience"), list) else []
    projects = structured.get("projects", []) if isinstance(structured.get("projects"), list) else []

    lines: list[str] = []
    title = employee.current_position or "employee"
    lines.append(f"{full_name} is a {title}.")
    lines.append(f"They have approximately {experience_years} years of experience.")
    if employee.professional_summary:
        lines.append(f"Professional summary: {employee.professional_summary.strip()}")
    if skills:
        lines.append(f"Core skills: {', '.join(skills)}.")
    if certifications:
        lines.append(f"Certifications: {', '.join(certifications)}.")

    if experiences:
        lines.append("Work experience:")
        for exp in experiences:
            if not isinstance(exp, dict):
                continue
            start = str(exp.get("start_date") or "").strip()
            end = str(exp.get("end_date") or "").strip()
            company = str(exp.get("company") or "").strip() or "Unknown company"
            role = str(exp.get("title") or "").strip() or "Unknown role"
            period = " - ".join([part for part in [start, end] if part])
            sentence = f"- {company}: {role}"
            if period:
                sentence += f" ({period})"
            lines.append(sentence + ".")

    if projects:
        lines.append("Projects delivered:")
        for project in projects:
            if not isinstance(project, dict):
                continue
            date = str(project.get("date") or "").strip()
            client = str(project.get("client") or "").strip() or "Unknown client"
            description = str(project.get("description") or "").strip() or "No description provided"
            snippet = f"- {client}"
            if date:
                snippet += f" in {date}"
            snippet += f": {description}."
            lines.append(snippet)

    metadata_json: dict[str, Any] = {
        "name": full_name,
        "email": employee.email,
        "current_position": employee.current_position,
        "experience_years": experience_years,
        "skills": skills,
        "certifications": certifications,
        "experiences": experiences,
        "projects": projects,
        "filename": payload.get("filename"),
        "last_update": payload.get("last_update"),
    }

    return "\n".join(lines), metadata_json


def load_employees() -> list[EmployeeRow]:
    query = text(
        """
        SELECT
            u.user_id,
            u.first_name,
            u.last_name,
            u.email,
            ep.current_position,
            ep.total_experience_years,
            ep.professional_summary,
            ep.folder_path
        FROM users u
        JOIN employee_profiles ep ON ep.user_id = u.user_id
        WHERE u.role = 'employee'
        ORDER BY u.last_name, u.first_name
        """
    )
    with SessionLocal() as session:
        rows = session.execute(query).mappings().all()
    return [EmployeeRow(**row) for row in rows]


def run_ingestion(limit: int | None, dry_run: bool) -> None:
    QDRANT_PATH.mkdir(exist_ok=True)
    roots = resolve_metadata_roots()
    metadata_index = discover_metadata_index(roots)

    embedder = OllamaEmbeddings(
        model=settings.EMBEDDING_MODEL,
        base_url=settings.OLLAMA_URL,
    )
    employees = load_employees()
    if limit is not None:
        employees = employees[:limit]

    documents: list[Document] = []
    processed = 0
    skipped = 0
    for employee in employees:
        metadata_path = find_metadata_file(employee, roots, metadata_index)
        if not metadata_path:
            skipped += 1
            print(f"[SKIP] metadata.json not found for {employee.first_name} {employee.last_name}")
            continue

        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        content, metadata_json = build_golden_record(employee, payload)
        metadata_json["metadata_path"] = str(metadata_path)
        metadata_json["user_id"] = str(employee.user_id)

        documents.append(Document(page_content=content, metadata=metadata_json))
        processed += 1
        if dry_run:
            print(f"[DRY-RUN] Prepared {employee.user_id} from {metadata_path}")
        else:
            print(f"[OK] Staged {employee.user_id} from {metadata_path}")

    if dry_run:
        print(f"Done. processed={processed}, skipped={skipped}, total={len(employees)} (no writes)")
        return

    if not documents:
        print("No documents to index; nothing written to Qdrant.")
        return

    client = QdrantClient(path=str(QDRANT_PATH))
    client.recreate_collection(
        collection_name="employees",
        vectors_config=models.VectorParams(
            size=settings.EMBEDDING_DIM,
            distance=models.Distance.COSINE,
        ),
    )
    vectorstore = QdrantVectorStore(
        client=client,
        collection_name="employees",
        embedding=embedder,
        distance=models.Distance.COSINE,
    )
    vectorstore.add_documents(documents)
    print(f"Indexed {len(documents)} documents into Qdrant collection 'employees'. Skipped={skipped}.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest employees + metadata.json into employee_rag_vectors.")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of employees to ingest.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build content + embeddings without inserting rows.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    run_ingestion(limit=args.limit, dry_run=args.dry_run)
