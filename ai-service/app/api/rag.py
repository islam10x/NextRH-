from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel
from uuid import UUID
from app.rag.etl_ingest import ingest_employee, run_ingestion
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

class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"

# Global or lazy-loaded chain
_chain = None

def get_chain():
    global _chain
    if _chain is None:
        _chain = build_chain()
    return _chain

@router.post("/chat")
async def chat_rag(request: ChatRequest):
    """Perform a RAG chat interaction."""
    chain = get_chain()
    try:
        result = chain.invoke(
            {"input": request.message},
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
