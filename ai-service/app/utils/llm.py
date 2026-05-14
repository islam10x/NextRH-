import re
import json
import urllib.request
import time
import logging
from typing import Optional, Dict, Any, List
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
    effective_timeout = timeout if timeout is not None else settings.RAG_CHAT_TIMEOUT_SECONDS
    client_kwargs: dict[str, float] = {}
    if isinstance(effective_timeout, (int, float)) and float(effective_timeout) > 0:
        client_kwargs["timeout"] = float(effective_timeout)

    from langchain_ollama import ChatOllama  # Imported lazily to keep optional dependency.

    llm = ChatOllama(
        model=model_name,
        base_url=settings.OLLAMA_URL,
        temperature=temperature,
        client_kwargs=client_kwargs,
        disable_streaming=False,
        num_ctx=8192,
    )
    return llm, model_name, "ollama"


def call_local_chat(
    messages: List[Dict[str, str]],
    model: Optional[str] = None,
    temperature: float = 0.0,
    timeout: float | None = None,
    max_tokens: int | None = None,
    disable_streaming: bool = True,
) -> str:
    """Invoke a local Ollama chat model with Groq-like simple inputs.

    The helper accepts a list of dict messages:
      [{"role": "system"|"user"|"assistant", "content": "..."}]

    It attempts the preferred model first, then falls back to the strongest
    available local instruct model.
    """
    if not messages:
        return ""

    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
    from langchain_ollama import ChatOllama

    lc_messages = []
    for msg in messages:
        role = str((msg or {}).get("role") or "user").strip().lower()
        content = str((msg or {}).get("content") or "").strip()
        if not content:
            continue
        if role == "system":
            lc_messages.append(SystemMessage(content=content))
        elif role == "assistant":
            lc_messages.append(AIMessage(content=content))
        else:
            lc_messages.append(HumanMessage(content=content))

    if not lc_messages:
        return ""

    configured_model = str(model or "").strip()
    fallback_model = resolve_llm_model()
    model_candidates: list[str] = []
    if configured_model:
        model_candidates.append(configured_model)
    if fallback_model and fallback_model not in model_candidates:
        model_candidates.append(fallback_model)

    last_error: Exception | None = None
    for candidate_model in model_candidates:
        try:
            client_kwargs: dict[str, float] = {}
            if isinstance(timeout, (int, float)) and float(timeout) > 0:
                client_kwargs["timeout"] = float(timeout)

            generation_kwargs: dict[str, int] = {}
            if isinstance(max_tokens, int) and max_tokens > 0:
                generation_kwargs["num_predict"] = int(max_tokens)

            llm = ChatOllama(
                model=candidate_model,
                base_url=settings.OLLAMA_URL,
                temperature=temperature,
                client_kwargs=client_kwargs,
                disable_streaming=disable_streaming,
                num_ctx=8192,
                **generation_kwargs,
            )
            response = llm.invoke(lc_messages)
            content = getattr(response, "content", "")
            if isinstance(content, list):
                content = "".join(
                    part.get("text", "") if isinstance(part, dict) else str(part)
                    for part in content
                )
            text = str(content or "").strip()
            if configured_model and candidate_model != configured_model:
                logger.warning(
                    "Preferred local model '%s' unavailable, used '%s' instead.",
                    configured_model,
                    candidate_model,
                )
            return text
        except Exception as exc:
            last_error = exc
            logger.warning("Local LLM call failed with model '%s': %s", candidate_model, exc)

    if last_error is not None:
        raise last_error
    return ""

def parse_json_object(raw_text: str) -> Optional[Dict[str, Any]]:
    """Robustly parse a JSON object from text, finding the first valid {} block.

    Also handles:
    - Markdown code fences (```json ... ```)
    - Array-of-objects responses (flattened into a single dict)
    """
    text = str(raw_text or "").strip()
    if not text:
        return None

    # Strip markdown code fences if present.
    text = re.sub(r"^```(?:json)?\s*\n?", "", text)
    text = re.sub(r"\n?```\s*$", "", text)
    text = text.strip()

    # Small models frequently inject invalid trailing commas at the end of arrays/objects.
    # Standard python json.loads crashes if it sees `[1, 2, ]`. Let's strip them!
    text = re.sub(r',\s*([\]}])', r'\1', text)

    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
        # Handle array-of-objects: merge all dicts into one.
        if isinstance(data, list):
            merged = {}
            for item in data:
                if isinstance(item, dict):
                    merged.update(item)
            if merged:
                return merged
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

