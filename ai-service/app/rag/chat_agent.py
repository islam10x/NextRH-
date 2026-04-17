"""
LLM-first Bid Manager chat agent using local Postgres pgvector + configurable chat LLM provider.

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
from langchain_ollama import OllamaEmbeddings

from app.config import settings
from app.utils.llm import build_rag_chat_llm, parse_json_object

TOP_K = 8
TOP_K_PER_MATCHED_EMPLOYEE = 12
NO_INFO_REPLY = "I don't have that information."


def _normalize_for_match(value: str) -> str:
    text = unicodedata.normalize("NFKD", value or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower().replace("\u2019", "'").replace("`", "'")
    text = re.sub(r"(?<=[a-z])&(?=[a-z])", "a", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _as_int_or_none(value: object) -> int | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(float(text))
    except Exception:
        return None


def _token_variants(token: str) -> list[str]:
    base = _normalize_for_match(token)
    if not base:
        return []

    variants: list[str] = [base]

    # Basic morphology handling to improve recall (bank <-> banks, category <-> categories, etc.).
    if len(base) > 4 and base.endswith("ies"):
        variants.append(base[:-3] + "y")
    if len(base) > 3 and base.endswith("es"):
        variants.append(base[:-2])
    if len(base) > 3 and base.endswith("s"):
        variants.append(base[:-1])
    elif len(base) > 3:
        variants.append(base + "s")

    if len(base) > 5 and base.endswith("ing"):
        variants.append(base[:-3])
    if len(base) > 4 and base.endswith("ed"):
        variants.append(base[:-2])

    output: list[str] = []
    seen: set[str] = set()
    for variant in variants:
        v = variant.strip("-_. ")
        if len(v) < 3:
            continue
        if v in seen:
            continue
        seen.add(v)
        output.append(v)
    return output


def _contains_word(text: str, word: str) -> bool:
    for candidate in _token_variants(word):
        if re.search(rf"\b{re.escape(candidate)}\b", text):
            return True
        if len(candidate) >= 4 and re.search(rf"\b{re.escape(candidate)}[a-z0-9]*\b", text):
            return True
    return False


def _query_terms(query_norm: str) -> list[str]:
    terms = re.findall(r"[a-z0-9][a-z0-9+._\-]*", query_norm)
    output: list[str] = []
    seen: set[str] = set()
    for token in terms:
        if len(token) <= 2:
            continue
        for variant in _token_variants(token):
            if variant in seen:
                continue
            seen.add(variant)
            output.append(variant)
    return output


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
                    "experience_years": _as_int_or_none(item.get("experience_years")),
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
            "experience_years": None,
            "companies": [],
        }
        for token in parts[1:]:
            if "=" not in token and "experience_years~" in token:
                _, value = token.split("experience_years~", 1)
                parsed["experience_years"] = _as_int_or_none(value)
                continue
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
            elif key == "experience_years":
                parsed["experience_years"] = _as_int_or_none(value)
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


def _build_evidence_rows(docs: list[LCDocument], limit: int = 160) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    seen: set[tuple[str, str, str, str]] = set()
    next_id = 1

    for doc in docs:
        employee_name, projects = _extract_project_entries_from_doc(doc)
        if employee_name and projects:
            for project in projects:
                if not isinstance(project, dict):
                    continue
                project_name = str(project.get("project_name") or "").strip()
                client_name = str(project.get("client_name") or "").strip()
                project_year = str(project.get("project_year") or "").strip()
                description = str(project.get("description") or "").strip()
                entity = client_name or project_name
                evidence_text = " | ".join(
                    [
                        f"project={project_name}",
                        f"client={client_name}",
                        f"year={project_year}",
                        f"description={description}",
                    ]
                ).strip()
                if not entity and not description:
                    continue
                signature = (
                    _normalize_for_match(employee_name),
                    "project",
                    _normalize_for_match(entity),
                    _normalize_for_match(description)[:160],
                )
                if signature in seen:
                    continue
                seen.add(signature)
                rows.append(
                    {
                        "id": f"E{next_id}",
                        "employee_name": employee_name,
                        "evidence_type": "project",
                        "entity": entity,
                        "evidence_text": evidence_text,
                    }
                )
                next_id += 1

        employee_name, experience_entries = _extract_experience_entries_from_doc(doc)
        if employee_name and experience_entries:
            for exp in experience_entries:
                if not isinstance(exp, dict):
                    continue
                company = str(exp.get("company") or "").strip()
                role = str(exp.get("role") or "").strip()
                start_date = str(exp.get("start_date") or "").strip()
                end_date = str(exp.get("end_date") or "").strip()
                description = str(exp.get("description") or "").strip()
                if not company and not description:
                    continue
                evidence_text = " | ".join(
                    [
                        f"company={company}",
                        f"role={role}",
                        f"start={start_date}",
                        f"end={end_date}",
                        f"description={description}",
                    ]
                ).strip()
                signature = (
                    _normalize_for_match(employee_name),
                    "experience",
                    _normalize_for_match(company),
                    _normalize_for_match(description)[:160],
                )
                if signature in seen:
                    continue
                seen.add(signature)
                rows.append(
                    {
                        "id": f"E{next_id}",
                        "employee_name": employee_name,
                        "evidence_type": "experience",
                        "entity": company,
                        "evidence_text": evidence_text,
                    }
                )
                next_id += 1

        employee_name, certs = _extract_certifications_from_doc(doc)
        if employee_name and certs:
            for cert in certs:
                cert_name = str(cert or "").strip()
                if not cert_name:
                    continue
                signature = (
                    _normalize_for_match(employee_name),
                    "certification",
                    _normalize_for_match(cert_name),
                    "",
                )
                if signature in seen:
                    continue
                seen.add(signature)
                rows.append(
                    {
                        "id": f"E{next_id}",
                        "employee_name": employee_name,
                        "evidence_type": "certification",
                        "entity": cert_name,
                        "evidence_text": f"certification={cert_name}",
                    }
                )
                next_id += 1

        if len(rows) >= limit:
            break

    return rows[:limit]


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
            "experience_years": None,
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
            years_value = _as_int_or_none(row.get("experience_years"))
            if years_value is not None:
                bucket["experience_years"] = years_value
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
    experience_years_ranking: list[tuple[str, int]] = []
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
        experience_years_value = _as_int_or_none(bucket.get("experience_years"))

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
        if experience_years_value is not None:
            experience_years_ranking.append((name, int(experience_years_value)))
        employee_rows.append(
            {
                "name": name,
                "project_count": int(project_count_value or 0),
                "experience_count": int(experience_count_value or 0),
                "experience_years": experience_years_value,
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
    experience_years_ranking.sort(key=lambda item: item[1], reverse=True)

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
        "experience_years_ranking": [
            {"name": name, "experience_years": count} for name, count in experience_years_ranking
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


def _signal_tokens(text: str) -> list[str]:
    stopwords = {
        "the",
        "and",
        "for",
        "with",
        "that",
        "this",
        "from",
        "into",
        "about",
        "your",
        "their",
        "have",
        "has",
        "had",
        "was",
        "were",
        "are",
        "is",
        "who",
        "what",
        "when",
        "where",
        "why",
        "how",
        "list",
        "show",
        "find",
        "search",
        "please",
        "could",
        "would",
        "should",
        "there",
        "them",
        "they",
        "then",
        "than",
        "also",
        "only",
        "just",
        "more",
        "less",
        "most",
        "least",
        "info",
        "information",
        "employee",
        "employees",
        "profile",
        "profiles",
        "project",
        "projects",
        "skill",
        "skills",
        "certification",
        "certifications",
        "experience",
    }
    tokens = re.findall(r"[a-z0-9]+", _normalize_for_match(text))
    out: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        if len(token) < 3:
            continue
        if token in stopwords:
            continue
        if token in seen:
            continue
        seen.add(token)
        out.append(token)
    return out


def _build_grounding_blob(structured_facts_blob: str, docs: list[LCDocument]) -> str:
    parts: list[str] = []
    if structured_facts_blob:
        parts.append(str(structured_facts_blob))

    for doc in docs:
        parts.append(str(doc.page_content or ""))
        metadata = doc.metadata or {}
        for key in ("name", "job_title", "company_name", "client_name", "project_name", "certification_name"):
            value = metadata.get(key)
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
        certifications = metadata.get("certifications")
        if isinstance(certifications, list):
            for cert in certifications:
                cert_text = str(cert or "").strip()
                if cert_text:
                    parts.append(cert_text)

    return _normalize_for_match(" ".join(parts))


def _is_answer_grounded(answer: str, structured_facts_blob: str, docs: list[LCDocument]) -> bool:
    """Safety net: reject answers that are genuinely hallucinated.
    Scales with answer length — short factual answers need minimal grounding,
    but long essays must have proportional overlap with the evidence."""
    normalized_answer = _normalize_for_match(answer)
    if not normalized_answer:
        return False
    if _normalize_for_match(NO_INFO_REPLY) in normalized_answer:
        return True
    if "timed out" in normalized_answer:
        return True

    answer_tokens = _signal_tokens(normalized_answer)
    if not answer_tokens:
        # Generic short answers ("yes", "no", "3") — pass through.
        return True

    evidence_blob = _build_grounding_blob(structured_facts_blob, docs)
    if not evidence_blob:
        return False

    matched = [token for token in answer_tokens if _contains_word(evidence_blob, token)]
    if not matched:
        return False

    coverage = len(matched) / len(answer_tokens)
    num_tokens = len(answer_tokens)

    # Scale threshold with answer length:
    # - Short answers (1-6 tokens): 1 match is enough (factual responses)
    # - Medium answers (7-15 tokens): at least 20% coverage
    # - Long answers (16+): at least 25% coverage (catches hallucinated essays)
    if num_tokens <= 6:
        return True  # Already verified at least 1 match above
    if num_tokens <= 15:
        return coverage >= 0.20
    return coverage >= 0.25


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
                                metadata={
                                    "chunk_type": "disambiguation_notice",
                                    "chunk_id": "disambiguation_notice",
                                    "name": "",
                                },
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

    def _doc_signature(doc: LCDocument) -> tuple[str, str, str, str]:
        metadata = doc.metadata or {}
        chunk_id = str(metadata.get("chunk_id") or "").strip()
        chunk_type = str(metadata.get("chunk_type") or "").strip()
        employee = str(metadata.get("name") or "").strip()
        content_fingerprint = _normalize_for_match(doc.page_content[:220])
        return (chunk_id, chunk_type, employee, content_fingerprint)

    def _retrieve_union(queries: list[str]) -> list[LCDocument]:
        seen: set[tuple[str, str, str, str]] = set()
        merged: list[LCDocument] = []
        for query in queries:
            q = str(query or "").strip()
            if not q:
                continue
            docs_for_query = retriever.invoke(q)
            for doc in docs_for_query:
                sig = _doc_signature(doc)
                if sig in seen:
                    continue
                seen.add(sig)
                merged.append(doc)
        return merged

    llm, model_name, provider = build_rag_chat_llm(
        temperature=0.0,
        timeout=settings.RAG_CHAT_TIMEOUT_SECONDS,
    )
    print(f"[chat_agent] Using chat provider: {provider}, model: {model_name}")
    print("[chat_agent] Pipeline mode: llm-first")

    query_rewrite_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """Rewrite the last user message as a standalone question.
Resolve pronouns from chat history and replace them with exact employee names when clear.
Preserve constraints (else, besides, counts, comparisons) and obvious typo normalization.
If a person name looks misspelled, map it to the closest name in EmployeeNames only when clearly unambiguous.
Return only the rewritten question.""",
            ),
            MessagesPlaceholder("chat_history"),
            ("human", "EmployeeNames:\n{employee_names}\n\nUserInput:\n{input}"),
        ]
    )

    def _rewrite_query(user_input: str, chat_history: list) -> str:
        try:
            employee_names_blob = "\n".join(f"- {name}" for name in known_names) if known_names else "(none)"
            messages = query_rewrite_prompt.format_messages(
                input=user_input,
                chat_history=chat_history or [],
                employee_names=employee_names_blob,
            )
            rewritten = llm.invoke(messages)
            candidate = str(getattr(rewritten, "content", "") or "").strip()
            return candidate or user_input
        except Exception:
            return user_input

    llm_first_query_planner_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """You plan semantic retrieval queries for a RAG system.
Return strict JSON only:
{"resolved_query":"...","retrieval_queries":["...","...","..."]}
Rules:
- Include the resolved_query as the first retrieval query.
- Add up to 2 additional semantically-equivalent queries to improve recall.
- Preserve constraints (negations/exclusions, comparisons, "other than", etc.).
- For category words, include lexical variants (singular/plural and common French/English variants when relevant).
- If a name seems misspelled, align it to the closest EmployeeNames entry when unambiguous.
- Keep all queries concise and specific; do not invent entities.""",
            ),
            MessagesPlaceholder("chat_history"),
            ("human", "EmployeeNames:\n{employee_names}\n\nUserInput:\n{input}"),
        ]
    )

    def _plan_llm_first_queries(user_input: str, chat_history: list) -> tuple[str, list[str]]:
        fallback_query = _rewrite_query(user_input, chat_history)
        fallback_queries = _dedupe_keep_order([fallback_query, user_input])
        try:
            employee_names_blob = "\n".join(f"- {name}" for name in known_names) if known_names else "(none)"
            messages = llm_first_query_planner_prompt.format_messages(
                input=user_input,
                chat_history=chat_history or [],
                employee_names=employee_names_blob,
            )
            raw = llm.invoke(messages)
            obj = parse_json_object(str(getattr(raw, "content", "") or "").strip()) or {}

            resolved_query = str(obj.get("resolved_query") or "").strip() or fallback_query
            retrieval_raw = obj.get("retrieval_queries")
            retrieval_queries: list[str] = []
            if isinstance(retrieval_raw, list):
                for item in retrieval_raw:
                    q = str(item or "").strip()
                    if q:
                        retrieval_queries.append(q)

            retrieval_queries = _dedupe_keep_order([resolved_query, *retrieval_queries, user_input])
            if not retrieval_queries:
                retrieval_queries = fallback_queries
            return resolved_query, retrieval_queries[:3]
        except Exception:
            return fallback_query, fallback_queries[:3]

    llm_first_evidence_selector_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """Select explicit evidence rows that directly support answering the query.
Return strict JSON only:
{"query_type":"category_filter|listing|other","selected_evidence_ids":["E1","E2"],"notes":"..."}
Rules:
- Use only ids from EvidenceCatalog.
- Set query_type=category_filter when the user asks membership/filter/category/comparison across people
  (examples: who has worked for banks, healthcare organizations, telecom, cybersecurity).
- For category_filter, be conservative: select only rows with direct lexical evidence for the target category.
- Do not infer category from unrelated organizations; if uncertain, select no rows.
- Set query_type=listing when the user asks to list, enumerate, or summarize all employees or the workforce
  (examples: who are the employees, list all employees, how many employees do we have, show me the team).
  For listing queries, set selected_evidence_ids=[].
- For non-category, non-listing queries, set query_type=other and selected_evidence_ids=[].""",
            ),
            ("human", "StandaloneQuery:\n{standalone_query}\n\nEvidenceCatalog:\n{evidence_catalog}"),
        ]
    )

    def _select_llm_first_evidence(standalone_query: str, docs: list[LCDocument]) -> dict[str, object]:
        fallback = {
            "query_type": "other",
            "selected_rows": [],
            "notes": "",
        }
        candidates = _build_evidence_rows(docs)
        if not candidates:
            return fallback

        catalog_lines: list[str] = []
        for row in candidates:
            text = str(row.get("evidence_text") or "")
            if len(text) > 220:
                text = f"{text[:220]}..."
            catalog_lines.append(
                " | ".join(
                    [
                        str(row.get("id") or ""),
                        f"employee={row.get('employee_name') or ''}",
                        f"type={row.get('evidence_type') or ''}",
                        f"entity={row.get('entity') or ''}",
                        f"text={text}",
                    ]
                )
            )
        evidence_catalog = "\n".join(catalog_lines)
        id_to_row = {str(row.get("id") or ""): row for row in candidates}

        try:
            messages = llm_first_evidence_selector_prompt.format_messages(
                standalone_query=standalone_query,
                evidence_catalog=evidence_catalog,
            )
            raw = llm.invoke(messages)
            obj = parse_json_object(str(getattr(raw, "content", "") or "").strip()) or {}
            query_type = str(obj.get("query_type") or "other").strip().lower()
            if query_type not in {"category_filter", "listing", "other"}:
                query_type = "other"

            selected_ids_raw = obj.get("selected_evidence_ids")
            selected_ids: list[str] = []
            if isinstance(selected_ids_raw, list):
                for item in selected_ids_raw:
                    row_id = str(item or "").strip().upper()
                    if row_id in id_to_row:
                        selected_ids.append(row_id)
            selected_ids = _dedupe_keep_order(selected_ids)

            selected_rows: list[dict[str, str]] = []
            for row_id in selected_ids:
                row = id_to_row.get(row_id)
                if not row:
                    continue
                selected_rows.append(
                    {
                        "employee_name": str(row.get("employee_name") or "").strip(),
                        "evidence_type": str(row.get("evidence_type") or "").strip(),
                        "entity": str(row.get("entity") or "").strip(),
                        "evidence_text": str(row.get("evidence_text") or "").strip(),
                    }
                )

            return {
                "query_type": query_type,
                "selected_rows": selected_rows,
                "notes": str(obj.get("notes") or "").strip(),
            }
        except Exception:
            return fallback

    def _recent_history_blob(chat_history: list) -> str:
        lines: list[str] = []
        for msg in chat_history[-8:]:
            role = str(getattr(msg, "type", "message"))
            content = str(getattr(msg, "content", "") or "").strip()
            if content:
                lines.append(f"{role}: {content}")
        return "\n".join(lines) if lines else "(none)"

    qa_prompt_llm_first = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """You are a Bid Manager assistant with access to a company employee database.

DATA SOURCES (in priority order):
1. StructuredFacts — JSON with employee profiles, projects, experience, certifications, education, company history, and rankings. This is your PRIMARY and ONLY source of truth.
2. Context — Raw document chunks for additional detail.

CRITICAL:
- You MUST ONLY use data from StructuredFacts and Context. NEVER use your own training knowledge.
- When the user mentions a person's name, ONLY discuss that person as they appear in StructuredFacts. Do NOT use your general knowledge about anyone with a similar name.
- If StructuredFacts has data about the person, answer from that data ONLY. If not, say: "I don't have that information."

RULES:
- Answer ONLY what the user asked. Be concise and direct.
- Do NOT volunteer extra details, full lists, or background information unless the user explicitly asks.
- You CAN reason, analyze, compare, rank, count, filter, and recommend based on the provided data.
- If insufficient data exists to answer, say exactly: "I don't have that information."
- Respect query constraints exactly ("other than", "except", "least", "most", "all").
- Resolve minor name spelling mistakes using StructuredFacts employee names when unambiguous.
- Stay consistent with RecentChatHistory unless new facts clearly change the answer.
- For counts, use total_employees from StructuredFacts.
- For rankings/comparisons, use the ranking arrays in StructuredFacts.
- For greetings (hello, hi, hey), respond politely and briefly explain you can help with employee data queries.

RecentChatHistory:
{recent_chat_history}

StandaloneQuery:
{standalone_query}

StructuredFacts:
{structured_facts}

Context:
{context}""",
            ),
            ("human", "{input}"),
        ]
    )

    qa_chain_llm_first = create_stuff_documents_chain(
        llm=llm,
        prompt=qa_prompt_llm_first,
        document_prompt=PromptTemplate.from_template(
            "[chunk_type={chunk_type} | employee={name} | chunk_id={chunk_id}]\n{page_content}"
        ),
        document_separator="\n\n---\n\n",
    )

    def _safe_chain_invoke(chain_obj, payload: dict[str, object]) -> str:
        try:
            return chain_obj.invoke(payload)
        except Exception as exc:
            err = str(exc or "")
            err_norm = _normalize_for_match(err)
            if "timeout" in err_norm:
                return "The language model request timed out. Please try again."
            raise

    def _invoke(inputs: dict) -> dict:
        user_input = str(inputs.get("input") or "").strip()
        chat_history = inputs.get("chat_history", []) or []

        standalone_query, retrieval_queries = _plan_llm_first_queries(user_input, chat_history)
        docs = _retrieve_union(retrieval_queries)
        if not docs:
            docs = retriever.invoke(standalone_query)
        if not docs:
            return {
                "answer": NO_INFO_REPLY,
                "context": [],
            }

        # Build structured facts from retrieved docs — this is the LLM's primary data source.
        structured_facts = _build_structured_facts(docs, query_text=standalone_query)

        recent_history_blob = _recent_history_blob(chat_history)
        answer = _safe_chain_invoke(
            qa_chain_llm_first,
            {
                "input": user_input,
                "standalone_query": standalone_query,
                "context": docs,
                "structured_facts": structured_facts,
                "recent_chat_history": recent_history_blob,
            },
        )

        # Lightweight safety net: only reject genuinely hallucinated answers.
        if not _is_answer_grounded(str(answer or ""), structured_facts, docs):
            answer = NO_INFO_REPLY

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
        try:
            result = chain.invoke(
                {"input": user_input},
                config={"configurable": {"session_id": session_id}},
            )
        except Exception as exc:
            err = str(exc or "")
            print(f"Bid Manager: Request failed ({err}).\n")
            continue
        dt = time.time() - t0
        answer = result.get("answer", "")
        print(f"Bid Manager: {answer}\n(took {dt:.1f}s)\n")


if __name__ == "__main__":
    chat_loop()
