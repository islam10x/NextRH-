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
    # Vectorized employee profile snapshot used by RAG retrieval.
    __tablename__ = "employee_rag_vectors"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), nullable=False, unique=True, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSONB),
        nullable=False,
        default=dict,
    )
    embedding: Mapped[list[float]] = mapped_column(Vector(settings.EMBEDDING_DIM), nullable=False)


def init_rag_schema() -> None:
    # Create extension first, then materialize ORM tables.
    init_vector_extension()
    Base.metadata.create_all(bind=engine)
