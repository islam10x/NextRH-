from fastapi import BackgroundTasks, FastAPI
from app.config import settings
from app.api import parsing, rag
from app.utils.logger import logger
from app.rag.models import init_rag_schema
from app.rag.etl_ingest import trigger_embedding_pipeline, sync_metadata_files_to_qdrant

app = FastAPI(title=settings.APP_NAME, debug=settings.DEBUG)

@app.get("/debug-check")
def debug_check():
    return {"status": "SUCCESS", "directory": "ai-service/app/main.py"}

@app.get("/test-path")
def test_path():
    return {"message": "Main file is active"}

# Include routers
app.include_router(parsing.router, prefix=f"{settings.API_V1_STR}/parsing", tags=["parsing"])
app.include_router(rag.router, prefix=f"{settings.API_V1_STR}/rag", tags=["rag"])

@app.on_event("startup")
async def startup_event():
    logger.info("Starting up AI Service...")
    # Ensure RAG DB schema is available before serving requests.
    init_rag_schema()
    logger.info("RAG schema initialized.")
    try:
        logger.info("Syncing metadata.json files into Qdrant...")
        sync_metadata_files_to_qdrant()
        logger.info("Qdrant sync complete.")
    except Exception as exc:
        logger.error(f"Failed to sync metadata.json into Qdrant: {exc}")

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down AI Service...")

@app.get("/")
async def root():
    return {"message": "Welcome to the AI CV Parser Service"}
