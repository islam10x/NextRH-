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

def _normalize_provider(provider: str | None) -> str:
    value = str(provider or "").strip().lower()
    if value in {"hf", "huggingface", "huggingface_router", "hf_router"}:
        return "huggingface"
    return "ollama"

def resolve_rag_chat_model() -> str:
    """Resolve the chat model for RAG only (parsing stays on local Ollama flow)."""
    provider = _normalize_provider(settings.RAG_CHAT_PROVIDER)
    if provider == "huggingface":
        return str(settings.RAG_CHAT_HF_MODEL or "").strip() or "Qwen/Qwen2.5-7B-Instruct:together"

    configured_local = str(settings.RAG_CHAT_MODEL or "").strip()
    return configured_local or resolve_llm_model()

def _resolve_hf_token() -> str:
    token = str(settings.HF_TOKEN or settings.HF_API_KEY or "").strip()
    if token:
        return token
    raise RuntimeError(
        "RAG_CHAT_PROVIDER is set to Hugging Face but no token was found. "
        "Set HF_TOKEN (or HF_API_KEY) in your environment."
    )

def _build_hf_langchain_chat_model(model_name: str, temperature: float, timeout: float | None):
    token = _resolve_hf_token()
    base_url = str(settings.HF_ROUTER_BASE_URL or "").strip() or "https://router.huggingface.co/v1"

    try:
        from langchain_openai import ChatOpenAI  # type: ignore
    except Exception:
        try:
            from langchain_community.chat_models import ChatOpenAI  # type: ignore
        except Exception as exc:
            try:
                from langchain_core.language_models.chat_models import BaseChatModel
                from langchain_core.messages import AIMessage, BaseMessage
                from langchain_core.outputs import ChatGeneration, ChatResult
                from openai import OpenAI
            except Exception as core_exc:
                raise RuntimeError(
                    "Missing dependency for Hugging Face chat provider. "
                    "Install 'langchain-openai' or ensure 'langchain-core' and 'openai' are available."
                ) from core_exc

            class HuggingFaceRouterChatModel(BaseChatModel):
                model_name: str
                api_key: str
                base_url: str
                temperature: float = 0.0
                request_timeout: float | None = None

                @property
                def _llm_type(self) -> str:
                    return "huggingface_router_openai_compatible"

                @property
                def _identifying_params(self) -> dict[str, Any]:
                    return {
                        "model_name": self.model_name,
                        "base_url": self.base_url,
                    }

                def _message_content_to_text(self, content: Any) -> str:
                    if content is None:
                        return ""
                    if isinstance(content, str):
                        return content
                    if isinstance(content, list):
                        parts: list[str] = []
                        for item in content:
                            if isinstance(item, dict):
                                if item.get("type") == "text" and item.get("text") is not None:
                                    parts.append(str(item.get("text")))
                                else:
                                    parts.append(str(item))
                            else:
                                parts.append(str(item))
                        return "\n".join(parts).strip()
                    return str(content)

                def _to_openai_messages(self, messages: list[BaseMessage]) -> list[dict[str, str]]:
                    payload: list[dict[str, str]] = []
                    for msg in messages:
                        msg_type = str(getattr(msg, "type", "")).lower()
                        if msg_type in {"system"}:
                            role = "system"
                        elif msg_type in {"ai", "assistant"}:
                            role = "assistant"
                        else:
                            role = "user"
                        payload.append(
                            {
                                "role": role,
                                "content": self._message_content_to_text(getattr(msg, "content", "")),
                            }
                        )
                    return payload

                def _generate(self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs) -> ChatResult:
                    client = OpenAI(base_url=self.base_url, api_key=self.api_key)
                    request_args: dict[str, Any] = {
                        "model": self.model_name,
                        "messages": self._to_openai_messages(messages),
                        "temperature": self.temperature,
                    }
                    if self.request_timeout is not None:
                        request_args["timeout"] = self.request_timeout
                    if stop:
                        request_args["stop"] = stop

                    response = client.chat.completions.create(**request_args)
                    choice = response.choices[0] if response.choices else None
                    text = self._message_content_to_text(getattr(getattr(choice, "message", None), "content", ""))
                    generation = ChatGeneration(message=AIMessage(content=text))
                    return ChatResult(generations=[generation])

            return HuggingFaceRouterChatModel(
                model_name=model_name,
                api_key=token,
                base_url=base_url,
                temperature=temperature,
                request_timeout=timeout,
            )

    # Newer ChatOpenAI signatures
    try:
        return ChatOpenAI(
            model=model_name,
            api_key=token,
            base_url=base_url,
            temperature=temperature,
            timeout=timeout,
        )
    except TypeError:
        # Backward-compatible signature for older chat model wrappers
        return ChatOpenAI(
            model_name=model_name,
            openai_api_key=token,
            openai_api_base=base_url,
            temperature=temperature,
            request_timeout=timeout,
        )

def build_rag_chat_llm(temperature: float = 0.0, timeout: float | None = None):
    """Build a LangChain chat model for RAG chatbot usage only."""
    model_name = resolve_rag_chat_model()
    provider = _normalize_provider(settings.RAG_CHAT_PROVIDER)
    request_timeout = timeout if timeout is not None else float(settings.RAG_CHAT_TIMEOUT_SECONDS)

    if provider == "huggingface":
        llm = _build_hf_langchain_chat_model(
            model_name=model_name,
            temperature=temperature,
            timeout=request_timeout,
        )
        return llm, model_name, provider

    from langchain_ollama import ChatOllama  # Imported lazily to avoid hard dependency in HF-only tests.

    llm = ChatOllama(
        model=model_name,
        base_url=settings.OLLAMA_URL,
        temperature=temperature,
        disable_streaming=True,
        num_ctx=8192,
    )
    return llm, model_name, provider

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
