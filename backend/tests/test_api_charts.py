"""dbt Charts routes: listing, static builds (path-safe), build events, live and export gating."""

import asyncio
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api import charts as charts_api
from app.charts import build as builds
from app.charts.env import ChartsUnavailable, DctContext
from app.config import settings
from app.db.engine import get_session
from app.db.models import Base, Project
from app.events.bus import bus
from app.main import app


@pytest.fixture
async def sessions(tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'charts.sqlite'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with maker() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    yield maker
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def project(sessions, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Project:
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    root = tmp_path / "shop"
    (root / "charts").mkdir(parents=True)
    (root / "charts" / "sales.yml").write_text("title: Sales\ncharts:\n  a: {type: kpi}\nrows: [a]\n")
    (root / "charts" / "broken.yml").write_text("title: [\n")
    async with sessions() as session:
        p = Project(name="shop", path=str(root))
        session.add(p)
        await session.commit()
        await session.refresh(p)
        return p


async def test_list_boards(client, project: Project) -> None:
    res = await client.get(f"/api/projects/{project.id}/charts")
    assert res.status_code == 200
    body = res.json()
    assert body["has_charts_dir"] is True
    assert [b["id"] for b in body["boards"]] == ["broken", "sales"]
    assert body["boards"][1]["build"] is None and body["boards"][1]["building"] is False
    assert body["live"] == {"running": False, "port": None}


async def test_static_before_and_after_a_build(client, project: Project) -> None:
    res = await client.get(f"/api/projects/{project.id}/charts/static", params={"board": "sales"})
    assert res.status_code == 404
    folder = builds.board_dir(project.id, "sales")
    folder.mkdir(parents=True)
    (folder / builds.OUTPUT_FILE).write_text("<html>ok</html>")
    res = await client.get(f"/api/projects/{project.id}/charts/static", params={"board": "sales"})
    assert res.status_code == 200 and res.text == "<html>ok</html>"
    res = await client.get(f"/api/projects/{project.id}/charts/static", params={"board": "../../shop"})
    assert res.status_code == 404


async def test_build_publishes_events(client, project: Project, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_context(project_id: int, path: Path) -> DctContext:
        return DctContext(dct=Path("dct"), env={}, project_path=path, target=None, adapter_type="duckdb")

    async def fake_build(project_id: int, ctx: DctContext, board) -> builds.BuildResult:
        return builds.BuildResult(ok=True, built_at="now", target=None, elapsed_ms=1, has_output=True)

    monkeypatch.setattr(charts_api, "dct_context", fake_context)
    monkeypatch.setattr(builds, "build_board", fake_build)
    queue = await bus.subscribe(f"project:{project.id}")
    try:
        res = await client.post(f"/api/projects/{project.id}/charts/build", params={"board": "sales"})
        assert res.status_code == 202
        started = await asyncio.wait_for(queue.get(), timeout=2)
        finished = await asyncio.wait_for(queue.get(), timeout=2)
    finally:
        await bus.unsubscribe(f"project:{project.id}", queue)
    assert (started.type, started.data) == ("charts_build_started", {"board": "sales"})
    assert finished.type == "charts_build_finished" and finished.data["ok"] is True


async def test_build_refuses_unknown_and_invalid_boards(client, project: Project) -> None:
    assert (await client.post(f"/api/projects/{project.id}/charts/build", params={"board": "nope"})).status_code == 404
    res = await client.post(f"/api/projects/{project.id}/charts/build", params={"board": "broken"})
    assert res.status_code == 422 and res.json()["detail"]["error"] == "board_invalid"


async def test_unsupported_adapter_is_a_409(client, project: Project, monkeypatch: pytest.MonkeyPatch) -> None:
    async def unsupported(project_id: int, path: Path) -> DctContext:
        raise ChartsUnavailable("unsupported_adapter", "dbt Charts can't connect to `oracle` warehouses.")

    monkeypatch.setattr(charts_api, "dct_context", unsupported)
    res = await client.post(f"/api/projects/{project.id}/charts/live")
    assert res.status_code == 409 and res.json()["detail"]["error"] == "unsupported_adapter"


async def test_touch_without_a_server(client, project: Project) -> None:
    res = await client.post(f"/api/projects/{project.id}/charts/live/touch")
    assert res.json() == {"running": False}
