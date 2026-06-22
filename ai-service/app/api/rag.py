from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from uuid import UUID
from app.rag.etl_ingest import ingest_employee, run_ingestion, delete_employee_vectors
from app.rag.chat_agent import build_chain

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
    message: str = Field(..., min_length=1, max_length=2000)
    session_id: str = "default"

# Lazy-built RAG artifacts (chain + stream function).
_built = None


def _get_built():
    global _built
    if _built is None:
        _built = build_chain()
    return _built

def get_chain():
    return _get_built()["chain"]


def get_stream():
    return _get_built()["stream"]

@router.post("/chat")
async def chat_rag(request: ChatRequest):
    """Perform a RAG chat interaction (non-streaming)."""
    message = (request.message or "").strip()
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
        err = str(e or "").strip()
        if "timed out" in err.lower() or "timeout" in err.lower():
            # Return a normal payload so backend/frontend don't surface a hard 500.
            return {
                "answer": "The model timed out while processing your request. Please retry or use a faster model.",
                "context": [],
            }
        raise HTTPException(status_code=500, detail=err)


@router.post("/chat/stream")
async def chat_rag_stream(request: ChatRequest):
    """Perform a RAG chat interaction and stream NDJSON chunks."""
    message = (request.message or "").strip()
    stream_invoke = get_stream()

    def _ndjson_stream():
        import json as _json

        try:
            yield from stream_invoke(message, request.session_id)
        except Exception as exc:
            err = str(exc or "").strip().lower()
            if "timed out" in err or "timeout" in err:
                answer = "The model timed out while processing your request. Please retry or use a faster model."
            else:
                answer = "An error occurred while generating the response."
            yield _json.dumps({"type": "token", "data": answer}) + "\n"
            yield _json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(
        _ndjson_stream(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
