from fastapi import FastAPI
import os
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.semconv.resource import ResourceAttributes
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from sqlalchemy.exc import SQLAlchemyError

from app.config import settings
from app.api import parsing, rag, generation, scoring
from app.utils.logger import logger
from app.rag.models import init_rag_schema

# Initialize Tracing
resource = Resource(attributes={
    ResourceAttributes.SERVICE_NAME: os.getenv("OTEL_SERVICE_NAME", "ai-service")
})

provider = TracerProvider(resource=resource)
processor = BatchSpanProcessor(OTLPSpanExporter(endpoint=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://cv-otel-collector:4317")))
provider.add_span_processor(processor)
trace.set_tracer_provider(provider)

app = FastAPI(title=settings.APP_NAME, debug=settings.DEBUG)

# Instrument FastAPI
FastAPIInstrumentor.instrument_app(app)

# Include routers
app.include_router(parsing.router, prefix=f"{settings.API_V1_STR}/parsing", tags=["parsing"])
app.include_router(rag.router, prefix=f"{settings.API_V1_STR}/rag", tags=["rag"])
app.include_router(generation.router, prefix=f"{settings.API_V1_STR}/generation", tags=["generation"])
app.include_router(scoring.router, prefix=f"{settings.API_V1_STR}/scoring", tags=["scoring"])

@app.on_event("startup")
async def startup_event():
    logger.info("Starting up AI Service...")
    app.state.rag_schema_ready = False

    if not settings.RAG_INIT_ON_STARTUP:
        logger.info("Skipping RAG schema initialization on startup.")
        return

    try:
        init_rag_schema()
        app.state.rag_schema_ready = True
        logger.info("RAG schema initialized.")
    except (SQLAlchemyError, OSError) as exc:
        if settings.RAG_STARTUP_REQUIRED:
            raise
        logger.warning(
            "RAG schema initialization skipped because the database is unavailable: %s",
            exc,
        )

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down AI Service...")

@app.get("/")
async def root():
    return {"message": "Welcome to the AI CV Parser Service"}
