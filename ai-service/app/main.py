from fastapi import FastAPI
from app.config import settings
from app.api import parsing, rag
from app.utils.logger import logger
from app.rag.models import init_rag_schema

app = FastAPI(title=settings.APP_NAME, debug=settings.DEBUG)

# Include routers
app.include_router(parsing.router, prefix=f"{settings.API_V1_STR}/parsing", tags=["parsing"])
app.include_router(rag.router, prefix=f"{settings.API_V1_STR}/rag", tags=["rag"])

@app.on_event("startup")
async def startup_event():
    logger.info("Starting up AI Service...")
    # Ensure RAG DB schema is available before serving requests.
    init_rag_schema()
    logger.info("RAG schema initialized.")

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down AI Service...")

@app.get("/")
async def root():
    return {"message": "Welcome to the AI CV Parser Service"}
