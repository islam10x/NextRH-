import re
import json
import urllib.request
import time
import logging
from typing import Optional, Dict, Any
from app.config import settings

LLM_MODEL = "qwen2.5:1.5b-instruct"
LLM_MODEL_FALLBACK = "qwen2.5:0.5b-instruct"
LLM_MODEL_CACHE_TTL_SECONDS = 300

_LLM_MODEL_CACHE: dict[str, object] = {"model": None, "ts": 0.0}

logger = logging.getLogger(__name__)

def resolve_llm_model() -> str:
    """Return the strongest available local instruct model."""
    now = time.time()
    cached_model = _LLM_MODEL_CACHE.get("model")
    cached_ts = float(_LLM_MODEL_CACHE.get("ts") or 0.0)
    if isinstance(cached_model, str) and cached_model and (now - cached_ts) < LLM_MODEL_CACHE_TTL_SECONDS:
        logger.debug(
            f"resolve_llm_model cache hit (model={cached_model}, age={now - cached_ts:.1f}s)"
        )
        return cached_model

    start = time.perf_counter()
    def _size_in_billions(model_name: str) -> float:
        match = re.search(r":(\d+(?:\.\d+)?)b", model_name.lower())
        if not match:
            return 0.0
        try:
            return float(match.group(1))
        except ValueError:
            return 0.0

    def _model_score(model_name: str) -> tuple[int, float, int]:
        normalized = model_name.lower()
        if normalized.startswith("qwen2.5"):
            family_rank = 3
        elif normalized.startswith("qwen2"):
            family_rank = 2
        elif normalized.startswith("llama3"):
            family_rank = 1
        else:
            family_rank = 0
        return (family_rank, _size_in_billions(model_name), 1 if "instruct" in normalized else 0)

    try:
        with urllib.request.urlopen(f"{settings.OLLAMA_URL}/api/tags", timeout=3) as resp:
            data = json.loads(resp.read())
            available = [str(model.get("name") or "").strip() for model in data.get("models", [])]
            available = [name for name in available if name]
            
            if not available:
                _LLM_MODEL_CACHE.update({"model": LLM_MODEL, "ts": time.time()})
                logger.info(f"resolve_llm_model completed in {time.perf_counter() - start:.2f}s (model={LLM_MODEL})")
                return LLM_MODEL

            instruct_candidates = [name for name in available if "instruct" in name.lower()]
            if not instruct_candidates:
                if LLM_MODEL in available:
                    selected = LLM_MODEL
                else:
                    selected = available[0]
                _LLM_MODEL_CACHE.update({"model": selected, "ts": time.time()})
                logger.info(f"resolve_llm_model completed in {time.perf_counter() - start:.2f}s (model={selected})")
                return selected
            
            selected = max(instruct_candidates, key=_model_score)
            _LLM_MODEL_CACHE.update({"model": selected, "ts": time.time()})
            logger.info(f"resolve_llm_model completed in {time.perf_counter() - start:.2f}s (model={selected})")
            return selected
    except Exception:
        pass
    _LLM_MODEL_CACHE.update({"model": LLM_MODEL, "ts": time.time()})
    logger.info(f"resolve_llm_model completed in {time.perf_counter() - start:.2f}s (model={LLM_MODEL})")
    return LLM_MODEL

def resolve_rag_chat_model() -> str:
    """Resolve the chat model for RAG only (parsing stays on local Ollama flow)."""
    configured_local = str(settings.RAG_CHAT_MODEL or "").strip()
    return configured_local or resolve_llm_model()

def build_rag_chat_llm(temperature: float = 0.0, timeout: float | None = None):
    """Build a LangChain chat model for RAG chatbot usage only."""
    model_name = resolve_rag_chat_model()

    from langchain_ollama import ChatOllama  # Imported lazily to keep optional dependency.

    llm = ChatOllama(
        model=model_name,
        base_url=settings.OLLAMA_URL,
        temperature=temperature,
        disable_streaming=True,
        num_ctx=4096,
    )
    return llm, model_name, "ollama"

def parse_json_object(raw_text: str) -> Optional[Dict[str, Any]]:
    """Robustly parse a JSON object from text, finding the first valid {} block."""
    text = str(raw_text or "").strip()
    if not text:
        return None
        
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except Exception:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(text[start : end + 1])
            if isinstance(data, dict):
                return data
        except Exception:
            return None
    return None
