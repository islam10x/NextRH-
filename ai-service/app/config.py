from pydantic import model_validator
from pydantic_settings import BaseSettings
from pathlib import Path

_AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]
_REPO_ROOT = Path(__file__).resolve().parents[2]

class Settings(BaseSettings):
    APP_NAME: str = "AI CV Parser Service"
    DEBUG: bool = True
    API_V1_STR: str = "/api/v1"
    
    # Paths
    UPLOAD_FOLDER: str = "uploads"
    TEMPLATE_FOLDER: str = "templates"
    
    # OCR Settings
    OCR_ENGINE: str = "tesseract" # set to "easyocr" or "both" to enable dual OCR (Tesseract + EasyOCR)
    
    # Backend Integration
    BACKEND_URL: str = "http://localhost:3000"

    # Reuse the same PostgreSQL settings used by the main backend when needed.
    DB_HOST: str = "127.0.0.1"
    DB_PORT: int = 5432
    DB_USER: str = "postgres"
    DB_PASSWORD: str = "change_me"
    DB_NAME: str = "cv_management"

    # Optional explicit URL. If omitted, it is derived from DB_* fields above.
    DATABASE_URL: str | None = None
    # Embedding size expected by pgvector column definition.
    EMBEDDING_DIM: int = 768
    # Ollama embedding model config used by RAG ingestion.
    OLLAMA_URL: str = "http://127.0.0.1:11434"
    OLLAMA_ENABLED: bool = True
    EMBEDDING_MODEL: str = "nomic-embed-text"
    # RAG chat LLM config. Keep parsing on local Ollama unless you change parsing code explicitly.
    RAG_CHAT_PROVIDER: str = "ollama"  # ollama | huggingface
    RAG_CHAT_MODEL: str = "qwen2.5:1.5b-instruct"
    RAG_CHAT_HF_MODEL: str = "Qwen/Qwen2.5-7B-Instruct:together"
    RAG_CHAT_TIMEOUT_SECONDS: float = 30.0
    HF_ROUTER_BASE_URL: str = "https://router.huggingface.co/v1"
    HF_TOKEN: str | None = None
    HF_API_KEY: str | None = None
    # Comma-separated candidate roots for employee metadata.json files.
    RAG_METADATA_ROOTS: str = "backend/local-storage,backend/file-storage/CV_Database"

    @model_validator(mode="before")
    def coerce_debug(cls, data):
        val = data.get("DEBUG")
        if isinstance(val, str):
            data["DEBUG"] = val.lower() in ("1", "true", "yes", "on")
        return data

    @model_validator(mode="after")
    def build_database_url(self) -> "Settings":
        if not self.DATABASE_URL:
            self.DATABASE_URL = (
                f"postgresql+psycopg://{self.DB_USER}:{self.DB_PASSWORD}"
                f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
            )
        return self

    class Config:
        env_file = (
            str(_AI_SERVICE_ROOT / ".env"),
            str(_REPO_ROOT / ".env"),
            ".env",
        )
        extra = "ignore"

settings = Settings()
