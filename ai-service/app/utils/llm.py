import re
import json
import urllib.request
from typing import Optional, Dict, Any
from app.config import settings

LLM_MODEL = "qwen2.5:1.5b-instruct"
LLM_MODEL_FALLBACK = "qwen2.5:0.5b-instruct"

def resolve_llm_model() -> str:
    """Return the strongest available local instruct model."""
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
                return LLM_MODEL

            instruct_candidates = [name for name in available if "instruct" in name.lower()]
            if not instruct_candidates:
                if LLM_MODEL in available:
                    return LLM_MODEL
                return available[0]
                
            return max(instruct_candidates, key=_model_score)
    except Exception:
        pass
    return LLM_MODEL

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
