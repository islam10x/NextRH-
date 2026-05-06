import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy.exc import SQLAlchemyError

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.main as main


def test_startup_skips_rag_init_when_db_is_unavailable_and_optional():
    main.app.state.rag_schema_ready = True

    with patch.object(main.settings, "RAG_INIT_ON_STARTUP", True), patch.object(
        main.settings, "RAG_STARTUP_REQUIRED", False
    ), patch("app.main.init_rag_schema", side_effect=SQLAlchemyError("db unavailable")):
        asyncio.run(main.startup_event())

    assert main.app.state.rag_schema_ready is False


def test_startup_raises_when_rag_init_is_required():
    main.app.state.rag_schema_ready = False

    with patch.object(main.settings, "RAG_INIT_ON_STARTUP", True), patch.object(
        main.settings, "RAG_STARTUP_REQUIRED", True
    ), patch("app.main.init_rag_schema", side_effect=SQLAlchemyError("db unavailable")):
        with pytest.raises(SQLAlchemyError):
            asyncio.run(main.startup_event())