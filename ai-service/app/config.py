import os
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

    class Config:
        env_file = ".env"

settings = Settings()
