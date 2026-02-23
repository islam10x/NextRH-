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
from sqlalchemy import text

from app.config import settings
from app.rag.db import SessionLocal

REPO_ROOT = Path(__file__).resolve().parents[3]


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
    Build focused chunks plus entry-level chunks so retrieval can target
    single projects/experiences and support comparisons reliably.
    """
    full_name = f"{employee.first_name} {employee.last_name}"
    user_id_str = str(employee.user_id)

    db_skills = employee.skills or []
    payload_skills = as_string_list(payload.get("skills"))
    all_skills = list(dict.fromkeys(db_skills + payload_skills))

    db_certs = employee.certifications or []
    payload_certs = extract_certifications(payload)
    combined_certs: list[str] = []
    for cert in list(dict.fromkeys(db_certs + payload_certs)):
        if _is_cert_fragment(cert) and combined_certs:
            combined_certs[-1] = combined_certs[-1] + " " + cert
        else:
            combined_certs.append(cert)
    all_certs = list(dict.fromkeys(combined_certs))

    experience_count = len(employee.experience or [])
    project_count = len(employee.projects or [])

    base_meta = {
        "user_id": user_id_str,
        "name": full_name,
        "email": employee.email,
    }
    chunks: list[tuple[str, dict[str, Any]]] = []

    title = employee.current_position or "Employee"
    profile_lines = [f"{full_name} is a {title}."]
    if isinstance(employee.total_experience_years, int) and employee.total_experience_years > 0:
        profile_lines.append(f"They have approximately {employee.total_experience_years} years of experience.")
    profile_lines.append(f"Recorded work experience entries: {experience_count}.")
    profile_lines.append(f"Recorded project entries: {project_count}.")
    if employee.professional_summary:
        profile_lines.append(f"Professional summary: {employee.professional_summary.strip()}")
    if employee.email:
        profile_lines.append(f"Email: {employee.email}")
    chunks.append((
        "\n".join(profile_lines),
        {
            **base_meta,
            "chunk_type": "profile",
            "chunk_id": f"{user_id_str}_profile",
            "experience_count": experience_count,
            "project_count": project_count,
        }
    ))

    if all_skills:
        chunks.append((
            f"{full_name} - Skills:\n" + "\n".join(f"- {skill}" for skill in all_skills),
            {**base_meta, "chunk_type": "skills", "chunk_id": f"{user_id_str}_skills"}
        ))

    if all_certs:
        chunks.append((
            f"{full_name} - Certifications:\n" + "\n".join(f"- {full_name}: {cert}" for cert in all_certs),
            {
                **base_meta,
                "chunk_type": "certifications",
                "chunk_id": f"{user_id_str}_certifications",
                "certifications": all_certs,
            }
        ))
        for idx, cert in enumerate(all_certs):
            chunks.append((
                f"Certification Entry for {full_name}\nCertification: {cert}",
                {
                    **base_meta,
                    "chunk_type": "certification_entry",
                    "chunk_id": f"{user_id_str}_certification_entry_{idx}",
                    "certification_name": cert,
                }
            ))

    if employee.experience:
        summary_lines = [f"{full_name} - Work Experience:"]
        for idx, exp in enumerate(employee.experience):
            company = str(exp.get("company_name") or "Unknown")
            role = str(exp.get("job_title") or "Unknown")
            start_date = str(exp.get("start_date") or "")
            end_date = str(exp.get("end_date") or "")
            description = str(exp.get("description") or "")
            period = ""
            if start_date:
                period = f" ({start_date} - {end_date or 'Present'})"
            summary_lines.append(f"- {full_name} at {company}: {role}{period}.")
            if description:
                summary_lines.append(f"  {description}")

            entry_lines = [
                f"Experience Entry for {full_name}",
                f"Company: {company}",
                f"Role: {role}",
            ]
            if start_date:
                entry_lines.append(f"Start date: {start_date}")
            if end_date:
                entry_lines.append(f"End date: {end_date}")
            if description:
                entry_lines.append(f"Description: {description}")
            chunks.append((
                "\n".join(entry_lines),
                {
                    **base_meta,
                    "chunk_type": "experience_entry",
                    "chunk_id": f"{user_id_str}_experience_entry_{idx}",
                    "company_name": company,
                    "job_title": role,
                    "start_date": start_date,
                    "end_date": end_date,
                    "description": description,
                }
            ))

        chunks.append((
            "\n".join(summary_lines),
            {
                **base_meta,
                "chunk_type": "experience",
                "chunk_id": f"{user_id_str}_experience",
                "experience_count": experience_count,
            }
        ))

    if employee.education:
        lines = [f"{full_name} - Education:"]
        for idx, edu in enumerate(employee.education):
            degree = str(edu.get("degree") or "")
            field = str(edu.get("field_of_study") or "")
            institution = str(edu.get("institution") or "")
            end_date = str(edu.get("end_date") or "")
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
            entry_lines = [
                f"Education Entry for {full_name}",
            ]
            if degree:
                entry_lines.append(f"Degree: {degree}")
            if field:
                entry_lines.append(f"Field of study: {field}")
            if institution:
                entry_lines.append(f"Institution: {institution}")
            if end_date:
                entry_lines.append(f"End date: {end_date}")
            chunks.append((
                "\n".join(entry_lines),
                {
                    **base_meta,
                    "chunk_type": "education_entry",
                    "chunk_id": f"{user_id_str}_education_entry_{idx}",
                    "degree": degree,
                    "field_of_study": field,
                    "institution": institution,
                    "end_date": end_date,
                }
            ))
        chunks.append((
            "\n".join(lines),
            {**base_meta, "chunk_type": "education", "chunk_id": f"{user_id_str}_education"}
        ))

    if employee.projects:
        summary_lines = [f"{full_name} - Projects:"]
        for idx, proj in enumerate(employee.projects):
            project_name = str(proj.get("project_name") or "").strip()
            client_name = str(proj.get("client_name") or "").strip() or "Unknown client"
            project_year = str(proj.get("project_year") or "").strip()
            project_desc = str(proj.get("project_description") or "").strip()
            if not project_name or project_name.lower() == "unknown project":
                project_name = f"Project for {client_name}"
            year_suffix = f" ({project_year})" if project_year else ""
            summary_lines.append(f"- {full_name}: {project_name}{year_suffix}.")
            if project_desc:
                summary_lines.append(f"  {project_desc}")

            entry_lines = [
                f"Project Entry for {full_name}",
                f"Project name: {project_name}",
                f"Client: {client_name}",
            ]
            if project_year:
                entry_lines.append(f"Year: {project_year}")
            if project_desc:
                entry_lines.append(f"Description: {project_desc}")
            chunks.append((
                "\n".join(entry_lines),
                {
                    **base_meta,
                    "chunk_type": "project_entry",
                    "chunk_id": f"{user_id_str}_project_entry_{idx}",
                    "project_name": project_name,
                    "client_name": client_name,
                    "project_year": project_year,
                    "project_description": project_desc,
                }
            ))

        chunks.append((
            "\n".join(summary_lines),
            {
                **base_meta,
                "chunk_type": "projects",
                "chunk_id": f"{user_id_str}_projects",
                "project_count": project_count,
            }
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
    """Build/refresh the global employee directory chunk."""
    from app.rag.models import EmployeeRagVector, init_rag_schema
    import uuid as _uuid

    DIRECTORY_UUID = _uuid.UUID("00000000-0000-0000-0000-000000000001")
    DIRECTORY_CHUNK_ID = "__directory__"

    _embedder = embedder
    if _embedder is None:
        _embedder = OllamaEmbeddings(
            model=settings.EMBEDDING_MODEL,
            base_url=settings.OLLAMA_URL,
        )

    with SessionLocal() as session:
        rows = session.execute(text("""
            SELECT
                u.first_name,
                u.last_name,
                u.email,
                ep.current_position,
                ep.total_experience_years,
                COALESCE(exp_stats.experience_entries, 0) AS experience_entries,
                COALESCE(proj_stats.project_count, 0) AS project_count,
                COALESCE(company_stats.companies, '') AS companies
            FROM users u
            JOIN employee_profiles ep ON ep.user_id = u.user_id
            LEFT JOIN (
                SELECT profile_id, COUNT(*) AS experience_entries
                FROM work_experience
                GROUP BY profile_id
            ) exp_stats ON exp_stats.profile_id = ep.profile_id
            LEFT JOIN (
                SELECT profile_id, COUNT(*) AS project_count
                FROM project_participants
                GROUP BY profile_id
            ) proj_stats ON proj_stats.profile_id = ep.profile_id
            LEFT JOIN (
                SELECT
                    profile_id,
                    STRING_AGG(DISTINCT company_name, ', ' ORDER BY company_name) AS companies
                FROM work_experience
                WHERE company_name IS NOT NULL AND TRIM(company_name) <> ''
                GROUP BY profile_id
            ) company_stats ON company_stats.profile_id = ep.profile_id
            WHERE u.role = 'employee'
            ORDER BY u.last_name, u.first_name
        """)).mappings().all()

    if not rows:
        return

    lines = [f"Employee Directory - {len(rows)} employee(s) total:"]
    employees_meta: list[dict[str, Any]] = []
    for row in rows:
        name = f"{row['first_name'] or ''} {row['last_name'] or ''}".strip() or row['email']
        role = row['current_position'] or 'Employee'
        years_exp = row['total_experience_years']
        exp_entries = int(row['experience_entries'] or 0)
        project_count = int(row['project_count'] or 0)
        companies_raw = str(row['companies'] or '').strip()
        companies = [c.strip() for c in companies_raw.split(',') if c.strip()]

        line = (
            f"- {name} | role={role} | email={row['email']} "
            f"| experience_entries={exp_entries} | project_count={project_count}"
        )
        if isinstance(years_exp, int) and years_exp > 0:
            line += f" | experience_years~{years_exp}"
        if companies:
            line += f" | companies={'; '.join(companies)}"
        lines.append(line)

        employees_meta.append(
            {
                "name": name,
                "email": row["email"],
                "role": role,
                "experience_entries": exp_entries,
                "project_count": project_count,
                "experience_years": int(years_exp) if isinstance(years_exp, int) else None,
                "companies": companies,
            }
        )

    content = "\n".join(lines)
    meta = {
        "chunk_type": "directory",
        "chunk_id": DIRECTORY_CHUNK_ID,
        "total_employees": len(rows),
        "employees": employees_meta,
    }
    embedding = _embedder.embed_query(content)

    with SessionLocal() as session:
        init_rag_schema()
        existing = session.query(EmployeeRagVector).filter_by(chunk_id=DIRECTORY_CHUNK_ID).first()
        if existing:
            existing.content = content
            existing.metadata_json = meta
            existing.embedding = embedding
        else:
            session.add(
                EmployeeRagVector(
                    user_id=DIRECTORY_UUID,
                    chunk_id=DIRECTORY_CHUNK_ID,
                    content=content,
                    metadata_json=meta,
                    embedding=embedding,
                )
            )
        session.commit()

    print(f"[OK] Directory chunk updated - {len(rows)} employees listed")

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


# ── CLI ───────────────────────────────────────────────────────────────────────

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


