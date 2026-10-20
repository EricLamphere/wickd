import json
import os
import textwrap
from datetime import UTC, datetime
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.db.engine import get_session
from app.db.models import RunInvocation
from app.main import app
from app.projects import summary
from app.projects.summary import NodeCounts, manifest_node_counts


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _write_manifest(project: Path, nodes: dict, sources: dict | None = None) -> Path:
    target = project / "target"
    target.mkdir(parents=True, exist_ok=True)
    path = target / "manifest.json"
    path.write_text(json.dumps({"nodes": nodes, "sources": sources or {}}))
    return path


def _make_project(root: Path, subdir: str, name: str) -> Path:
    d = root / subdir
    d.mkdir(parents=True)
    (d / "dbt_project.yml").write_text(textwrap.dedent(f"name: {name}\nprofile: p\n"))
    return d


SAMPLE_NODES = {
    "model.p.a": {"resource_type": "model"},
    "model.p.b": {"resource_type": "model"},
    "seed.p.s": {"resource_type": "seed"},
    "test.p.t1": {"resource_type": "test"},
    "test.p.t2": {"resource_type": "test"},
    "test.p.t3": {"resource_type": "test"},
    "snapshot.p.snap": {"resource_type": "snapshot"},
}


def test_manifest_node_counts(tmp_path: Path) -> None:
    _write_manifest(tmp_path, SAMPLE_NODES, {"source.p.x.y": {}})
    assert manifest_node_counts(tmp_path) == NodeCounts(models=2, sources=1, seeds=1, tests=3)


def test_manifest_node_counts_missing_or_bad(tmp_path: Path) -> None:
    assert manifest_node_counts(tmp_path) is None
    (tmp_path / "target").mkdir()
    (tmp_path / "target" / "manifest.json").write_text("{not json")
    assert manifest_node_counts(tmp_path) is None


def test_manifest_node_counts_cached_until_file_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _write_manifest(tmp_path, SAMPLE_NODES)
    first = manifest_node_counts(tmp_path)

    calls = 0
    real_loads = summary.json.loads

    def counting_loads(*args, **kwargs):
        nonlocal calls
        calls += 1
        return real_loads(*args, **kwargs)

    monkeypatch.setattr(summary.json, "loads", counting_loads)
    assert manifest_node_counts(tmp_path) == first
    assert calls == 0

    _write_manifest(tmp_path, {"model.p.only": {"resource_type": "model"}})
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    assert manifest_node_counts(tmp_path) == NodeCounts(models=1, sources=0, seeds=0, tests=0)
    assert calls == 1


async def test_summaries_endpoint(
    client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "dbt_projects_path", tmp_path)
    built = _make_project(tmp_path, "built", "built")
    _make_project(tmp_path, "fresh", "fresh")
    _write_manifest(built, SAMPLE_NODES)

    projects = (await client.get("/api/projects")).json()
    ids = {p["name"]: p["id"] for p in projects}

    session_gen = app.dependency_overrides[get_session]()
    session = await session_gen.__anext__()
    t1 = datetime(2026, 1, 1, tzinfo=UTC)
    t2 = datetime(2026, 1, 2, tzinfo=UTC)
    session.add_all([
        RunInvocation(project_id=ids["built"], command="run", status="error", started_at=t1, finished_at=t1),
        RunInvocation(project_id=ids["built"], command="build", status="success", started_at=t2, finished_at=t2),
    ])
    await session.commit()
    await session_gen.aclose()

    resp = await client.get("/api/projects/summaries")
    assert resp.status_code == 200
    by_id = {s["project_id"]: s for s in resp.json()}

    assert by_id[ids["built"]]["counts"] == {"models": 2, "sources": 0, "seeds": 1, "tests": 3}
    assert by_id[ids["built"]]["latest_run"]["status"] == "success"
    assert by_id[ids["fresh"]] == {"project_id": ids["fresh"], "counts": None, "latest_run": None}
