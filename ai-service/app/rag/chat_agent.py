"""
LLM-first Bid Manager chat agent using local Postgres pgvector + Ollama.

Design goals:
- Avoid hardcoded intent/question routing.
- Improve reasoning by feeding structured facts derived from retrieved chunks.
- Keep answers grounded in retrieved context only.
"""
from collections import defaultdict
from difflib import SequenceMatcher
import json
import re
import unicodedata
from typing import Dict, Iterable

from langchain_classic.chains.combine_documents import create_stuff_documents_chain
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.documents import Document as LCDocument
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder, PromptTemplate
from langchain_core.runnables import RunnableLambda, RunnableWithMessageHistory
from langchain_ollama import ChatOllama, OllamaEmbeddings

from app.utils.llm import resolve_llm_model, parse_json_object

TOP_K = 12
TOP_K_PER_MATCHED_EMPLOYEE = 20


def _normalize_for_match(value: str) -> str:
    text = unicodedata.normalize("NFKD", value or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower().replace("\u2019", "'").replace("`", "'")
    text = re.sub(r"(?<=[a-z])&(?=[a-z])", "a", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _contains_word(text: str, word: str) -> bool:
    if re.search(rf"\b{re.escape(word)}\b", text):
        return True
    if len(word) >= 4:
        return re.search(rf"\b{re.escape(word)}[a-z0-9]*\b", text) is not None
    return False


def _query_terms(query_norm: str) -> list[str]:
    terms = re.findall(r"[a-z0-9][a-z0-9+._\-]*", query_norm)
    return [token for token in terms if len(token) > 2]


def _needs_reference_resolution(query_norm: str) -> bool:
    reference_terms = {
        "he",
        "she",
        "they",
        "them",
        "his",
        "her",
        "their",
        "theirs",
        "him",
        "hers",
        "other",
        "another",
        "else",
        "same",
        "former",
        "latter",
        "that",
        "this",
    }
    tokens = set(re.findall(r"[a-z0-9]+", query_norm))
    if tokens.intersection(reference_terms):
        return True
    return "the other" in query_norm or "that one" in query_norm or "this one" in query_norm


def _dedupe_keep_order(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        clean = str(value or "").strip()
        if not clean:
            continue
        key = _normalize_for_match(clean)
        if key in seen:
            continue
        seen.add(key)
        output.append(clean)
    return output


def _extract_names_mentioned(query_norm: str, names: Iterable[str]) -> list[str]:
    matched: list[str] = []
    for name in names:
        norm_name = _normalize_for_match(name)
        if not norm_name:
            continue
        if norm_name in query_norm:
            matched.append(name)
            continue
        parts = [part for part in norm_name.split() if len(part) > 2]
        if any(_contains_word(query_norm, part) for part in parts):
            matched.append(name)
    return matched


def _extract_directory_entries(doc: LCDocument) -> list[dict[str, object]]:
    metadata = doc.metadata or {}
    if str(metadata.get("chunk_type") or "").lower() != "directory":
        return []

    entries: list[dict[str, object]] = []
    raw_meta_entries = metadata.get("employees")
    if isinstance(raw_meta_entries, list):
        for item in raw_meta_entries:
            if not isinstance(item, dict):
                continue
            entries.append(
                {
                    "name": str(item.get("name") or "").strip(),
                    "email": str(item.get("email") or "").strip(),
                    "role": str(item.get("role") or "").strip(),
                    "experience_entries": int(item.get("experience_entries") or 0),
                    "project_count": int(item.get("project_count") or 0),
                    "companies": [str(c).strip() for c in (item.get("companies") or []) if str(c).strip()],
                }
            )
        return entries

    # Backward-compatible parse for older directory chunk text format.
    for line in doc.page_content.splitlines():
        stripped = line.strip()
        if not stripped.startswith("-"):
            continue
        payload = stripped[1:].strip()
        if "|" not in payload:
            continue

        parts = [part.strip() for part in payload.split("|") if part.strip()]
        if not parts:
            continue
        name = parts[0]
        parsed: dict[str, object] = {
            "name": name,
            "email": "",
            "role": "",
            "experience_entries": 0,
            "project_count": 0,
            "companies": [],
        }
        for token in parts[1:]:
            if "=" not in token:
                continue
            key, value = token.split("=", 1)
            key = _normalize_for_match(key)
            value = value.strip()
            if key == "email":
                parsed["email"] = value
            elif key == "role":
                parsed["role"] = value
            elif key == "experience_entries":
                parsed["experience_entries"] = int(value or 0)
            elif key == "project_count":
                parsed["project_count"] = int(value or 0)
            elif key == "companies":
                parsed["companies"] = [c.strip() for c in value.split(";") if c.strip()]
        entries.append(parsed)

    return entries


def _extract_experience_entries_from_doc(doc: LCDocument) -> tuple[str, list[dict[str, str]]]:
    metadata = doc.metadata or {}
    chunk_type = str(metadata.get("chunk_type") or "").lower()
    employee_name = str(metadata.get("name") or "").strip()

    if chunk_type == "experience_entry":
        entry = {
            "company": str(metadata.get("company_name") or "").strip(),
            "role": str(metadata.get("job_title") or "").strip(),
            "start_date": str(metadata.get("start_date") or "").strip(),
            "end_date": str(metadata.get("end_date") or "").strip(),
            "description": str(metadata.get("description") or "").strip(),
        }
        return employee_name, [entry]

    if chunk_type != "experience":
        return "", []

    entries: list[dict[str, str]] = []
    for line in doc.page_content.splitlines():
        stripped = line.strip()
        if not stripped.startswith("-"):
            continue
        payload = stripped[1:].strip()
        if ":" not in payload or " at " not in payload:
            continue

        left, right = payload.split(":", 1)
        role = right.strip().rstrip(".")
        company = left.rsplit(" at ", 1)[1].strip() if " at " in left else ""
        entries.append(
            {
                "company": company,
                "role": role,
                "start_date": "",
                "end_date": "",
                "description": "",
            }
        )

    return employee_name, entries


def _extract_project_entries_from_doc(doc: LCDocument) -> tuple[str, list[dict[str, str]]]:
    metadata = doc.metadata or {}
    chunk_type = str(metadata.get("chunk_type") or "").lower()
    employee_name = str(metadata.get("name") or "").strip()

    if chunk_type == "project_entry":
        project = {
            "project_name": str(metadata.get("project_name") or "").strip(),
            "client_name": str(metadata.get("client_name") or "").strip(),
            "project_year": str(metadata.get("project_year") or "").strip(),
            "description": str(metadata.get("project_description") or "").strip(),
        }
        return employee_name, [project]

    if chunk_type != "projects":
        return "", []

    entries: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw_line in doc.page_content.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue

        if stripped.startswith("-"):
            payload = stripped[1:].strip()
            if ":" in payload:
                left, right = payload.split(":", 1)
                left_norm = _normalize_for_match(left)
                name_norm = _normalize_for_match(employee_name)
                if name_norm and left_norm in name_norm:
                    payload = right.strip()

            year = ""
            year_match = re.search(r"\((\d{4})\)\s*$", payload)
            if year_match:
                year = year_match.group(1)
                payload = payload[:year_match.start()].strip().rstrip(".")

            client = ""
            project_name = payload.rstrip(".")
            client_match = re.match(r"(?i)^project for\s+(.+)$", project_name)
            if client_match:
                client = client_match.group(1).strip().rstrip(".")

            current = {
                "project_name": project_name,
                "client_name": client,
                "project_year": year,
                "description": "",
            }
            entries.append(current)
            continue

        if current is not None:
            if current["description"]:
                current["description"] = f"{current['description']} {stripped}"
            else:
                current["description"] = stripped

    return employee_name, entries


def _extract_certifications_from_doc(doc: LCDocument) -> tuple[str, list[str]]:
    metadata = doc.metadata or {}
    chunk_type = str(metadata.get("chunk_type") or "").lower()
    if chunk_type == "certification_entry":
        employee_name = str(metadata.get("name") or "").strip()
        cert_name = str(metadata.get("certification_name") or "").strip()
        return employee_name, [cert_name] if cert_name else []

    if chunk_type != "certifications":
        return "", []

    employee_name = str(metadata.get("name") or "").strip()
    certs: list[str] = []

    raw_meta_certs = metadata.get("certifications")
    if isinstance(raw_meta_certs, list):
        certs.extend(str(item).strip() for item in raw_meta_certs if str(item).strip())

    if not certs:
        for line in doc.page_content.splitlines():
            cleaned = line.strip()
            if not cleaned.startswith("-"):
                continue
            cleaned = cleaned[1:].strip()
            if ":" in cleaned:
                left, right = cleaned.split(":", 1)
                left_norm = _normalize_for_match(left)
                name_norm = _normalize_for_match(employee_name)
                if name_norm and left_norm in name_norm:
                    cleaned = right.strip()
            if cleaned:
                certs.append(cleaned)

    return employee_name, _dedupe_keep_order(certs)


def _extract_education_from_doc(doc: LCDocument) -> tuple[str, list[str]]:
    metadata = doc.metadata or {}
    chunk_type = str(metadata.get("chunk_type") or "").lower()
    if chunk_type == "education_entry":
        employee_name = str(metadata.get("name") or "").strip()
        parts: list[str] = []
        degree = str(metadata.get("degree") or "").strip()
        field = str(metadata.get("field_of_study") or "").strip()
        institution = str(metadata.get("institution") or "").strip()
        end_date = str(metadata.get("end_date") or "").strip()
        if degree:
            parts.append(degree)
        if field:
            parts.append(f"in {field}")
        if institution:
            parts.append(f"from {institution}")
        if end_date:
            parts.append(f"({end_date})")
        merged = " ".join(parts).strip()
        return employee_name, [merged] if merged else []

    if chunk_type != "education":
        return "", []

    employee_name = str(metadata.get("name") or "").strip()
    items: list[str] = []
    for line in doc.page_content.splitlines():
        cleaned = line.strip()
        if not cleaned.startswith("-"):
            continue
        cleaned = cleaned[1:].strip()
        if ":" in cleaned:
            left, right = cleaned.split(":", 1)
            left_norm = _normalize_for_match(left)
            name_norm = _normalize_for_match(employee_name)
            if name_norm and left_norm in name_norm:
                cleaned = right.strip()
        if cleaned:
            items.append(cleaned)

    return employee_name, _dedupe_keep_order(items)


def _build_structured_facts(
    docs: list[LCDocument],
    focus_names: set[str] | None = None,
    query_text: str = "",
) -> str:
    focus_names_norm = {_normalize_for_match(name) for name in (focus_names or set()) if str(name).strip()}

    employees: dict[str, dict[str, object]] = defaultdict(
        lambda: {
            "project_count": None,
            "experience_count": None,
            "companies": set(),
            "projects": {},
            "experience": {},
            "certifications": set(),
            "education": set(),
        }
    )

    total_employees = None

    for doc in docs:
        for row in _extract_directory_entries(doc):
            name = str(row.get("name") or "").strip()
            if not name:
                continue
            if focus_names_norm and _normalize_for_match(name) not in focus_names_norm:
                continue
            bucket = employees[name]
            bucket["project_count"] = int(row.get("project_count") or 0)
            bucket["experience_count"] = int(row.get("experience_entries") or 0)
            for company in row.get("companies") or []:
                if str(company).strip():
                    bucket["companies"].add(str(company).strip())
            md = doc.metadata or {}
            if isinstance(md.get("total_employees"), int):
                total_employees = md["total_employees"]

    for doc in docs:
        name, entries = _extract_experience_entries_from_doc(doc)
        if name:
            if focus_names_norm and _normalize_for_match(name) not in focus_names_norm:
                continue
            bucket = employees[name]
            for entry in entries:
                company = str(entry.get("company") or "").strip()
                role = str(entry.get("role") or "").strip()
                start_date = str(entry.get("start_date") or "").strip()
                end_date = str(entry.get("end_date") or "").strip()
                description = str(entry.get("description") or "").strip()
                if company:
                    bucket["companies"].add(company)
                signature = (company, role, start_date, end_date, description)
                bucket["experience"][signature] = {
                    "company": company,
                    "role": role,
                    "start_date": start_date,
                    "end_date": end_date,
                    "description": description,
                }

        name, entries = _extract_project_entries_from_doc(doc)
        if name:
            if focus_names_norm and _normalize_for_match(name) not in focus_names_norm:
                continue
            bucket = employees[name]
            for entry in entries:
                project_name = str(entry.get("project_name") or "").strip()
                client_name = str(entry.get("client_name") or "").strip()
                project_year = str(entry.get("project_year") or "").strip()
                description = str(entry.get("description") or "").strip()
                signature = (project_name, client_name, project_year, description)
                bucket["projects"][signature] = {
                    "project_name": project_name,
                    "client_name": client_name,
                    "project_year": project_year,
                    "description": description,
                }

        name, certs = _extract_certifications_from_doc(doc)
        if name:
            if focus_names_norm and _normalize_for_match(name) not in focus_names_norm:
                continue
            bucket = employees[name]
            for cert in certs:
                bucket["certifications"].add(cert)

        name, edu_items = _extract_education_from_doc(doc)
        if name:
            if focus_names_norm and _normalize_for_match(name) not in focus_names_norm:
                continue
            bucket = employees[name]
            for edu in edu_items:
                bucket["education"].add(edu)

    if not employees:
        return json.dumps(
            {
                "total_employees": total_employees,
                "employee_count_in_context": 0,
                "employees": [],
                "project_count_ranking": [],
                "query_token_matches": [],
            },
            ensure_ascii=False,
            indent=2,
        )

    project_ranking: list[tuple[str, int]] = []
    employee_rows: list[dict[str, object]] = []
    company_groups: dict[str, dict[str, object]] = {}
    employee_search_blobs: dict[str, str] = {}

    for name in sorted(employees):
        bucket = employees[name]
        projects = list(bucket["projects"].values())
        experience = list(bucket["experience"].values())

        project_count_value = bucket["project_count"]
        if project_count_value is None:
            project_count_value = len(projects)

        experience_count_value = bucket["experience_count"]
        if experience_count_value is None:
            experience_count_value = len(experience)

        companies = sorted(c for c in bucket["companies"] if c)
        certifications = sorted(bucket["certifications"], key=_normalize_for_match)
        education = sorted(bucket["education"], key=_normalize_for_match)
        for company in companies:
            key = _normalize_for_match(company)
            if not key:
                continue
            if key not in company_groups:
                company_groups[key] = {"company": company, "employees": set()}
            company_groups[key]["employees"].add(name)

        project_ranking.append((name, int(project_count_value or 0)))
        employee_rows.append(
            {
                "name": name,
                "project_count": int(project_count_value or 0),
                "experience_count": int(experience_count_value or 0),
                "companies": companies,
                "projects": projects,
                "experience": experience,
                "certifications": certifications,
                "education": education,
            }
        )
        blob_parts: list[str] = []
        blob_parts.extend(companies)
        blob_parts.extend(certifications)
        blob_parts.extend(education)
        for project in projects:
            blob_parts.append(str(project.get("project_name") or ""))
            blob_parts.append(str(project.get("client_name") or ""))
            blob_parts.append(str(project.get("description") or ""))
        for exp in experience:
            blob_parts.append(str(exp.get("company") or ""))
            blob_parts.append(str(exp.get("role") or ""))
            blob_parts.append(str(exp.get("description") or ""))
        employee_search_blobs[name] = _normalize_for_match(" ".join(blob_parts))

    project_ranking.sort(key=lambda item: item[1], reverse=True)

    payload = {
        "total_employees": total_employees,
        "employee_count_in_context": len(employee_rows),
        "employees": employee_rows,
        "company_to_employees": [
            {
                "company": company_groups[key]["company"],
                "employees": sorted(
                    company_groups[key]["employees"],
                    key=_normalize_for_match,
                ),
            }
            for key in sorted(company_groups.keys())
        ],
        "project_count_ranking": [
            {"name": name, "project_count": count} for name, count in project_ranking
        ],
    }
    query_norm = _normalize_for_match(query_text)
    query_tokens = sorted({t for t in _query_terms(query_norm) if len(t) >= 4})
    token_matches: list[dict[str, object]] = []
    total_employee_count = len(employee_rows)
    for token in query_tokens:
        matches = [
            name
            for name, blob in employee_search_blobs.items()
            if blob and _contains_word(blob, token)
        ]
        if 0 < len(matches) < total_employee_count:
            token_matches.append(
                {
                    "token": token,
                    "employees": sorted(matches, key=_normalize_for_match),
                }
            )
    payload["query_token_matches"] = token_matches
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _render_grounded_project_answer(grounded_selection: dict[str, object]) -> str | None:
    raw_projects = grounded_selection.get("focus_projects")
    if not isinstance(raw_projects, list) or not raw_projects:
        return None

    mode = str(grounded_selection.get("selection_mode") or "").strip().lower()
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    seen: set[tuple[str, str, str, str, str]] = set()

    for item in raw_projects:
        if not isinstance(item, dict):
            continue
        employee_name = str(item.get("employee_name") or "").strip()
        project_name = str(item.get("project_name") or "").strip()
        client_name = str(item.get("client_name") or "").strip()
        project_year = str(item.get("project_year") or "").strip()
        description = str(item.get("description") or "").strip()
        if not employee_name:
            continue

        signature = (
            _normalize_for_match(employee_name),
            _normalize_for_match(project_name),
            _normalize_for_match(client_name),
            _normalize_for_match(project_year),
            _normalize_for_match(description),
        )
        if signature in seen:
            continue
        seen.add(signature)

        grouped[employee_name].append(
            {
                "project_name": project_name,
                "client_name": client_name,
                "project_year": project_year,
                "description": description,
            }
        )

    if not grouped:
        return None

    def _format_project_line(project: dict[str, str]) -> str:
        project_name = project["project_name"] or "Unnamed project"
        details: list[str] = []
        if project["client_name"]:
            details.append(f"Client: {project['client_name']}")
        if project["project_year"]:
            details.append(f"Year: {project['project_year']}")
        if project["description"]:
            details.append(f"Description: {project['description']}")
        if details:
            return f"- {project_name} ({'; '.join(details)})"
        return f"- {project_name}"

    if len(grouped) == 1:
        employee_name = next(iter(grouped.keys()))
        projects = grouped[employee_name]
        header = (
            f"{employee_name} has {len(projects)} project(s):"
            if mode == "all_for_employee"
            else f"{employee_name} has {len(projects)} matching project(s):"
        )
        lines = [header]
        lines.extend(_format_project_line(project) for project in projects)
        return "\n".join(lines)

    lines = ["Matching projects were found for these employees:"]
    for employee_name in sorted(grouped.keys(), key=_normalize_for_match):
        lines.append(f"{employee_name}:")
        for project in grouped[employee_name]:
            lines.append(_format_project_line(project))
    return "\n".join(lines)


def _render_grounded_cert_answer(grounded_selection: dict[str, object]) -> str | None:
    raw_rows = grounded_selection.get("focus_certifications")
    if not isinstance(raw_rows, list) or not raw_rows:
        return None

    grouped: dict[str, list[str]] = defaultdict(list)
    seen: set[tuple[str, str]] = set()
    for item in raw_rows:
        if not isinstance(item, dict):
            continue
        employee_name = str(item.get("employee_name") or "").strip()
        cert_name = str(item.get("certification_name") or "").strip()
        if not employee_name or not cert_name:
            continue
        signature = (_normalize_for_match(employee_name), _normalize_for_match(cert_name))
        if signature in seen:
            continue
        seen.add(signature)
        grouped[employee_name].append(cert_name)

    if not grouped:
        return None

    if len(grouped) == 1:
        employee_name = next(iter(grouped.keys()))
        certs = grouped[employee_name]
        lines = [f"{employee_name} has {len(certs)} matching certification(s):"]
        lines.extend(f"- {cert}" for cert in certs)
        return "\n".join(lines)

    lines = ["Employees with matching certifications:"]
    for employee_name in sorted(grouped.keys(), key=_normalize_for_match):
        certs = grouped[employee_name]
        lines.append(f"- {employee_name}: " + "; ".join(certs))
    return "\n".join(lines)


def build_chain():
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.rag.db import engine
    from app.rag.models import EmployeeRagVector, init_rag_schema
    from langchain_core.callbacks import CallbackManagerForRetrieverRun
    from langchain_core.retrievers import BaseRetriever

    init_rag_schema()

    embedder = OllamaEmbeddings(
        model=settings.EMBEDDING_MODEL,
        base_url=settings.OLLAMA_URL,
    )

    known_names: list[str] = []
    with Session(engine) as session:
        profile_rows = session.execute(
            select(EmployeeRagVector.metadata_json)
        ).all()
        for row in profile_rows:
            meta = row[0] or {}
            if str(meta.get("chunk_type") or "").lower() != "profile":
                continue
            name = str(meta.get("name") or "").strip()
            if name:
                known_names.append(name)
    known_names = sorted(_dedupe_keep_order(known_names))

    class PostgresRetriever(BaseRetriever):
        def _get_relevant_documents(
            self, query: str, *, run_manager: CallbackManagerForRetrieverRun
        ) -> list[LCDocument]:
            query_norm = _normalize_for_match(query)
            query_tokens = _query_terms(query_norm)
            seen_ids: set[int] = set()
            docs: list[LCDocument] = []

            with Session(engine) as session:
                all_rows = session.execute(
                    select(
                        EmployeeRagVector.id,
                        EmployeeRagVector.user_id,
                        EmployeeRagVector.content,
                        EmployeeRagVector.metadata_json,
                    )
                ).all()

                uid_to_rows: dict = defaultdict(list)
                profile_by_uid: dict = {}
                identity_by_uid: dict = {}
                directory_rows: list = []
                row_records: list[tuple[object, str, str]] = []

                for row in all_rows:
                    meta = row.metadata_json or {}
                    chunk_type = str(meta.get("chunk_type") or "").lower()
                    uid_to_rows[row.user_id].append(row)
                    row_records.append((row, _normalize_for_match(row.content), chunk_type))
                    if chunk_type == "profile":
                        profile_by_uid[row.user_id] = row
                        identity_by_uid[row.user_id] = (
                            str(meta.get("name") or "").strip(),
                            str(meta.get("email") or "").strip() or "unknown",
                        )
                    elif chunk_type == "directory":
                        directory_rows.append(row)

                def add_doc(row_obj) -> None:
                    if row_obj.id in seen_ids:
                        return
                    seen_ids.add(row_obj.id)
                    metadata = dict(row_obj.metadata_json or {})
                    metadata.setdefault("chunk_type", "unknown")
                    metadata.setdefault("name", "")
                    metadata.setdefault("chunk_id", "")
                    docs.append(
                        LCDocument(
                            page_content=row_obj.content,
                            metadata=metadata,
                        )
                    )

                # Name matching.
                matched_uids: set = set()
                ambiguous_groups: list[list[tuple[str, str]]] = []

                for uid, (full_name, _email) in identity_by_uid.items():
                    norm_name = _normalize_for_match(full_name)
                    if not norm_name:
                        continue
                    if norm_name in query_norm:
                        matched_uids.add(uid)

                word_to_matches: dict[str, list[tuple[object, str, str]]] = defaultdict(list)
                for uid, (full_name, email) in identity_by_uid.items():
                    for part in _normalize_for_match(full_name).split():
                        if len(part) > 2:
                            word_to_matches[part].append((uid, full_name, email))

                for token, matches in word_to_matches.items():
                    if not _contains_word(query_norm, token):
                        continue
                    unique = {uid: (uid, name, email) for uid, name, email in matches}
                    if len(unique) == 1:
                        matched_uids.add(next(iter(unique)))
                    elif len(unique) > 1:
                        ambiguous_groups.append(list(unique.values()))

                if not matched_uids and query_tokens:
                    fuzzy_scores: dict = {}
                    for uid, (full_name, _email) in identity_by_uid.items():
                        name_tokens = [part for part in _normalize_for_match(full_name).split() if len(part) > 2]
                        if not name_tokens:
                            continue
                        best_ratio = 0.0
                        for token in query_tokens:
                            if len(token) < 4:
                                continue
                            token_best = max(SequenceMatcher(None, token, part).ratio() for part in name_tokens)
                            best_ratio = max(best_ratio, token_best)
                        if best_ratio >= 0.84:
                            fuzzy_scores[uid] = best_ratio

                    if fuzzy_scores:
                        top_score = max(fuzzy_scores.values())
                        top_uids = [uid for uid, score in fuzzy_scores.items() if score >= top_score - 0.02]
                        if len(top_uids) == 1:
                            matched_uids.add(top_uids[0])
                        elif len(top_uids) > 1:
                            group = []
                            for uid in top_uids:
                                name, email = identity_by_uid.get(uid, ("", "unknown"))
                                group.append((uid, name, email))
                            ambiguous_groups.append(group)

                if ambiguous_groups:
                    for group in ambiguous_groups:
                        names_list = "\n".join(
                            f"  - {full_name} (email: {email})" for _, full_name, email in group
                        )
                        notice = (
                            "[DISAMBIGUATION REQUIRED] Multiple employees share a similar name. "
                            "Ask the user to clarify which person they mean by full name or email.\n"
                            f"The matching employees are:\n{names_list}"
                        )
                        docs.append(
                            LCDocument(
                                page_content=notice,
                                metadata={"chunk_type": "disambiguation_notice"},
                            )
                        )

                emb = embedder.embed_query(query)
                if matched_uids:
                    summary_chunk_types = {
                        "projects",
                        "experience",
                        "education",
                        "certifications",
                        "skills",
                    }
                    for uid in matched_uids:
                        rows_for_uid = uid_to_rows.get(uid, [])
                        matched_name, _ = identity_by_uid.get(uid, ("", ""))
                        name_tokens = {
                            part for part in _normalize_for_match(matched_name).split() if len(part) > 2
                        }
                        candidate_tokens = [
                            token for token in query_tokens if len(token) >= 4 and token not in name_tokens
                        ]
                        focused_tokens: list[str] = []
                        if rows_for_uid and candidate_tokens:
                            total_rows = len(rows_for_uid)
                            for token in candidate_tokens:
                                hit_count = 0
                                for row in rows_for_uid:
                                    if _contains_word(_normalize_for_match(row.content), token):
                                        hit_count += 1
                                frequency = hit_count / total_rows if total_rows else 0.0
                                if 0 < frequency <= 0.25:
                                    focused_tokens.append(token)

                        profile_row = profile_by_uid.get(uid)
                        if profile_row is not None:
                            add_doc(profile_row)

                        # Always include summary chunks for scoped employee queries so
                        # list/aggregation questions can use full employee-level context.
                        for row in rows_for_uid:
                            chunk_type = str((row.metadata_json or {}).get("chunk_type") or "").lower()
                            if chunk_type in summary_chunk_types:
                                add_doc(row)

                        if focused_tokens:
                            focused_entry_types = {"project_entry", "experience_entry", "education_entry", "certification_entry"}
                            focused_rows: list[object] = []
                            for row in rows_for_uid:
                                row_norm = _normalize_for_match(row.content)
                                if any(_contains_word(row_norm, token) for token in focused_tokens):
                                    focused_rows.append(row)

                            focused_rows.sort(
                                key=lambda item: (
                                    0
                                    if str((item.metadata_json or {}).get("chunk_type") or "").lower()
                                    in focused_entry_types
                                    else 1
                                )
                            )
                            for row in focused_rows[:14]:
                                add_doc(row)

                        scoped_stmt = (
                            select(EmployeeRagVector)
                            .where(EmployeeRagVector.user_id == uid)
                            .order_by(EmployeeRagVector.embedding.cosine_distance(emb))
                            .limit(TOP_K_PER_MATCHED_EMPLOYEE)
                        )
                        focused_allowed_types = {
                            "profile",
                            "project_entry",
                            "experience_entry",
                            "education_entry",
                            "certification_entry",
                        }
                        for row in session.execute(scoped_stmt).scalars().all():
                            if focused_tokens:
                                chunk_type = str((row.metadata_json or {}).get("chunk_type") or "").lower()
                                if chunk_type not in focused_allowed_types:
                                    continue
                            add_doc(row)

                    for row in directory_rows:
                        add_doc(row)
                    if docs:
                        return docs

                # Lexical recall layer to improve entity coverage (e.g., cert/product/client names)
                # when embedding-only retrieval misses sparse but exact keyword matches.
                token_candidates = sorted({t for t in query_tokens if len(t) >= 4})
                token_hits: dict[str, list[tuple[object, str, str]]] = {}
                total_rows = len(row_records) or 1
                rare_limit = max(8, int(total_rows * 0.15))
                for token in token_candidates:
                    hits = [record for record in row_records if _contains_word(record[1], token)]
                    hit_count = len(hits)
                    if 0 < hit_count <= rare_limit:
                        token_hits[token] = hits

                if token_hits:
                    chunk_priority = {
                        "project_entry": 0,
                        "experience_entry": 0,
                        "education_entry": 0,
                        "certification_entry": 0,
                        "projects": 1,
                        "experience": 1,
                        "education": 1,
                        "certifications": 1,
                        "profile": 2,
                    }
                    scored_rows: dict[int, tuple[object, float, str]] = {}
                    for token, hits in token_hits.items():
                        boost = 1.0 / len(hits)
                        for row_obj, _row_norm, chunk_type in hits:
                            current = scored_rows.get(row_obj.id)
                            if current is None:
                                scored_rows[row_obj.id] = (row_obj, boost, chunk_type)
                            else:
                                scored_rows[row_obj.id] = (
                                    row_obj,
                                    float(current[1]) + boost,
                                    chunk_type,
                                )

                    ranked = sorted(
                        scored_rows.values(),
                        key=lambda item: (
                            -float(item[1]),
                            chunk_priority.get(item[2], 3),
                            str(item[2]),
                        ),
                    )

                    for row_obj, _score, _chunk_type in ranked[:18]:
                        add_doc(row_obj)
                    for row_obj, _score, _chunk_type in ranked[:18]:
                        profile_row = profile_by_uid.get(row_obj.user_id)
                        if profile_row is not None:
                            add_doc(profile_row)

                stmt = (
                    select(EmployeeRagVector)
                    .order_by(EmployeeRagVector.embedding.cosine_distance(emb))
                    .limit(TOP_K)
                )
                for row in session.execute(stmt).scalars().all():
                    add_doc(row)

                for row in directory_rows:
                    add_doc(row)

            return docs

    retriever = PostgresRetriever()

    model_name = _resolve_llm_model()
    print(f"[chat_agent] Using LLM: {model_name}")

    llm = ChatOllama(
        model=model_name,
        base_url=settings.OLLAMA_URL,
        temperature=0.0,
        disable_streaming=True,
        num_ctx=8192,
    )

    query_rewrite_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """Rewrite the last user message as a standalone question.
Resolve pronouns from chat history and replace them with exact employee names when clear.
Preserve constraints (else, besides, counts, comparisons) and obvious typo normalization.
Return only the rewritten question.""",
            ),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ]
    )

    def _rewrite_query(user_input: str, chat_history: list) -> str:
        try:
            messages = query_rewrite_prompt.format_messages(
                input=user_input,
                chat_history=chat_history or [],
            )
            rewritten = llm.invoke(messages)
            candidate = str(getattr(rewritten, "content", "") or "").strip()
            return candidate or user_input
        except Exception:
            return user_input

    intent_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """Classify intent and return ONLY one token:
PROJECT_DIRECT = asks who has/did a project for specific client/project.
PROJECT_ALL = asks for full project list of one employee.
CERT_DIRECT = asks who has/if someone has specific certification/vendor cert.
GENERAL = anything else.
Examples:
- who did a project for kiabi -> PROJECT_DIRECT
- give me all projects for anouar -> PROJECT_ALL
- who has a barracuda cert -> CERT_DIRECT
- who has most experience in security -> GENERAL""",
            ),
            (
                "human",
                "StandaloneQuery:\n{standalone_query}",
            ),
        ]
    )

    domain_experience_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """Does this query ask for ranking/comparing experience in a domain
(most/least/best/worst, e.g., security experience)?
Return ONLY YES or NO.
Examples:
- who has most experience in security -> YES
- who has the least exprience in security -> YES
- who has a barracuda cert -> NO""",
            ),
            (
                "human",
                "StandaloneQuery:\n{standalone_query}",
            ),
        ]
    )

    grounding_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """Pick project ids from ProjectCatalog that semantically match the query.
Return strict JSON only:
{"resolved_query":"...","selection_mode":"none|direct_match|all_for_employee|mixed","selected_project_ids":["P1","P2"]}
Rules:
- Use only ids from catalog.
- Keep entity matching strict (do not broaden "BH Bank" to other banks).
- For non-project questions use mode=none and empty ids.
- For direct match questions ("who had a project for X"), pick only exact X matches.
Examples:
Query: who had a project for bh bank?
Catalog: P1 client=BH Bank, P2 client=NAIB Bank
Output: {"resolved_query":"who had a project for bh bank?","selection_mode":"direct_match","selected_project_ids":["P1"]}""",
            ),
            (
                "human",
                "StandaloneQuery:\n{standalone_query}\n\nProjectCatalog:\n{project_catalog}",
            ),
        ]
    )

    cert_grounding_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """Pick certification ids from CertCatalog that semantically match the query.
Return strict JSON only:
{"resolved_query":"...","selection_mode":"none|direct_match|mixed","selected_cert_ids":["C1","C2"]}
Rules:
- Use only ids from catalog.
- Keep entity matching strict (avoid broad vendor/category drift).
- If not a certification match question, use mode=none and empty ids.""",
            ),
            (
                "human",
                "StandaloneQuery:\n{standalone_query}\n\nCertCatalog:\n{cert_catalog}",
            ),
        ]
    )

    direct_match_validation_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """Decide if one project record is a direct match for the query.
Reply with ONLY YES or NO.
YES only when query target entity and project/client refer to the same entity (allow minor typos).
NO for related but different entities (example: BH Bank vs NAIB Bank).""",
            ),
            (
                "human",
                "Query:\n{query}\n\nProjectRecord:\nemployee={employee_name}\nproject={project_name}\nclient={client_name}\nyear={project_year}\ndescription={description}",
            ),
        ]
    )

    project_list_intent_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """Does the query ask for the full project list of one employee?
Return exactly one line:
NONE
or
ALL_PROJECTS|<exact employee name from EmployeeNames>""",
            ),
            (
                "human",
                "StandaloneQuery:\n{standalone_query}\n\nRecentChatHistory:\n{chat_history}\n\nEmployeeNames:\n{employee_names}",
            ),
        ]
    )

    def _recent_history_blob(chat_history: list) -> str:
        lines: list[str] = []
        for msg in chat_history[-8:]:
            role = str(getattr(msg, "type", "message"))
            content = str(getattr(msg, "content", "") or "").strip()
            if content:
                lines.append(f"{role}: {content}")
        return "\n".join(lines) if lines else "(none)"

    def _infer_query_intent(standalone_query: str) -> str:
        try:
            messages = intent_prompt.format_messages(
                standalone_query=standalone_query,
            )
            raw = llm.invoke(messages)
            token = str(getattr(raw, "content", "") or "").strip().upper()
            if "PROJECT_DIRECT" in token:
                return "PROJECT_DIRECT"
            if "PROJECT_ALL" in token:
                return "PROJECT_ALL"
            if "CERT_DIRECT" in token:
                return "CERT_DIRECT"
            return "GENERAL"
        except Exception:
            return "GENERAL"

    def _is_domain_experience_ranking_query(standalone_query: str) -> bool:
        try:
            messages = domain_experience_prompt.format_messages(
                standalone_query=standalone_query,
            )
            raw = llm.invoke(messages)
            token = str(getattr(raw, "content", "") or "").strip().upper()
            return token.startswith("YES")
        except Exception:
            return False

    def _is_direct_project_match(query: str, project: dict[str, str]) -> bool:
        try:
            messages = direct_match_validation_prompt.format_messages(
                query=query,
                employee_name=project.get("employee_name", ""),
                project_name=project.get("project_name", ""),
                client_name=project.get("client_name", ""),
                project_year=project.get("project_year", ""),
                description=project.get("description", ""),
            )
            verdict = llm.invoke(messages)
            verdict_text = str(getattr(verdict, "content", "") or "").strip().upper()
            return verdict_text.startswith("YES")
        except Exception:
            return False

    def _infer_all_projects_employee(standalone_query: str, structured_facts: str, chat_history: list) -> str:
        facts_obj = _parse_json_object(structured_facts) or {}
        employee_rows = facts_obj.get("employees")
        if not isinstance(employee_rows, list):
            return ""

        employee_names: list[str] = []
        for row in employee_rows:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name") or "").strip()
            if name:
                employee_names.append(name)
        employee_names = _dedupe_keep_order(employee_names)
        if not employee_names:
            return ""

        history_blob = _recent_history_blob(chat_history)

        try:
            messages = project_list_intent_prompt.format_messages(
                standalone_query=standalone_query,
                chat_history=history_blob,
                employee_names="\n".join(f"- {name}" for name in employee_names),
            )
            decision = llm.invoke(messages)
            decision_text = str(getattr(decision, "content", "") or "").strip()
            normalized = decision_text.replace("\r", "").replace("\n", " ").strip()
            if not normalized.upper().startswith("ALL_PROJECTS|"):
                return ""
            employee_name_raw = normalized.split("|", 1)[1].strip()
            if not employee_name_raw:
                return ""
            for name in employee_names:
                if _normalize_for_match(name) == _normalize_for_match(employee_name_raw):
                    return name
            return ""
        except Exception:
            return ""

    def _ground_query_to_facts(standalone_query: str, docs: list[LCDocument]) -> dict[str, object]:
        fallback: dict[str, object] = {
            "resolved_query": standalone_query,
            "selection_mode": "none",
            "focus_employees": [],
            "focus_projects": [],
        }
        candidates: list[dict[str, str]] = []
        next_id = 1
        for doc in docs:
            employee_name, projects = _extract_project_entries_from_doc(doc)
            if not employee_name or not projects:
                continue
            for project in projects:
                if not isinstance(project, dict):
                    continue
                project_name = str(project.get("project_name") or "").strip()
                client_name = str(project.get("client_name") or "").strip()
                project_year = str(project.get("project_year") or "").strip()
                description = str(project.get("description") or "").strip()
                if not project_name and not client_name and not description:
                    continue
                candidates.append(
                    {
                        "id": f"P{next_id}",
                        "employee_name": employee_name,
                        "project_name": project_name,
                        "client_name": client_name,
                        "project_year": project_year,
                        "description": description,
                    }
                )
                next_id += 1
        if not candidates:
            return fallback

        # Keep the selector focused using retrieval-ordered candidates only.
        top_candidates = candidates[:20] if len(candidates) > 20 else candidates

        catalog_lines: list[str] = []
        for item in top_candidates:
            desc = item["description"]
            if len(desc) > 140:
                desc = f"{desc[:140]}..."
            catalog_lines.append(
                " | ".join(
                    [
                        item["id"],
                        f"employee={item['employee_name']}",
                        f"project={item['project_name']}",
                        f"client={item['client_name']}",
                        f"year={item['project_year']}",
                        f"description={desc}",
                    ]
                )
            )
        project_catalog = "\n".join(catalog_lines)
        id_to_candidate = {item["id"]: item for item in top_candidates}

        try:
            messages = grounding_prompt.format_messages(
                standalone_query=standalone_query,
                project_catalog=project_catalog,
            )
            grounded = llm.invoke(messages)
            grounded_text = str(getattr(grounded, "content", "") or "").strip()
            grounded_obj = parse_json_object(grounded_text)
            if not grounded_obj:
                return fallback

            resolved_query = str(grounded_obj.get("resolved_query") or standalone_query).strip() or standalone_query
            selection_mode = str(grounded_obj.get("selection_mode") or "none").strip().lower()
            if selection_mode not in {"none", "direct_match", "all_for_employee", "mixed"}:
                selection_mode = "none"
            selected_ids_raw = grounded_obj.get("selected_project_ids")
            selected_ids: list[str] = []
            if isinstance(selected_ids_raw, list):
                for item in selected_ids_raw:
                    candidate_id = str(item or "").strip().upper()
                    if candidate_id.startswith("P") and candidate_id in id_to_candidate:
                        selected_ids.append(candidate_id)
            selected_ids = _dedupe_keep_order(selected_ids)

            sanitized_projects: list[dict[str, str]] = []
            for candidate_id in selected_ids:
                candidate = id_to_candidate.get(candidate_id)
                if not candidate:
                    continue
                sanitized_projects.append(
                    {
                        "employee_name": candidate["employee_name"],
                        "project_name": candidate["project_name"],
                        "client_name": candidate["client_name"],
                        "project_year": candidate["project_year"],
                        "description": candidate["description"],
                    }
                )
            if selection_mode == "direct_match" and sanitized_projects:
                sanitized_projects = [
                    project
                    for project in sanitized_projects
                    if _is_direct_project_match(resolved_query, project)
                ]
            focus_employees = _dedupe_keep_order(
                [item["employee_name"] for item in sanitized_projects if item.get("employee_name")]
            )
            if sanitized_projects and selection_mode == "none":
                selection_mode = "mixed"

            return {
                "resolved_query": resolved_query,
                "selection_mode": selection_mode,
                "focus_employees": focus_employees,
                "focus_projects": sanitized_projects,
            }
        except Exception:
            return fallback

    def _ground_cert_query_to_facts(standalone_query: str, docs: list[LCDocument]) -> dict[str, object]:
        fallback: dict[str, object] = {
            "resolved_query": standalone_query,
            "selection_mode": "none",
            "focus_employees": [],
            "focus_certifications": [],
        }

        candidates: list[dict[str, str]] = []
        next_id = 1
        seen: set[tuple[str, str]] = set()
        for doc in docs:
            employee_name, certs = _extract_certifications_from_doc(doc)
            if not employee_name or not certs:
                continue
            for cert_name in certs:
                cert_clean = str(cert_name or "").strip()
                if not cert_clean:
                    continue
                signature = (_normalize_for_match(employee_name), _normalize_for_match(cert_clean))
                if signature in seen:
                    continue
                seen.add(signature)
                candidates.append(
                    {
                        "id": f"C{next_id}",
                        "employee_name": employee_name,
                        "certification_name": cert_clean,
                    }
                )
                next_id += 1
        if not candidates:
            return fallback

        top_candidates = candidates[:24] if len(candidates) > 24 else candidates
        catalog_lines = [
            f"{item['id']} | employee={item['employee_name']} | cert={item['certification_name']}"
            for item in top_candidates
        ]
        cert_catalog = "\n".join(catalog_lines)
        id_to_candidate = {item["id"]: item for item in top_candidates}

        try:
            messages = cert_grounding_prompt.format_messages(
                standalone_query=standalone_query,
                cert_catalog=cert_catalog,
            )
            grounded = llm.invoke(messages)
            grounded_text = str(getattr(grounded, "content", "") or "").strip()
            grounded_obj = parse_json_object(grounded_text)
            if not grounded_obj:
                return fallback

            resolved_query = str(grounded_obj.get("resolved_query") or standalone_query).strip() or standalone_query
            selection_mode = str(grounded_obj.get("selection_mode") or "none").strip().lower()
            if selection_mode not in {"none", "direct_match", "mixed"}:
                selection_mode = "none"

            selected_ids_raw = grounded_obj.get("selected_cert_ids")
            selected_ids: list[str] = []
            if isinstance(selected_ids_raw, list):
                for item in selected_ids_raw:
                    candidate_id = str(item or "").strip().upper()
                    if candidate_id.startswith("C") and candidate_id in id_to_candidate:
                        selected_ids.append(candidate_id)
            selected_ids = _dedupe_keep_order(selected_ids)

            selected_rows: list[dict[str, str]] = []
            for candidate_id in selected_ids:
                candidate = id_to_candidate.get(candidate_id)
                if not candidate:
                    continue
                selected_rows.append(
                    {
                        "employee_name": candidate["employee_name"],
                        "certification_name": candidate["certification_name"],
                    }
                )

            focus_employees = _dedupe_keep_order(
                [item["employee_name"] for item in selected_rows if item.get("employee_name")]
            )
            if selected_rows and selection_mode == "none":
                selection_mode = "mixed"

            return {
                "resolved_query": resolved_query,
                "selection_mode": selection_mode,
                "focus_employees": focus_employees,
                "focus_certifications": selected_rows,
            }
        except Exception:
            return fallback

    qa_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """You are a Bid Manager assistant.
Use only StructuredFacts, GroundedSelection, and Context.
Rules:
1) No invention. If missing, reply exactly: "I don't have that information."
2) Keep employee-project attribution exact.
3) Prefer GroundedSelection for noisy/semantic matching.
4) If GroundedSelection.focus_projects has rows, answer from those rows.
5) If user asks for one employee's projects, list explicit project rows (not only a count).
6) If Context has [DISAMBIGUATION REQUIRED], ask for clarification.
7) Keep answer concise and factual.
8) For most/least experience in a domain (example: security), if domain-specific experience is not explicit, reply exactly: "I don't have that information."
9) For degree questions, use StructuredFacts.employees[].education only; do not infer missing education.

StandaloneQuery:
{standalone_query}

StructuredFacts:
{structured_facts}

GroundedSelection:
{grounded_selection}

Context:
{context}""",
            ),
            ("human", "{input}"),
        ]
    )
    document_prompt = PromptTemplate.from_template(
        "[chunk_type={chunk_type} | employee={name} | chunk_id={chunk_id}]\n{page_content}"
    )
    qa_chain = create_stuff_documents_chain(
        llm=llm,
        prompt=qa_prompt,
        document_prompt=document_prompt,
        document_separator="\n\n---\n\n",
    )

    def _invoke(inputs: dict) -> dict:
        user_input = str(inputs.get("input") or "").strip()
        chat_history = inputs.get("chat_history", []) or []

        user_input_norm = _normalize_for_match(user_input)
        explicit_names = _extract_names_mentioned(user_input_norm, known_names)
        should_rewrite = _needs_reference_resolution(user_input_norm)
        if explicit_names or not should_rewrite:
            standalone_query = user_input
        else:
            standalone_query = _rewrite_query(user_input, chat_history)
        if _is_domain_experience_ranking_query(standalone_query):
            return {
                "answer": "I don't have that information.",
                "context": [],
            }
        query_intent = _infer_query_intent(standalone_query)
        docs = retriever.invoke(standalone_query)
        structured_facts = _build_structured_facts(docs, query_text=standalone_query)
        grounded_selection_obj: dict[str, object] = {
            "resolved_query": standalone_query,
            "selection_mode": "none",
            "focus_employees": [],
            "focus_projects": [],
        }

        if query_intent in {"PROJECT_DIRECT", "PROJECT_ALL"}:
            grounded_selection_obj = _ground_query_to_facts(standalone_query, docs)
            resolved_query = str(grounded_selection_obj.get("resolved_query") or "").strip()
            if resolved_query and _normalize_for_match(resolved_query) != _normalize_for_match(standalone_query):
                standalone_query = resolved_query
                docs = retriever.invoke(standalone_query)
                structured_facts = _build_structured_facts(docs, query_text=standalone_query)
                grounded_selection_obj = _ground_query_to_facts(standalone_query, docs)

            if (
                query_intent == "PROJECT_ALL"
                and not grounded_selection_obj.get("focus_projects")
                and str(grounded_selection_obj.get("selection_mode") or "").strip().lower() == "none"
            ):
                employee_for_all_projects = _infer_all_projects_employee(standalone_query, structured_facts, chat_history)
                if employee_for_all_projects:
                    grounded_selection_obj = {
                        "resolved_query": standalone_query,
                        "selection_mode": "all_for_employee",
                        "focus_employees": [employee_for_all_projects],
                        "focus_projects": [],
                    }
            if str(grounded_selection_obj.get("selection_mode") or "").strip().lower() == "all_for_employee":
                facts_obj = _parse_json_object(structured_facts) or {}
                employee_rows = facts_obj.get("employees")
                focus_names_raw = grounded_selection_obj.get("focus_employees") or []
                focus_names = {
                    _normalize_for_match(str(name))
                    for name in focus_names_raw
                    if str(name or "").strip()
                }
                expanded_projects: list[dict[str, str]] = []
                if isinstance(employee_rows, list) and focus_names:
                    for row in employee_rows:
                        if not isinstance(row, dict):
                            continue
                        employee_name = str(row.get("name") or "").strip()
                        if not employee_name or _normalize_for_match(employee_name) not in focus_names:
                            continue
                        projects = row.get("projects")
                        if not isinstance(projects, list):
                            continue
                        for project in projects:
                            if not isinstance(project, dict):
                                continue
                            expanded_projects.append(
                                {
                                    "employee_name": employee_name,
                                    "project_name": str(project.get("project_name") or "").strip(),
                                    "client_name": str(project.get("client_name") or "").strip(),
                                    "project_year": str(project.get("project_year") or "").strip(),
                                    "description": str(project.get("description") or "").strip(),
                                }
                            )
                if expanded_projects:
                    grounded_selection_obj["focus_projects"] = expanded_projects

            grounded_project_answer = _render_grounded_project_answer(grounded_selection_obj)
            if grounded_project_answer:
                return {
                    "answer": grounded_project_answer,
                    "context": docs,
                }

        elif query_intent == "CERT_DIRECT":
            cert_selection_obj = _ground_cert_query_to_facts(standalone_query, docs)
            resolved_query = str(cert_selection_obj.get("resolved_query") or "").strip()
            if resolved_query and _normalize_for_match(resolved_query) != _normalize_for_match(standalone_query):
                standalone_query = resolved_query
                docs = retriever.invoke(standalone_query)
                structured_facts = _build_structured_facts(docs, query_text=standalone_query)
                cert_selection_obj = _ground_cert_query_to_facts(standalone_query, docs)
            grounded_cert_answer = _render_grounded_cert_answer(cert_selection_obj)
            if grounded_cert_answer:
                return {
                    "answer": grounded_cert_answer,
                    "context": docs,
                }
            grounded_selection_obj = cert_selection_obj

        grounded_selection = json.dumps(grounded_selection_obj, ensure_ascii=False, indent=2)
        answer = qa_chain.invoke(
            {
                "input": user_input,
                "standalone_query": standalone_query,
                "context": docs,
                "structured_facts": structured_facts,
                "grounded_selection": grounded_selection,
            }
        )
        return {
            "answer": answer,
            "context": docs,
        }

    chain = RunnableLambda(_invoke)

    store: Dict[str, InMemoryChatMessageHistory] = defaultdict(InMemoryChatMessageHistory)
    conversational_chain = RunnableWithMessageHistory(
        chain,
        lambda session_id: store[session_id],
        input_messages_key="input",
        history_messages_key="chat_history",
        output_messages_key="answer",
    )
    return conversational_chain


def chat_loop():
    chain = build_chain()
    session_id = "cli"
    print("Bid Manager ready. Type 'exit' to quit.\n")

    while True:
        try:
            user_input = input("You: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nBye.")
            break

        if not user_input:
            continue
        if user_input.lower() in {"exit", "quit", "q"}:
            print("Bye.")
            break

        import time

        t0 = time.time()
        print("...retrieving + generating (please wait)", flush=True)
        result = chain.invoke(
            {"input": user_input},
            config={"configurable": {"session_id": session_id}},
        )
        dt = time.time() - t0
        answer = result.get("answer", "")
        print(f"Bid Manager: {answer}\n(took {dt:.1f}s)\n")


if __name__ == "__main__":
    chat_loop()
