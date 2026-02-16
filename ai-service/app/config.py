from pydantic import model_validator
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    APP_NAME: str = "AI CV Parser Service"
    DEBUG: bool = True
    API_V1_STR: str = "/api/v1"
    
    # Paths
    UPLOAD_FOLDER: str = "uploads"
    TEMPLATE_FOLDER: str = "templates"
    
    # OCR Settings
    OCR_ENGINE: str = "tesseract" # or easyocr
    
    # Backend Integration
    BACKEND_URL: str = "http://localhost:3000"

    # Reuse the same PostgreSQL settings used by the main backend when needed.
    DB_HOST: str = "127.0.0.1"
    DB_PORT: int = 5433
    DB_USER: str = "postgres"
    DB_PASSWORD: str = "change_me"
    DB_NAME: str = "cv_management"

    # Optional explicit URL. If omitted, it is derived from DB_* fields above.
    DATABASE_URL: str | None = None
    # Embedding size expected by pgvector column definition.
    EMBEDDING_DIM: int = 768
    # Ollama embedding model config used by RAG ingestion.
    OLLAMA_URL: str = "http://127.0.0.1:11434"
    EMBEDDING_MODEL: str = "nomic-embed-text"
    # Comma-separated candidate roots for employee metadata.json files.
    RAG_METADATA_ROOTS: str = "backend/local-storage,backend/file-storage/CV_Database"

    @model_validator(mode="after")
    def build_database_url(self) -> "Settings":
        if not self.DATABASE_URL:
            self.DATABASE_URL = (
                f"postgresql+psycopg://{self.DB_USER}:{self.DB_PASSWORD}"
                f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
            )
        return self

    class Config:
        env_file = ".env"

settings = Settings()
