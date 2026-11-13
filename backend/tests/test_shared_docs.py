"""Shared docs folders (WICKD_SHARED_DOCS_PATHS): helpers, routes, settings and watcher."""

import asyncio
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from watchfiles import Change

from app.api import settings as settings_api
from app.config import settings
from app.docs_pages import shared
from app.docs_pages.service import DocsPagesError
from app.events.bus import bus
from app.main import app
from app.watcher.service import WatcherManager, build_plan, is_relevant, shared_docs_changes


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def isolate(monkeypatch: pytest.MonkeyPatch) -> list[bool]:
    """No env var setting; record watcher resyncs instead of reading the app's own DB."""
    monkeypatch.setattr(settings, "shared_docs_paths", None)
    resyncs: list[bool] = []

    async def fake_resync() -> None:
        resyncs.append(True)

    monkeypatch.setattr(settings_api, "_resync_watcher", fake_resync)
    return resyncs


def _docs(tmp_path: Path, name: str = "dbt/docs") -> Path:
    root = tmp_path.resolve() / name
    (root / "img").mkdir(parents=True)
    (root / "index.md").write_text("# Team handbook\n\nSee ![d](img/d.png) and [orders](ref:orders)\n")
    (root / "img" / "d.png").write_bytes(b"\x89PNG")
    (root / "evil.svg").write_text("<svg><script>alert(1)</script></svg>")
    return root


def test_split_and_folders(tmp_path: Path) -> None:
    docs = _docs(tmp_path)
    raw = f" {tmp_path}/missing , {docs},,relative/dir "
    assert shared.split_paths(raw) == [f"{tmp_path}/missing", str(docs), "relative/dir"]
    folders = shared.shared_folders(raw)
    # ids are setting positions, so a missing folder doesn't shift later ones
    assert folders == [shared.SharedFolder(1, "dbt/docs", docs)]
    assert shared.find_folder(raw, 1).path == docs
    with pytest.raises(DocsPagesError):
        shared.find_folder(raw, 0)


def test_normalize_setting(tmp_path: Path) -> None:
    docs = _docs(tmp_path)
    assert shared.normalize_setting(f" {docs} ,") == str(docs)
    assert shared.normalize_setting("") == ""
    with pytest.raises(DocsPagesError, match="absolute"):
        shared.normalize_setting("docs")
    with pytest.raises(DocsPagesError, match="not found"):
        shared.normalize_setting(f"{tmp_path}/missing")


async def test_settings_round_trip_and_validation(client: AsyncClient, tmp_path: Path, isolate: list[bool]) -> None:
    docs = _docs(tmp_path)
    assert (await client.get("/api/settings")).json()["shared_docs_paths"] is None
    res = await client.put("/api/settings", json={"shared_docs_paths": f"{docs} ,"})
    assert res.status_code == 200
    assert res.json()["shared_docs_paths"] == str(docs)
    assert isolate == [True]  # the watcher picks up the new folder right away
    bad = await client.put("/api/settings", json={"shared_docs_paths": f"{tmp_path}/missing"})
    assert bad.status_code == 400
    assert (await client.get("/api/settings")).json()["shared_docs_paths"] == str(docs)
    cleared = await client.put("/api/settings", json={"shared_docs_paths": ""})
    assert cleared.json()["shared_docs_paths"] is None


async def test_env_var_fallback(client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    docs = _docs(tmp_path)
    monkeypatch.setattr(settings, "shared_docs_paths", str(docs))
    body = (await client.get("/api/workspace/docs-pages")).json()
    assert [f["name"] for f in body["folders"]] == ["dbt/docs"]


async def test_list_content_and_assets(client: AsyncClient, tmp_path: Path) -> None:
    docs = _docs(tmp_path)
    await client.put("/api/settings", json={"shared_docs_paths": str(docs)})

    body = (await client.get("/api/workspace/docs-pages")).json()
    assert body == {"folders": [{
        "id": 0, "name": "dbt/docs", "path": str(docs),
        "pages": [{"path": "index.md", "title": "Team handbook", "folder": ""}],
    }]}

    page = (await client.get("/api/workspace/docs-pages/0/content", params={"path": "index.md"})).json()
    assert page["title"] == "Team handbook"
    assert page["project_path"] is None
    assert page["segments"][0]["kind"] == "markdown"

    img = await client.get("/api/workspace/docs-pages/0/asset", params={"path": "img/d.png"})
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"
    svg = await client.get("/api/workspace/docs-pages/0/asset", params={"path": "evil.svg"})
    assert "default-src 'none'" in svg.headers["content-security-policy"]


async def test_refuses_escapes_and_unknown_folders(client: AsyncClient, tmp_path: Path) -> None:
    docs = _docs(tmp_path)
    (docs.parent / "secret.md").write_text("# secret")
    await client.put("/api/settings", json={"shared_docs_paths": str(docs)})
    escape = await client.get("/api/workspace/docs-pages/0/content", params={"path": "../secret.md"})
    assert escape.status_code == 400
    assert (await client.get("/api/workspace/docs-pages/0/asset", params={"path": "index.md"})).status_code == 400
    assert (await client.get("/api/workspace/docs-pages/5/content", params={"path": "index.md"})).status_code == 404
    missing = await client.get("/api/workspace/docs-pages/0/content", params={"path": "nope.md"})
    assert missing.status_code == 404


def test_watch_plan_includes_shared_folders(tmp_path: Path) -> None:
    docs = _docs(tmp_path)
    plan = build_plan([], None, None, str(docs))
    assert plan.shared_docs == ((0, docs),)
    assert docs in plan.roots
    assert is_relevant(plan, docs / "guide.md")
    assert not is_relevant(plan, docs / "node_modules" / "x.md")
    changes = {(Change.modified, str(docs / "guide.md")), (Change.added, str(docs / "notes.txt"))}
    assert shared_docs_changes(plan, changes) == {0: ["guide.md"]}


async def test_shared_changes_published_on_global_stream(tmp_path: Path) -> None:
    docs = _docs(tmp_path)
    plan = build_plan([], None, None, str(docs))
    queue = await bus.subscribe("global")
    try:
        await WatcherManager()._publish_shared_docs(plan, {(Change.modified, str(docs / "index.md"))})
        event = await asyncio.wait_for(queue.get(), timeout=2.0)
        assert (event.type, event.data) == ("docs_pages_changed", {"shared_folder": 0, "paths": ["index.md"]})
    finally:
        await bus.unsubscribe("global", queue)
