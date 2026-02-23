"""
ETL pipeline — ingest employee metadata.json files into Qdrant.

Preferred entry point: sync_metadata_files_to_qdrant()

Chunking strategy (section-based):
  Chunk 0: Identity + Certifications + Experience + Company names
  Chunk 1: Projects + Client names       (skipped if no projects)
  Chunk 2: Education + School/Degree     (skipped if no education)

Every chunk:
  - Stamps entity_type='employee'
  - Carries full certifications, experiences, projects lists in metadata
  - Embeds each cert, company, client, school as a standalone line
    so proper-noun queries match via cosine similarity

indexing_threshold=0 ensures Qdrant indexes all payload fields immediately
regardless of collection size.
"""

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID, NAMESPACE_DNS, uuid5

from langchain_core.documents import Document
from langchain_ollama import OllamaEmbeddings
from langchain_qdrant import QdrantVectorStore
from qdrant_client import QdrantClient
from qdrant_client.http import models
from sqlalchemy import text

from app.config import settings
from app.rag.db import SessionLocal

REPO_ROOT = Path(__file__).resolve().parents[3]
ENTITY_TYPE_EMPLOYEE = "employee"


# ── Helpers ───────────────────────────────────────────────────────────────────

def normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def as_string_list(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    return [str(item).strip() for item in values if str(item).strip()]


def extract_certifications(payload: dict[str, Any]) -> list[str]:
    flat = as_string_list(payload.get("certifications") or [])
    nested = [
        str(c.get("name") or "").strip()
        for c in payload.get("structured_data", {}).get("certifications", [])
        if isinstance(c, dict) and str(c.get("name") or "").strip()
    ]
    return list(dict.fromkeys(flat + nested))


# ── Qdrant collection ─────────────────────────────────────────────────────────

def _create_qdrant_collection(client: QdrantClient) -> None:
    """
    Drop and recreate collection with all payload indexes.
    indexing_threshold=0 forces immediate indexing regardless of collection size.
    TEXT indexes enable MatchText (partial/case-insensitive).
    KEYWORD indexes enable MatchValue (exact).
    """
    if client.collection_exists("employees"):
        client.delete_collection("employees")

    client.create_collection(
        collection_name="employees",
        vectors_config=models.VectorParams(
            size=settings.EMBEDDING_DIM,
            distance=models.Distance.COSINE,
        ),
        hnsw_config=models.HnswConfigDiff(m=32, ef_construct=128),
        # CRITICAL: 0 = index immediately, don't wait for point count threshold
        optimizers_config=models.OptimizersConfigDiff(indexing_threshold=0),
    )

    payload_indexes = {
        "entity_type":      models.PayloadSchemaType.KEYWORD,
        "name":             models.PayloadSchemaType.KEYWORD,
        "certifications":   models.PayloadSchemaType.TEXT,
        "skills":           models.PayloadSchemaType.TEXT,
        "semantic_text":    models.PayloadSchemaType.TEXT,
        "experience_years": models.PayloadSchemaType.INTEGER,
        "document_id":      models.PayloadSchemaType.KEYWORD,
        "file_name":        models.PayloadSchemaType.KEYWORD,
    }
    for field, schema in payload_indexes.items():
        client.create_payload_index("employees", field_name=field, field_schema=schema)

    print(f"[QDRANT] Collection 'employees' created with {len(payload_indexes)} indexes.")


# ── Document building ─────────────────────────────────────────────────────────

def _make_metadata(
    name: str,
    skills: list[str],
    certifications: list[str],
    experience_years: int,
    experiences: list[Any],
    projects: list[Any],
    doc_id: str,
    file_name: str,
    chunk_index: int,
    text_chunk: str,
    user_id: str,
) -> dict[str, Any]:
    return {
        "entity_type":      ENTITY_TYPE_EMPLOYEE,
        "name":             name,
        "skills":           skills,
        "certifications":   certifications,
        "experience_years": experience_years,
        "experiences":      experiences,
        "projects":         projects,
        "semantic_text":    text_chunk,
        "page_content":     text_chunk,
        "document_id":      doc_id,
        "file_name":        file_name,
        "chunk_index":      chunk_index,
        "user_id":          user_id,
    }


def _document_chunks_from_json(payload: dict[str, Any], metadata_path: Path) -> list[Document]:
    file_name = metadata_path.name
    doc_id = hashlib.md5(str(metadata_path).encode("utf-8")).hexdigest()
    name = str(payload.get("name") or metadata_path.parent.name).strip()
    user_id = normalize_name(name) or metadata_path.parent.name
    skills = as_string_list(payload.get("skills") or [])
    certifications = extract_certifications(payload)
    experience_years = int(payload.get("experience_years") or payload.get("total_experience_years") or 0)
    summary = str(payload.get("professional_summary") or "").strip()

    structured = payload.get("structured_data") if isinstance(payload.get("structured_data"), dict) else {}
    experiences = structured.get("experience") if isinstance(structured.get("experience"), list) else []
    projects = structured.get("projects") if isinstance(structured.get("projects"), list) else []
    education = structured.get("education") if isinstance(structured.get("education"), list) else []

    # ── Pre-process ───────────────────────────────────────────────────────────

    exp_lines, company_names = [], []
    for exp in experiences:
        if not isinstance(exp, dict):
            continue
        company = str(exp.get("company") or "").strip()
        title = str(exp.get("title") or "").strip()
        start = str(exp.get("start_date") or "").strip()
        end = str(exp.get("end_date") or "").strip()
        if company and company not in company_names:
            company_names.append(company)
        piece = f"{title} at {company}".strip(" at")
        if start or end:
            piece += f" ({start} - {end})"
        if piece:
            exp_lines.append(piece)

    proj_lines, client_names = [], []
    for proj in projects:
        if not isinstance(proj, dict):
            continue
        client = str(proj.get("client") or "").strip()
        desc = str(proj.get("description") or "").strip()
        date = str(proj.get("date") or "").strip()
        if client and client not in client_names:
            client_names.append(client)
        piece = client or "Project"
        if date:
            piece += f" ({date})"
        if desc:
            piece += f": {desc}"
        if piece:
            proj_lines.append(piece)

    edu_lines, school_names, degree_names = [], [], []
    for ed in education:
        if not isinstance(ed, dict):
            continue
        degree = str(ed.get("degree_name") or ed.get("degree") or "").strip()
        school = str(ed.get("institution") or ed.get("school") or "").strip()
        end = str(ed.get("end_date") or "").strip()
        if school:
            # Embed acronym (e.g. "IMSET" from "IMSET. Technicien...")
            acronym = school.split(".")[0].strip()
            if acronym and acronym not in school_names:
                school_names.append(acronym)
            if school not in school_names:
                school_names.append(school)
        if degree and degree not in degree_names:
            degree_names.append(degree)
        piece = degree or "Education"
        if school:
            piece += f" at {school}"
        if end:
            piece += f" ({end})"
        if piece:
            edu_lines.append(piece)

    # ── Build chunk texts ─────────────────────────────────────────────────────

    def _join(*parts: str) -> str:
        return "\n".join(p for p in parts if p)

    chunk0 = _join(
        f"Employee Name: {name}. Experience: {experience_years} years.",
        f"Summary: {summary}" if summary else "",
        "Skills: " + ", ".join(skills) if skills else "",
        "Certifications: " + ", ".join(certifications) if certifications else "",
        # Each cert as standalone line for exact-match cosine similarity
        *certifications,
        "Experience: " + " | ".join(exp_lines) if exp_lines else "",
        "Worked at: " + ", ".join(company_names) if company_names else "",
        # Each company as standalone line
        *company_names,
    )

    chunk1 = _join(
        f"Employee Name: {name}.",
        "Projects: " + " | ".join(proj_lines) if proj_lines else "",
        "Clients: " + ", ".join(client_names) if client_names else "",
        # Each client as standalone line
        *client_names,
    ) if proj_lines or client_names else ""

    chunk2 = _join(
        f"Employee Name: {name}.",
        "Education: " + " | ".join(edu_lines) if edu_lines else "",
        *school_names,
        *degree_names,
    ) if edu_lines else ""

    # ── Assemble documents ────────────────────────────────────────────────────

    documents: list[Document] = []
    for idx, text_chunk in enumerate([chunk0, chunk1, chunk2]):
        if not text_chunk.strip():
            continue
        # Skip chunks with no real content beyond the name line
        meaningful = [
            l for l in text_chunk.splitlines()
            if l.strip() and l.strip() != f"Employee Name: {name}."
        ]
        if not meaningful:
            continue

        documents.append(Document(
            page_content=text_chunk,
            metadata=_make_metadata(
                name=name,
                skills=skills,
                certifications=certifications,
                experience_years=experience_years,
                experiences=experiences,
                projects=projects,
                doc_id=doc_id,
                file_name=file_name,
                chunk_index=idx,
                text_chunk=text_chunk,
                user_id=user_id,
            ),
        ))

    if not documents:
        print(f"[WARN] No chunks produced for {name}")
    return documents


# ── Ingestion: file-based (preferred) ─────────────────────────────────────────

def sync_metadata_files_to_qdrant() -> None:
    """
    Discover all metadata.json files under RAG_METADATA_ROOTS and ingest.
    Always call this after adding or updating any employee metadata.json.
    """
    roots: list[Path] = []
    for raw in settings.RAG_METADATA_ROOTS.split(","):
        candidate = Path(raw.strip())
        if not candidate.is_absolute():
            candidate = (REPO_ROOT / candidate).resolve()
        if candidate.exists():
            roots.append(candidate)

    if not roots:
        print("[QDRANT] No valid RAG_METADATA_ROOTS configured.")
        return

    metadata_paths: list[Path] = []
    for root in roots:
        metadata_paths.extend(root.rglob("metadata.json"))

    if not metadata_paths:
        print("[QDRANT] No metadata.json files found.")
        return

    print(f"[QDRANT] Found {len(metadata_paths)} metadata.json files.")

    documents: list[Document] = []
    for path in metadata_paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"[SKIP] Cannot read {path}: {exc}")
            continue
        chunks = _document_chunks_from_json(payload, path)
        documents.extend(chunks)
        print(f"[OK] {payload.get('name', path.parent.name)} → {len(chunks)} chunks")

    if not documents:
        print("[QDRANT] No documents prepared.")
        return

    embedder = OllamaEmbeddings(model=settings.EMBEDDING_MODEL, base_url=settings.OLLAMA_URL)
    client = QdrantClient(url=settings.QDRANT_URL, timeout=60.0)
    _create_qdrant_collection(client)

    vectorstore = QdrantVectorStore(
        client=client,
        collection_name="employees",
        embedding=embedder,
        distance=models.Distance.COSINE,
    )

    # Deterministic UUIDs — re-ingestion is idempotent
    ids = [
        str(uuid5(NAMESPACE_DNS, f"{doc.metadata['document_id']}_{doc.metadata['chunk_index']}"))
        for doc in documents
    ]
    vectorstore.add_documents(documents, ids=ids, batch_size=5)
    print(f"[QDRANT] Done. {len(metadata_paths)} files → {len(documents)} chunks ingested.")

    # Force payload index build
    import time

    print("[QDRANT] Forcing payload index build...")
    time.sleep(3)  # Give Qdrant time to flush
    client.update_collection(
        collection_name="employees",
        optimizers_config=models.OptimizersConfigDiff(indexing_threshold=0),
    )
    info = client.get_collection("employees")
    print(f"[QDRANT] After ingest: points={info.points_count}")

    # Verify indexing after insert
    time.sleep(2)
    info = client.get_collection("employees")
    print(f"[QDRANT] After ingest: points={info.points_count} indexed_vectors={info.indexed_vectors_count}")
    schema = {k: v.data_type for k, v in (info.payload_schema or {}).items()}
    print(f"[QDRANT] Payload schema: {schema}")


# ── Ingestion: DB-based (legacy) ──────────────────────────────────────────────

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


def _load_employees() -> list[EmployeeRow]:
    q = text("""
        SELECT u.user_id, u.first_name, u.last_name, u.email,
               ep.current_position, ep.total_experience_years,
               ep.professional_summary, ep.folder_path
        FROM users u
        JOIN employee_profiles ep ON ep.user_id = u.user_id
        WHERE u.role = 'employee'
        ORDER BY u.last_name, u.first_name
    """)
    with SessionLocal() as session:
        rows = session.execute(q).mappings().all()
    return [EmployeeRow(**row) for row in rows]


def _find_metadata_file(emp: EmployeeRow, roots: list[Path], index: dict[str, Path]) -> Path | None:
    first, last = emp.first_name.strip(), emp.last_name.strip()
    candidates: list[Path] = []

    if emp.folder_path:
        fp = Path(emp.folder_path)
        if fp.is_absolute():
            candidates.append(fp / "metadata.json")
        candidates.append((REPO_ROOT / "backend" / fp / "metadata.json").resolve())
        for root in roots:
            candidates.append((root / fp.name / "metadata.json").resolve())

    for root in roots:
        for variant in [f"{first} {last}", f"{first}_{last}", f"{first}-{last}"]:
            candidates.append((root / variant / "metadata.json").resolve())

    for c in candidates:
        if c.exists():
            return c
    return index.get(normalize_name(f"{first} {last}"))


def trigger_embedding_pipeline(
    employee_id: UUID | str | None = None,
    limit: int | None = None,
    dry_run: bool = False,
) -> None:
    roots: list[Path] = []
    for raw in settings.RAG_METADATA_ROOTS.split(","):
        candidate = Path(raw.strip())
        if not candidate.is_absolute():
            candidate = (REPO_ROOT / candidate).resolve()
        if candidate.exists():
            roots.append(candidate)

    index: dict[str, Path] = {}
    for root in roots:
        for p in root.rglob("metadata.json"):
            index[normalize_name(p.parent.name)] = p
            try:
                payload = json.loads(p.read_text(encoding="utf-8"))
                n = str(payload.get("name") or "").strip()
                if n:
                    index[normalize_name(n)] = p
            except Exception:
                continue

    employees = _load_employees()
    if employee_id is not None:
        target = UUID(str(employee_id))
        employees = [e for e in employees if e.user_id == target]
    if limit is not None:
        employees = employees[:limit]

    documents: list[Document] = []
    processed = skipped = 0

    for emp in employees:
        path = _find_metadata_file(emp, roots, index)
        if not path:
            skipped += 1
            print(f"[SKIP] No metadata.json for {emp.first_name} {emp.last_name}")
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            skipped += 1
            print(f"[SKIP] Cannot read {path}: {exc}")
            continue

        if not payload.get("name"):
            payload["name"] = f"{emp.first_name} {emp.last_name}"
        if not payload.get("experience_years") and emp.total_experience_years:
            payload["experience_years"] = emp.total_experience_years

        chunks = _document_chunks_from_json(payload, path)
        for chunk in chunks:
            chunk.metadata["user_id"] = str(emp.user_id)
            chunk.metadata["email"] = emp.email
            chunk.metadata["current_position"] = emp.current_position

        documents.extend(chunks)
        processed += 1
        tag = "DRY-RUN" if dry_run else "OK"
        print(f"[{tag}] {emp.first_name} {emp.last_name} → {len(chunks)} chunks")

    if dry_run:
        print(f"Done (dry-run). processed={processed}, skipped={skipped}")
        return

    if not documents:
        print("No documents to index.")
        return

    embedder = OllamaEmbeddings(model=settings.EMBEDDING_MODEL, base_url=settings.OLLAMA_URL)
    client = QdrantClient(url=settings.QDRANT_URL, timeout=60.0)
    _create_qdrant_collection(client)

    vectorstore = QdrantVectorStore(
        client=client,
        collection_name="employees",
        embedding=embedder,
        distance=models.Distance.COSINE,
    )
    vectorstore.add_documents(documents, batch_size=5)
    print(f"Indexed {len(documents)} chunks. processed={processed}, skipped={skipped}.")


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest employee metadata into Qdrant.")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--mode", choices=["files", "db"], default="files")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if args.mode == "db":
        trigger_embedding_pipeline(limit=args.limit, dry_run=args.dry_run)
    else:
        sync_metadata_files_to_qdrant()
