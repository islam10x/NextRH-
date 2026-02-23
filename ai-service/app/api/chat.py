from functools import lru_cache
from typing import AsyncIterator, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.rag.chat_agent import build_chain

router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None


@lru_cache(maxsize=1)
def _get_chain():
    return build_chain()


@router.post("/chat/stream")
async def chat_stream(payload: ChatRequest):
    try:
        chain, _ = _get_chain()
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=f"Chat chain unavailable: {exc}") from exc

    session_id = payload.session_id or "api"

    async def event_generator() -> AsyncIterator[str]:
        async for chunk in chain.astream(
            {"input": payload.message},
            config={"configurable": {"session_id": session_id}},
        ):
            token = chunk.get("answer")
            if token:
                yield f"data: {token}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
