from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel
from uuid import UUID
import re
from app.rag.etl_ingest import ingest_employee, run_ingestion, delete_employee_vectors
from app.rag.chat_agent import build_chain
from app.utils.llm import build_rag_chat_llm, parse_json_object
from langchain_core.messages import HumanMessage, SystemMessage

router = APIRouter()

@router.post("/sync/{user_id}")
async def sync_employee_rag(user_id: UUID, background_tasks: BackgroundTasks):
    """Trigger an immediate re-vectorization for a single employee."""
    # Run in background to avoid blocking the caller
    background_tasks.add_task(ingest_employee, str(user_id))
    return {"message": f"Sync started for user {user_id}"}

@router.post("/sync-all")
async def sync_all_rag(background_tasks: BackgroundTasks):
    """Trigger a full re-ingestion of all employees."""
    background_tasks.add_task(run_ingestion, limit=None, dry_run=False)
    return {"message": "Full RAG sync started in background"}

@router.delete("/vectors/{user_id}")
async def delete_user_vectors(user_id: UUID, background_tasks: BackgroundTasks):
    """Delete all RAG vectors for a user and refresh the directory chunk."""
    background_tasks.add_task(delete_employee_vectors, str(user_id))
    return {"message": f"RAG vectors deletion queued for user {user_id}"}

class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"

# Global or lazy-loaded chain
_chain = None
_intent_llm = None

def get_chain():
    global _chain
    if _chain is None:
        _chain = build_chain()
    return _chain

def _get_intent_llm():
    global _intent_llm
    if _intent_llm is None:
        llm, _model, _provider = build_rag_chat_llm(temperature=0.0, timeout=12)
        _intent_llm = llm
    return _intent_llm

def _normalize_message(message: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", (message or "").lower())).strip()

def _is_obvious_small_talk(message: str) -> bool:
    norm = _normalize_message(message)
    if not norm:
        return True

    obvious_small_talk = {
        "hi",
        "hello",
        "hey",
        "good morning",
        "good afternoon",
        "good evening",
        "how are you",
        "thanks",
        "thank you",
        "ok",
        "okay",
        "bye",
        "goodbye",
    }
    if norm in obvious_small_talk:
        return True

    tokens = [t for t in norm.split(" ") if t]
    if len(tokens) <= 4 and any(g in norm for g in ("hi", "hello", "hey", "thanks", "thank you")):
        return True

    return False

def _looks_like_employee_search(message: str) -> bool:
    norm = _normalize_message(message)
    if not norm:
        return False

    hr_keywords = {
        "employee",
        "employees",
        "candidate",
        "candidates",
        "team",
        "teams",
        "cv",
        "resume",
        "skill",
        "skills",
        "certification",
        "certifications",
        "project",
        "projects",
        "experience",
        "profile",
        "profiles",
        "who has",
        "find",
        "search",
        "list",
    }
    if any(k in norm for k in hr_keywords):
        return True

    # Common real-world phrasing that should always hit RAG.
    if re.search(r"\b(anything|what)\s+(do\s+you\s+know|about)\s+\w+", norm):
        return True
    if re.search(r"\babout\s+\w+\b", norm):
        return True

    return False

def _classify_intent(message: str) -> str:
    # Deterministic routing first to avoid model-dependent misclassification.
    if _looks_like_employee_search(message):
        return "employee_search"
    if _is_obvious_small_talk(message):
        return "small_talk"

    llm = _get_intent_llm()
    system_prompt = (
        "You are an intent classifier for a staffing assistant. "
        "Decide if the user is trying to search/filter employees "
        "(skills, certifications, experience, projects, availability) "
        "or if the user is just making small talk / greetings. "
        "Return ONLY valid JSON: {\"intent\": \"employee_search\"|\"small_talk\"}."
    )
    try:
        resp = llm.invoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=message),
        ])
        content = getattr(resp, "content", None) or str(resp)
        parsed = parse_json_object(content)
        intent = str(parsed.get("intent") or "").strip().lower() if isinstance(parsed, dict) else ""
        if intent in {"employee_search", "small_talk"}:
            if intent == "small_talk" and not _is_obvious_small_talk(message):
                return "employee_search"
            return intent
    except Exception:
        pass
    return "employee_search"

def _respond_small_talk(message: str) -> str:
    llm = _get_intent_llm()
    system_prompt = (
        "You are a friendly assistant. Respond briefly and helpfully. "
        "Do not mention any employee names or internal data unless the user "
        "explicitly asks to search for employees."
    )
    try:
        resp = llm.invoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=message),
        ])
        return (getattr(resp, "content", None) or str(resp)).strip() or "Hello! How can I help?"
    except Exception:
        return "Hello! How can I help?"

@router.post("/chat")
async def chat_rag(request: ChatRequest):
    """Perform a RAG chat interaction."""
    message = (request.message or "").strip()
    if _classify_intent(message) == "small_talk":
        return {
            "answer": _respond_small_talk(message),
            "context": [],
        }

    chain = get_chain()
    try:
        result = chain.invoke(
            {"input": message},
            config={"configurable": {"session_id": request.session_id}},
        )
        return {
            "answer": result.get("answer"),
            "context": [
                {"content": doc.page_content, "metadata": doc.metadata}
                for doc in result.get("context", [])
            ]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
