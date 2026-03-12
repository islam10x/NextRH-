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
    certifications: list[dict[str, Any]]
    experience: list[dict[str, Any]]
    projects: list[dict[str, Any]]
    education: list[dict[str, Any]]
    snapshot_metadata: dict[str, Any] | None
    snapshot_is_current: bool | None
    snapshot_created_at: Any | None


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
    output: list[str] = []
    for item in values:
        value = item
        if isinstance(item, dict):
            value = (
                item.get("name")
                or item.get("certification_name")
                or item.get("skill_name")
                or item.get("title")
            )
        if value is None:
            continue
        text_value = str(value).strip()
        if text_value:
            output.append(text_value)
    return output


def _norm_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).lower()


def _dedupe_records(records: list[dict[str, Any]], key_fields: list[str]) -> list[dict[str, Any]]:
    seen: set[tuple[str, ...]] = set()
    output: list[dict[str, Any]] = []
    for record in records:
        key = tuple(_norm_text(record.get(field)) for field in key_fields)
        if key in seen:
            continue
        seen.add(key)
        output.append(record)
    return output


def _merge_experience_rows(db_rows: list[dict[str, Any]], payload: dict[str, Any]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for exp in db_rows or []:
        merged.append(
            {
                "job_title": str(exp.get("job_title") or "").strip(),
                "company_name": str(exp.get("company_name") or "").strip(),
                "start_date": str(exp.get("start_date") or "").strip(),
                "end_date": str(exp.get("end_date") or "").strip(),
                "description": str(exp.get("description") or "").strip(),
            }
        )

    for exp in (payload.get("structured_data", {}) or {}).get("experience", []) or []:
        if not isinstance(exp, dict):
            continue
        merged.append(
            {
                "job_title": str(exp.get("title") or exp.get("job_title") or "").strip(),
                "company_name": str(exp.get("company") or exp.get("company_name") or "").strip(),
                "start_date": str(exp.get("start_date") or exp.get("date_range") or exp.get("period") or "").strip(),
                "end_date": str(exp.get("end_date") or "").strip(),
                "description": str(exp.get("description") or "").strip(),
            }
        )

    return _dedupe_records(
        merged,
        key_fields=["company_name", "job_title", "start_date", "end_date", "description"],
    )


def _merge_education_rows(db_rows: list[dict[str, Any]], payload: dict[str, Any]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for edu in db_rows or []:
        merged.append(
            {
                "degree": str(edu.get("degree") or "").strip(),
                "field_of_study": str(edu.get("field_of_study") or "").strip(),
                "institution": str(edu.get("institution") or "").strip(),
                "end_date": str(edu.get("end_date") or "").strip(),
            }
        )

    for edu in (payload.get("structured_data", {}) or {}).get("education", []) or []:
        if not isinstance(edu, dict):
            continue
        merged.append(
            {
                "degree": str(edu.get("degree") or "").strip(),
                "field_of_study": str(edu.get("field_of_study") or "").strip(),
                "institution": str(edu.get("institution") or "").strip(),
                "end_date": str(edu.get("end_date") or edu.get("date") or "").strip(),
            }
        )

    return _dedupe_records(
        merged,
        key_fields=["degree", "field_of_study", "institution", "end_date"],
    )


def _merge_project_rows(db_rows: list[dict[str, Any]], payload: dict[str, Any]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for proj in db_rows or []:
        merged.append(
            {
                "project_name": str(proj.get("project_name") or "").strip(),
                "client_name": str(proj.get("client_name") or "").strip(),
                "project_year": str(proj.get("project_year") or "").strip(),
                "project_description": str(proj.get("project_description") or "").strip(),
            }
        )

    for proj in (payload.get("structured_data", {}) or {}).get("projects", []) or []:
        if not isinstance(proj, dict):
            continue
        merged.append(
            {
                "project_name": str(proj.get("name") or proj.get("project_name") or "").strip(),
                "client_name": str(proj.get("client") or proj.get("client_name") or "").strip(),
                "project_year": str(proj.get("date") or proj.get("project_year") or "").strip(),
                "project_description": str(proj.get("description") or proj.get("project_description") or "").strip(),
            }
        )

    return _dedupe_records(
        merged,
        key_fields=["project_name", "client_name", "project_year", "project_description"],
    )

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
    # payload_certs is handled below when merging
    payload_certs = extract_certifications(payload)
    
    # Track certifications by name to deduplicate and merge metadata
    cert_map: dict[str, dict[str, Any]] = {}

    # 1. Process CV Payload certifications
    for cert_name in list(dict.fromkeys(payload_certs)):
        # Handle word fragments merging (existing logic)
        merged_name = cert_name
        if cert_map:
            last_key = list(cert_map.keys())[-1]
            if _is_cert_fragment(cert_name):
                merged_name = f"{last_key} {cert_name}"
                del cert_map[last_key]
        
        cert_map[merged_name] = {
            "name": merged_name,
            "is_uploaded": False,
            "credential_id": None
        }

    # 2. Process DB certifications (which may be verified uploads)
    for db_cert in db_certs:
        name = db_cert.get("name")
        if not name:
            continue
            
        # If the DB says it's uploaded, or it has a credential ID, it overwrites the CV payload version
        if name in cert_map:
            cert_map[name]["is_uploaded"] = cert_map[name]["is_uploaded"] or db_cert.get("is_uploaded", False)
            if db_cert.get("credential_id"):
                cert_map[name]["credential_id"] = db_cert.get("credential_id")
        else:
            cert_map[name] = {
                "name": name,
                "is_uploaded": db_cert.get("is_uploaded", False),
                "credential_id": db_cert.get("credential_id")
            }

    all_certs = list(cert_map.values())

    merged_experience = _merge_experience_rows(employee.experience or [], payload or {})
    merged_education = _merge_education_rows(employee.education or [], payload or {})
    merged_projects = _merge_project_rows(employee.projects or [], payload or {})

    experience_count = len(merged_experience)
    project_count = len(merged_projects)

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
        # Create a formatted list for the summary chunk
        summary_lines = []
        for c in all_certs:
            status = " [Verified via direct upload]" if c.get("is_uploaded") else ""
            cred = f" (ID: {c.get('credential_id')})" if c.get("credential_id") else ""
            summary_lines.append(f"- {full_name}: {c['name']}{status}{cred}")
            
        chunks.append((
            f"{full_name} - Certifications:\n" + "\n".join(summary_lines),
            {
                **base_meta,
                "chunk_type": "certifications",
                "chunk_id": f"{user_id_str}_certifications",
                "certifications": [c["name"] for c in all_certs],
            }
        ))
        
        # Detailed chunk for each certification
        for idx, cert in enumerate(all_certs):
            lines = [
                f"Certification Entry for {full_name}",
                f"Certification: {cert['name']}"
            ]
            if cert.get("is_uploaded"):
                lines.append("Status: Verified via direct upload")
            else:
                lines.append("Status: Mentioned on CV")
                
            if cert.get("credential_id"):
                lines.append(f"Credential ID: {cert['credential_id']}")
                
            chunks.append((
                "\n".join(lines),
                {
                    **base_meta,
                    "chunk_type": "certification_entry",
                    "chunk_id": f"{user_id_str}_certification_entry_{idx}",
                    "certification_name": cert["name"],
                    "is_uploaded": cert.get("is_uploaded", False),
                    "credential_id": cert.get("credential_id"),
                }
            ))

    if merged_experience:
        summary_lines = [f"{full_name} - Work Experience:"]
        for idx, exp in enumerate(merged_experience):
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

    if merged_education:
        lines = [f"{full_name} - Education:"]
        for idx, edu in enumerate(merged_education):
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

    if merged_projects:
        summary_lines = [f"{full_name} - Projects:"]
        for idx, proj in enumerate(merged_projects):
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
                   ep.professional_summary, ep.folder_path,
                   ms.metadata_json AS snapshot_metadata,
                   ms.is_current AS snapshot_is_current,
                   ms.created_at AS snapshot_created_at
            FROM users u
            JOIN employee_profiles ep ON ep.user_id = u.user_id
            LEFT JOIN LATERAL (
                SELECT metadata_json, is_current, created_at
                FROM metadata_snapshots
                WHERE profile_id = ep.profile_id
                ORDER BY is_current DESC, created_at DESC
                LIMIT 1
            ) ms ON TRUE
            WHERE u.role = 'employee'
        """)
        base_rows = session.execute(query).mappings().all()

        employees = []
        for row in base_rows:
            p_id = row['profile_id']
            skills = session.execute(text("SELECT s.skill_name FROM employee_skills es JOIN skills s ON s.skill_id = es.skill_id WHERE es.profile_id = :p_id"), {"p_id": p_id}).scalars().all()
            
            certs_result = session.execute(text("""
                SELECT certification_name as name, is_uploaded, credential_id 
                FROM certifications 
                WHERE profile_id = :p_id
            """), {"p_id": p_id}).mappings().all()
            
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
                certifications=[dict(r) for r in certs_result],
                experience=[dict(r) for r in exp],
                projects=[dict(r) for r in proj],
                education=[dict(r) for r in edu],
                snapshot_metadata=(dict(row['snapshot_metadata']) if isinstance(row.get('snapshot_metadata'), dict) else None),
                snapshot_is_current=row.get('snapshot_is_current'),
                snapshot_created_at=row.get('snapshot_created_at'),
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
    payload: dict[str, Any] = {}
    payload_source = "none"

    if isinstance(employee.snapshot_metadata, dict) and employee.snapshot_metadata:
        payload = dict(employee.snapshot_metadata)
        payload_source = "db_current" if bool(employee.snapshot_is_current) else "db_latest"

    if not payload and metadata_path:
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            payload["metadata_path"] = str(metadata_path)
            payload_source = "file_metadata"
        except Exception:
            payload = {}

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

    print(
        f"[OK] Re-indexed {uid} ({employee.first_name} {employee.last_name}) "
        f"- {len(chunks)} chunks (payload_source={payload_source})"
    )
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
            payload = employee.snapshot_metadata if isinstance(employee.snapshot_metadata, dict) else {}
            chunks = build_chunks(employee, payload)
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
