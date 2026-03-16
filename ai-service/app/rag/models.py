from typing import Any
from uuid import UUID

from pgvector.sqlalchemy import Vector
from sqlalchemy import Text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID
from sqlalchemy.ext.mutable import MutableDict
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.config import settings
from app.rag.db import engine, init_vector_extension


class Base(DeclarativeBase):
    # Base declarative class for all RAG DB models.
    pass


class EmployeeRagVector(Base):
    # Vectorized employee profile snapshot used by RAG retrieval. One row per section chunk.
    __tablename__ = "employee_rag_vectors"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # user_id is NOT unique — multiple chunks (one per section) exist per user
    user_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), nullable=False, index=True)
    # Identifies the specific chunk, e.g. "<uuid>_certifications". Used for upsert logic.
    chunk_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True, index=True, default="")
    content: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSONB),
        nullable=False,
        default=dict,
    )
    embedding: Mapped[list[float]] = mapped_column(Vector(settings.EMBEDDING_DIM), nullable=False)


def init_rag_schema() -> None:
    """Ensure pgvector extension and the RAG table exist.
    
    If the table exists with the old schema (unique user_id), it is dropped
    and recreated so multiple chunks per user are supported.
    """
    init_vector_extension()
    # Drop and recreate if the old single-row-per-user schema is present
    with engine.connect() as conn:
        has_old_unique = conn.execute(
            __import__("sqlalchemy", fromlist=["text"]).text(
                "SELECT 1 FROM pg_indexes "
                "WHERE tablename='employee_rag_vectors' "
                "AND indexname='ix_employee_rag_vectors_user_id' "
                "AND indexdef LIKE '%UNIQUE%'"
            )
        ).fetchone()
        if has_old_unique:
            conn.execute(__import__("sqlalchemy", fromlist=["text"]).text(
                "DROP TABLE IF EXISTS employee_rag_vectors CASCADE"
            ))
            conn.commit()
    Base.metadata.create_all(bind=engine)
