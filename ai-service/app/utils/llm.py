import re
import json
import logging
from typing import Optional, Dict, Any, List
from app.config import settings

logger = logging.getLogger(__name__)


def build_rag_chat_llm(temperature: float = 0.0, timeout: float | None = None):
    """Build a LangChain chat model for RAG chatbot usage."""
    from langchain_groq import ChatGroq

    model_name = settings.GROQ_RAG_MODEL
    kwargs: Dict[str, Any] = {
        "model": model_name,
        "api_key": settings.GROQ_API_KEY,
        "temperature": temperature,
    }
    if timeout is not None:
        kwargs["timeout"] = timeout

    llm = ChatGroq(**kwargs)
    return llm, model_name, "groq"


def call_local_chat(
    messages: List[Dict[str, str]],
    model: Optional[str] = None,
    temperature: float = 0.0,
    timeout: float | None = None,
    max_tokens: int | None = None,
    disable_streaming: bool = True,
) -> str:
    """Invoke Groq chat with Groq-like simple inputs.

    Accepts a list of dict messages:
      [{"role": "system"|"user"|"assistant", "content": "..."}]
    """
    if not messages:
        return ""

    from groq import Groq

    client = Groq(
        api_key=settings.GROQ_API_KEY,
        timeout=timeout if timeout is not None else settings.GROQ_TIMEOUT_SECONDS,
    )
    model_name = model or settings.GROQ_CV_MODEL
    kwargs: Dict[str, Any] = {
        "model": model_name,
        "messages": messages,
        "temperature": temperature,
    }
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens

    response = client.chat.completions.create(**kwargs)
    return (response.choices[0].message.content or "").strip()


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
