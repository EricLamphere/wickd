"""Docs pages routes (plan 28)."""

import json
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.engine import get_session
from app.db.models import Base, Project, ProjectEnvVar
from app.main import app


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with sessions() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    async with sessions() as session:
        yield session
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _project(db: AsyncSession, tmp_path: Path, *, docs: bool = True) -> tuple[int, Path]:
    root = tmp_path.resolve() / "proj"
    (root / "target").mkdir(parents=True)
    if docs:
        (root / "docs" / "img").mkdir(parents=True)
        (root / "docs" / "index.md").write_text("# Home\n\nSee ![d](img/d.png)\n")
        (root / "docs" / "mixed.md").write_text("# Mixed\n{% docs status %}Order status{% enddocs %}\n")
        (root / "docs" / "img" / "d.png").write_bytes(b"\x89PNG")
        (root / "docs" / "evil.svg").write_text("<svg><script>alert(1)</script></svg>")
        (root / "docs" / "notes.txt").write_text("x")
    (root / "logo.png").write_bytes(b"\x89PNG")
    (root / "target" / "manifest.json").write_text(json.dumps({
        "docs": {"doc.proj.status": {"name": "status", "block_contents": "Order status"}},
        "nodes": {"model.proj.orders": {"resource_type": "model", "doc_blocks": ["doc.proj.status"], "columns": {}}},
    }))
    project = Project(name="proj", path=str(root), platform="duckdb")
    db.add(project)
    await db.commit()
    return project.id, root


async def test_list_pages(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, _ = await _project(db, tmp_path)
    body = (await client.get(f"/api/projects/{pid}/docs-pages")).json()
    assert body["dir"] == "docs"
    assert body["in_project"] is True
    assert body["setting"] == ""
    assert [p["path"] for p in body["pages"]] == ["index.md", "mixed.md"]


async def test_list_without_folder(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, _ = await _project(db, tmp_path, docs=False)
    body = (await client.get(f"/api/projects/{pid}/docs-pages")).json()
    assert body == {"dir": None, "in_project": False, "setting": "", "pages": []}


async def test_list_uses_setting(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, root = await _project(db, tmp_path)
    (root / "handbook").mkdir()
    (root / "handbook" / "a.md").write_text("# A\n")
    db.add(ProjectEnvVar(project_id=pid, key="DOCS_PATH", value="handbook"))
    await db.commit()
    body = (await client.get(f"/api/projects/{pid}/docs-pages")).json()
    assert body["dir"] == "handbook"
    assert [p["title"] for p in body["pages"]] == ["A"]


async def test_page_content_with_docs_block_usage(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, _ = await _project(db, tmp_path)
    resp = await client.get(f"/api/projects/{pid}/docs-pages/content", params={"path": "mixed.md"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["title"] == "Mixed"
    assert body["project_path"] == "docs/mixed.md"
    block = next(s for s in body["segments"] if s["kind"] == "docs_block")
    assert block == {"kind": "docs_block", "text": "Order status", "name": "status", "used_by": ["model.proj.orders"]}


@pytest.mark.parametrize(("path", "status"), [("../target/manifest.json", 400), ("notes.txt", 400), ("gone.md", 404)])
async def test_page_content_refusals(db: AsyncSession, client: AsyncClient, tmp_path: Path, path: str, status: int) -> None:
    pid, _ = await _project(db, tmp_path)
    resp = await client.get(f"/api/projects/{pid}/docs-pages/content", params={"path": path})
    assert resp.status_code == status


async def test_content_without_folder_is_404(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, _ = await _project(db, tmp_path, docs=False)
    resp = await client.get(f"/api/projects/{pid}/docs-pages/content", params={"path": "index.md"})
    assert resp.status_code == 404


async def test_assets(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, _ = await _project(db, tmp_path)
    url = f"/api/projects/{pid}/docs-pages/asset"

    png = await client.get(url, params={"path": "img/d.png"})
    assert png.status_code == 200
    assert png.headers["content-type"] == "image/png"

    svg = await client.get(url, params={"path": "evil.svg"})
    assert svg.status_code == 200
    assert "default-src 'none'" in svg.headers["content-security-policy"]

    assert (await client.get(url, params={"path": "index.md"})).status_code == 400
    assert (await client.get(url, params={"path": "../logo.png"})).status_code == 400
    assert (await client.get(url, params={"path": "missing.png"})).status_code == 404
    assert (await client.get(url, params={"path": "logo.png", "root": "project"})).status_code == 200
    assert (await client.get(url, params={"path": "../x.png", "root": "project"})).status_code == 400
