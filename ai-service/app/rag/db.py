from collections.abc import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

# Shared SQLAlchemy engine/session for RAG persistence.
engine = create_engine(settings.DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def init_vector_extension() -> None:
    # pgvector's `vector` type must exist before creating vector columns.
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))


def get_db() -> Generator[Session, None, None]:
    # FastAPI dependency-style generator for transactional DB access.
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
