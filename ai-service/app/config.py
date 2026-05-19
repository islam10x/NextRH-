from pydantic import model_validator
from pydantic_settings import BaseSettings
from pathlib import Path

_AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]
_REPO_ROOT = Path(__file__).resolve().parents[2]

class Settings(BaseSettings):
    APP_NAME: str = "AI CV Parser Service"
    DEBUG: bool = False
    API_V1_STR: str = "/api/v1"
    RAG_INIT_ON_STARTUP: bool = True
    RAG_STARTUP_REQUIRED: bool = False
    
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
    DB_PASSWORD: str = ""
    DB_NAME: str = "cv_management"

    # Optional explicit URL. If omitted, it is derived from DB_* fields above.
    DATABASE_URL: str | None = None
    # Embedding size expected by pgvector column definition.
    EMBEDDING_DIM: int = 768
    # Ollama embedding model config used by RAG ingestion.
    OLLAMA_URL: str = "http://127.0.0.1:11434"
    OLLAMA_ENABLED: bool = True
    EMBEDDING_MODEL: str = "nomic-embed-text"
    # RAG chat LLM config (Ollama only).
    RAG_CHAT_MODEL: str = "qwen2.5:1.5b-instruct"
    RAG_CHAT_TIMEOUT_SECONDS: float = 30.0
    # Translation (CV generation) — uses Ollama
    TRANSLATION_MODEL: str | None = None
    TRANSLATION_TIMEOUT_SECONDS: float = 25.0
    TRANSLATION_ENABLED: bool = True
    # Comma-separated candidate roots for employee metadata.json files.
    RAG_METADATA_ROOTS: str = "backend/local-storage,backend/file-storage/CV_Database,/app/file-storage/CV_Database"

    # Legacy cloud-model settings kept for backward compatibility. Local runtime
    # now prefers LOCAL_* or auto-detected Ollama models.
    GROQ_API_KEY: str = ""
    GROQ_CV_MODEL: str = "llama-3.3-70b-versatile"
    GROQ_RAG_MODEL: str = "llama-3.1-8b-instant"
    GROQ_SCORING_MODEL: str = "llama-3.3-70b-versatile"
    GROQ_TIMEOUT_SECONDS: float = 15.0  # per-request timeout for Groq API calls
    GROQ_SUMMARY_TEMPERATURE: float = 0.3
    GROQ_PAIRS_TEMPERATURE: float = 0.2
    # Local model overrides (Ollama). If empty, runtime falls back to auto-detected local models.
    LOCAL_CV_MODEL: str = ""
    LOCAL_SCORING_MODEL: str = ""

    # APILayer Resume Parser — https://apilayer.com/marketplace/resume_parser-api
    APILAYER_API_KEY: str = ""

    @model_validator(mode="before")
    def coerce_debug(cls, data):
        val = data.get("DEBUG")
        if isinstance(val, str):
            data["DEBUG"] = val.lower() in ("1", "true", "yes", "on")
        return data

    @model_validator(mode="after")
    def build_database_url(self) -> "Settings":
        if not self.DATABASE_URL:
            if not self.DB_PASSWORD:
                raise ValueError("DB_PASSWORD is required when DATABASE_URL is not set")
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
