"""
Shared pytest fixtures that wire up a fresh in-memory SQLite DB per test
and patch the FastAPI dependency so every test gets a clean slate.
"""
import importlib

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base
from app.main import app

# Modules that bind SessionLocal at import time (`from app.db.engine import SessionLocal` at
# module level); function-local imports read app.db.engine.SessionLocal and need no entry.
_MODULES_BINDING_SESSION_LOCAL = (
    "app.main",
    "app.api.runs",
    "app.watcher.service",
    "app.dbt.slim_prune",
    "app.db.migrations",
)


@pytest.fixture(autouse=True)
async def override_db(monkeypatch: pytest.MonkeyPatch):
    """Create a fresh in-memory DB, wire it into FastAPI DI and every SessionLocal, tear
    down after. Code that opens its own session (background jobs, load_project_env) would
    otherwise hit the real data/wickd.sqlite: passing locally, failing in CI's empty DB."""
    test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    TestSessionLocal = async_sessionmaker(
        test_engine, expire_on_commit=False, class_=AsyncSession
    )

    async def _get_test_session():
        async with TestSessionLocal() as session:
            yield session

    app.dependency_overrides[get_session] = _get_test_session
    monkeypatch.setattr(db_engine, "SessionLocal", TestSessionLocal)
    for name in _MODULES_BINDING_SESSION_LOCAL:
        monkeypatch.setattr(importlib.import_module(name), "SessionLocal", TestSessionLocal)

    yield

    app.dependency_overrides.pop(get_session, None)
    await test_engine.dispose()


@pytest.fixture(autouse=True)
def clear_semantic_memo():
    """explain/catalog answers are memoized per semantic manifest content; tests stub the sidecar
    with different answers for the same fixture manifest."""
    from app.semantic import service

    service._memo.clear()
    yield
    service._memo.clear()
