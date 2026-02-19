import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

from langchain_core.documents import Document
from langchain_ollama import OllamaEmbeddings
from sqlalchemy import text

from app.config import settings
from app.rag.db import SessionLocal

REPO_ROOT = Path(__file__).resolve().parents[3]


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
    skills: list[str]
    certifications: list[str]
    experience: list[dict[str, Any]]
    projects: list[dict[str, Any]]
    education: list[dict[str, Any]]


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

def _is_cert_fragment(name: str) -> bool:
    """Return True if this is a dangling word-fragment from a split multi-line cert name.
    
    Examples of fragments: 'Troubleshooting', 'Routing', 'Switching', 'Solutions', '1'
    A real cert name has at least one digit OR contains multiple meaningful words OR
    an uppercase brand/acronym pattern.
    """
    import re as _re
    s = name.strip()
    if len(s) <= 3 or s.isdigit():
        return True
    words = s.split()
    # Single word with no digit and no slash = fragment
    if len(words) == 1 and not _re.search(r'[\d/]', s):
        return True
    return False


def extract_certifications(payload: dict[str, Any]) -> list[str]:
    certs = as_string_list(payload.get("certifications"))
    for cert in payload.get("structured_data", {}).get("certifications", []):
        if isinstance(cert, dict):
            value = str(cert.get("name") or "").strip()
            if value:
                certs.append(value)
    # Merge dangling single-word fragments back into the preceding cert name
    merged: list[str] = []
    for c in dict.fromkeys(certs):
        if _is_cert_fragment(c) and merged:
            merged[-1] = merged[-1] + " " + c
        else:
            merged.append(c)
    return merged


def build_chunks(employee: EmployeeRow, payload: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """
    Build multiple focused text chunks per employee, one per section.
    Returns a list of (content, metadata) pairs.
    """
    full_name = f"{employee.first_name} {employee.last_name}"
    user_id_str = str(employee.user_id)

    # Deduplicate skills and certs from both DB and metadata.json
    db_skills = employee.skills or []
    payload_skills = as_string_list(payload.get("skills"))
    all_skills = list(dict.fromkeys(db_skills + payload_skills))

    db_certs = employee.certifications or []
    payload_certs = extract_certifications(payload)
    # Combine, deduplicate, then merge stray fragments from both sources
    combined_certs: list[str] = []
    for c in list(dict.fromkeys(db_certs + payload_certs)):
        if _is_cert_fragment(c) and combined_certs:
            combined_certs[-1] = combined_certs[-1] + " " + c
        else:
            combined_certs.append(c)
    # Final dedup after possible fragment-merging duplicates
    all_certs = list(dict.fromkeys(combined_certs))

    base_meta = {
        "user_id": user_id_str,
        "name": full_name,
        "email": employee.email,
    }

    chunks: list[tuple[str, dict[str, Any]]] = []

    # ── 1. Profile / overview chunk ──────────────────────────────────
    title = employee.current_position or "Employee"
    lines = [f"{full_name} is a {title}."]
    lines.append(f"They have approximately {employee.total_experience_years or 0} years of experience.")
    if employee.professional_summary:
        lines.append(f"Professional summary: {employee.professional_summary.strip()}")
    if employee.email:
        lines.append(f"Email: {employee.email}")
    chunks.append((
        "\n".join(lines),
        {**base_meta, "chunk_type": "profile", "chunk_id": f"{user_id_str}_profile"}
    ))

    # ── 2. Skills chunk ──────────────────────────────────────────────
    if all_skills:
        content = f"{full_name} — Skills:\n" + "\n".join(f"- {s}" for s in all_skills)
        chunks.append((
            content,
            {**base_meta, "chunk_type": "skills", "chunk_id": f"{user_id_str}_skills"}
        ))

    # ── 3. Certifications chunk ──────────────────────────────────────
    if all_certs:
        content = f"{full_name} — Certifications:\n" + "\n".join(f"- {full_name}: {c}" for c in all_certs)
        chunks.append((
            content,
            {**base_meta, "chunk_type": "certifications", "chunk_id": f"{user_id_str}_certifications",
             "certifications": all_certs}
        ))

    # ── 4. Work Experience chunk ─────────────────────────────────────
    if employee.experience:
        lines = [f"{full_name} — Work Experience:"]
        for exp in employee.experience:
            period = ""
            if exp.get("start_date"):
                period = f" ({exp['start_date']} - {exp.get('end_date') or 'Present'})"
            desc = exp.get("description", "")
            lines.append(f"- {full_name} at {exp.get('company_name', 'Unknown')}: {exp.get('job_title', 'Unknown')}{period}.")
            if desc:
                lines.append(f"  {desc}")
        chunks.append((
            "\n".join(lines),
            {**base_meta, "chunk_type": "experience", "chunk_id": f"{user_id_str}_experience"}
        ))

    # ── 5. Education chunk ───────────────────────────────────────────
    if employee.education:
        lines = [f"{full_name} — Education:"]
        for edu in employee.education:
            degree = edu.get("degree") or ""
            field = edu.get("field_of_study") or ""
            institution = edu.get("institution") or ""
            end_date = edu.get("end_date") or ""
            parts = [f"{full_name}:"]
            if degree:
                parts.append(degree)
            if field:
                parts.append(f"in {field}")
            if institution:
                parts.append(f"from {institution}")
            if end_date:
                parts.append(f"({end_date})")
            lines.append(f"- {' '.join(parts)}" if len(parts) > 1 else f"- {full_name}: (details not available)")
        chunks.append((
            "\n".join(lines),
            {**base_meta, "chunk_type": "education", "chunk_id": f"{user_id_str}_education"}
        ))

    # ── 6. Projects chunk ────────────────────────────────────────────
    if employee.projects:
        lines = [f"{full_name} — Projects:"]
        for proj in employee.projects:
            year = f" ({proj['project_year']})" if proj.get("project_year") else ""
            client = proj.get("client_name") or "Unknown client"
            desc = proj.get("project_description") or ""
            pname = proj.get("project_name")
            if not pname or pname.lower() == "unknown project":
                pname = f"Project for {client}"
            
            lines.append(f"- {full_name}: {pname}{year}.")
            if desc:
                lines.append(f"  {desc}")
        chunks.append((
            "\n".join(lines),
            {**base_meta, "chunk_type": "projects", "chunk_id": f"{user_id_str}_projects"}
        ))

    return chunks


def load_employees() -> list[EmployeeRow]:
    with SessionLocal() as session:
        query = text("""
            SELECT u.user_id, u.first_name, u.last_name, u.email, 
                   ep.profile_id, ep.current_position, ep.total_experience_years, 
                   ep.professional_summary, ep.folder_path
            FROM users u
            JOIN employee_profiles ep ON ep.user_id = u.user_id
            WHERE u.role = 'employee'
        """)
        base_rows = session.execute(query).mappings().all()

        employees = []
        for row in base_rows:
            p_id = row['profile_id']
            skills = session.execute(text("SELECT s.skill_name FROM employee_skills es JOIN skills s ON s.skill_id = es.skill_id WHERE es.profile_id = :p_id"), {"p_id": p_id}).scalars().all()
            certs = session.execute(text("SELECT certification_name FROM certifications WHERE profile_id = :p_id"), {"p_id": p_id}).scalars().all()
            exp = session.execute(text("SELECT job_title, company_name, start_date, end_date, description FROM work_experience WHERE profile_id = :p_id"), {"p_id": p_id}).mappings().all()
            proj = session.execute(text("""
                SELECT p.project_name, p.client_name, p.project_year, p.project_description 
                FROM project_participants pp 
                JOIN projects p ON p.project_id = pp.project_id 
                WHERE pp.profile_id = :p_id
            """), {"p_id": p_id}).mappings().all()
            edu = session.execute(text("SELECT degree, field_of_study, institution, end_date FROM education WHERE profile_id = :p_id"), {"p_id": p_id}).mappings().all()

            employees.append(EmployeeRow(
                user_id=row['user_id'],
                first_name=row['first_name'],
                last_name=row['last_name'],
                email=row['email'],
                current_position=row['current_position'],
                total_experience_years=row['total_experience_years'],
                professional_summary=row['professional_summary'],
                folder_path=row['folder_path'],
                skills=list(skills),
                certifications=list(certs),
                experience=[dict(r) for r in exp],
                projects=[dict(r) for r in proj],
                education=[dict(r) for r in edu],
            ))
        return employees


def ingest_employee(user_id: str | UUID, session: Any = None) -> bool:
    """Ingest/Update a single employee's vectors in RAG (one vector per section chunk)."""
    from app.rag.models import EmployeeRagVector, init_rag_schema

    uid = UUID(str(user_id))
    roots = resolve_metadata_roots()
    metadata_index = discover_metadata_index(roots)

    embedder = OllamaEmbeddings(
        model=settings.EMBEDDING_MODEL,
        base_url=settings.OLLAMA_URL,
    )

    all_employees = load_employees()
    employee = next((e for e in all_employees if e.user_id == uid), None)

    if not employee:
        print(f"[ERROR] Employee {uid} not found in DB.")
        return False

    metadata_path = find_metadata_file(employee, roots, metadata_index)
    payload = {}
    if metadata_path:
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            payload["metadata_path"] = str(metadata_path)
        except Exception:
            pass

    chunks = build_chunks(employee, payload)

    with SessionLocal() as s:
        init_rag_schema()
        # Delete all existing chunks for this user, then insert fresh ones
        s.query(EmployeeRagVector).filter(EmployeeRagVector.user_id == uid).delete()
        s.flush()

        for content, meta in chunks:
            chunk_id = meta.get("chunk_id", f"{uid}_{meta.get('chunk_type', 'unknown')}")
            embedding = embedder.embed_query(content)
            new_vec = EmployeeRagVector(
                user_id=uid,
                chunk_id=chunk_id,
                content=content,
                metadata_json=meta,
                embedding=embedding,
            )
            s.add(new_vec)

        s.commit()

    print(f"[OK] Re-indexed {uid} ({employee.first_name} {employee.last_name}) — {len(chunks)} chunks")
    # Always refresh the directory chunk after any individual employee change
    ingest_directory(embedder)
    return True


def ingest_directory(embedder: Any = None) -> None:
    """Build/refresh the global employee directory chunk.
    
    This single chunk lists every employee by name so queries like
    'how many employees do we have?' always see the full roster.
    """
    from app.rag.models import EmployeeRagVector, init_rag_schema
    import uuid as _uuid

    # Fixed sentinel UUID for the directory — not tied to any real user
    DIRECTORY_UUID = _uuid.UUID("00000000-0000-0000-0000-000000000001")
    DIRECTORY_CHUNK_ID = "__directory__"

    _embedder = embedder
    if _embedder is None:
        _embedder = OllamaEmbeddings(
            model=settings.EMBEDDING_MODEL,
            base_url=settings.OLLAMA_URL,
        )

    # Load all employees directly via a lightweight query
    with SessionLocal() as session:
        rows = session.execute(text("""
            SELECT u.first_name, u.last_name, u.email, ep.current_position,
                   ep.total_experience_years
            FROM users u
            JOIN employee_profiles ep ON ep.user_id = u.user_id
            WHERE u.role = 'employee'
            ORDER BY u.last_name, u.first_name
        """)).mappings().all()

    if not rows:
        return

    lines = [f"Employee Directory — {len(rows)} employee(s) total:"]
    for r in rows:
        name = f"{r['first_name'] or ''} {r['last_name'] or ''}".strip() or r['email']
        role = r['current_position'] or 'Employee'
        exp = r['total_experience_years'] or 0
        lines.append(f"- {name} ({role}, ~{exp} years experience, email: {r['email']})")

    content = "\n".join(lines)
    meta = {"chunk_type": "directory", "chunk_id": DIRECTORY_CHUNK_ID, "total_employees": len(rows)}
    embedding = _embedder.embed_query(content)

    with SessionLocal() as s:
        init_rag_schema()
        existing = s.query(EmployeeRagVector).filter_by(chunk_id=DIRECTORY_CHUNK_ID).first()
        if existing:
            existing.content = content
            existing.metadata_json = meta
            existing.embedding = embedding
        else:
            s.add(EmployeeRagVector(
                user_id=DIRECTORY_UUID,
                chunk_id=DIRECTORY_CHUNK_ID,
                content=content,
                metadata_json=meta,
                embedding=embedding,
            ))
        s.commit()
    print(f"[OK] Directory chunk updated — {len(rows)} employees listed")


def run_ingestion(limit: int | None, dry_run: bool) -> None:
    from app.rag.models import init_rag_schema

    roots = resolve_metadata_roots()
    metadata_index = discover_metadata_index(roots)

    employees = load_employees()
    if limit is not None:
        employees = employees[:limit]

    processed = 0
    skipped = 0

    if not dry_run:
        init_rag_schema()

    for employee in employees:
        if dry_run:
            chunks = build_chunks(employee, {})
            print(f"[DRY-RUN] {employee.first_name} {employee.last_name}: {len(chunks)} chunks")
            for content, meta in chunks:
                print(f"  [{meta['chunk_type']}] {content[:80]}...")
            processed += 1
            continue

        # Each employee gets its own session via ingest_employee
        ingest_employee(employee.user_id)
        processed += 1

    if not dry_run:
        # Final refresh of the directory chunk (covers the full employee list)
        ingest_directory()

    print(f"Done. processed={processed}, skipped={skipped}, total={len(employees)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest employees into RAG with per-section chunks.")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of employees to ingest.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build content without inserting rows.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    run_ingestion(limit=args.limit, dry_run=args.dry_run)
