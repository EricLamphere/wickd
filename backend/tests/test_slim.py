"""Slim builds (plan 18): state source, run args, preview, clone and retry."""

import json
import os
import time
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.api.runs as runs_module
import app.api.slim as slim_api
import app.db.engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, ColumnLineageSnapshot, Project, ProjectEnvVar, RunInvocation
from app.dbt import slim_preview, slim_prune, state
from app.dbt.slim_preview import Listed
from app.licensing import entitlements
from app.main import app


@pytest.fixture
async def db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'test.sqlite'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    for module in (db_engine, runs_module, slim_prune):
        monkeypatch.setattr(module, "SessionLocal", factory)
    yield factory
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _manifest(version: str = "1.9.0", **extra) -> dict:
    return {"metadata": {"dbt_schema_version": "v12", "dbt_version": version, "generated_at": "2026-11-01T00:00:00Z"}, **extra}


@pytest.fixture
def prod(tmp_path: Path) -> Path:
    folder = tmp_path / "prod"
    folder.mkdir()
    (folder / "manifest.json").write_text(json.dumps(_manifest()))
    return folder


async def _project(db, tmp_path: Path, env: dict[str, str]) -> Project:
    path = tmp_path / "proj"
    (path / "target").mkdir(parents=True, exist_ok=True)
    async with db() as session:
        project = Project(name="proj", path=str(path), platform="duckdb")
        session.add(project)
        await session.commit()
        for key, value in env.items():
            session.add(ProjectEnvVar(project_id=project.id, key=key, value=value))
        await session.commit()
        return project


# ── pure helpers ──────────────────────────────────────────────────────────────

def test_parse_state_source():
    assert state.parse_state_source(None) == state.StateSource("git", None)
    assert state.parse_state_source("git:main") == state.StateSource("git", "main")
    assert state.parse_state_source("path:/srv/prod") == state.StateSource("path", "/srv/prod")
    for bad in ("main", "s3:bucket", "path:"):
        with pytest.raises(state.StateError):
            state.parse_state_source(bad)


def test_defer_and_state_args(tmp_path: Path):
    assert state.parse_defer("") == (False, False)
    assert state.parse_defer("defer") == (True, False)
    assert state.parse_defer("favor") == (True, True)
    compare, prod = tmp_path / "active", tmp_path / "prod"
    resolved = state.StateDir(path=compare, kind="git", ref="main", folder=None, sha="abc", target="prod",
                              generated_at=None, dbt_version=None, defer_path=prod)
    assert state.state_args(resolved, state=False, defer=False, favor_state=True) == ()
    assert state.state_args(resolved, state=True, defer=False, favor_state=False) == ("--state", str(compare))
    # selection compares with the active-target parse; defer reads prod's relations
    assert state.state_args(resolved, state=True, defer=True, favor_state=True) == (
        "--state", str(compare), "--defer", "--defer-state", str(prod), "--favor-state")
    same = state.StateDir(path=compare, kind="path", ref=None, folder=str(compare), sha=None, target=None,
                          generated_at=None, dbt_version=None)
    assert state.state_args(same, state=False, defer=True, favor_state=False) == ("--defer", "--defer-state", str(compare))


def test_validate_folder(tmp_path: Path, prod: Path):
    project = tmp_path / "proj"
    (project / "target").mkdir(parents=True)
    with pytest.raises(state.StateError, match="doesn't exist"):
        state.validate_folder(str(tmp_path / "nope"), project)
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(state.StateError, match="no manifest.json"):
        state.validate_folder(str(empty), project)
    (empty / "manifest.json").write_text("{}")
    with pytest.raises(state.StateError, match="doesn't look like"):
        state.validate_folder(str(empty), project)
    assert state.validate_folder(str(prod), project).notes == ()
    (project / "target" / "manifest.json").write_text(json.dumps(_manifest("1.10.2")))
    assert "another minor version" in state.validate_folder(str(prod), project).notes[0]


def test_ls_output_downstream_and_selectors():
    out = '12:00:01  Running with dbt=1.9.0\n{"unique_id": "model.p.a", "name": "a"}\nnot json {\n{"unique_id": "model.p.a"}'
    assert slim_preview.parse_ls_output(out) == ["model.p.a"]
    child_map = {"model.p.a": ["model.p.b", "test.p.t"], "model.p.b": ["model.p.c"]}
    assert slim_preview.downstream(["model.p.a"], child_map) == ["model.p.a", "model.p.b", "test.p.t", "model.p.c"]
    manifest = {
        "nodes": {
            "model.p.a": {"name": "a", "resource_type": "model"},
            "model.p.v": {"name": "v", "resource_type": "model", "version": 2},
            "test.p.t": {"name": "t", "resource_type": "test"},
            "model.p.k": {"name": "k", "resource_type": "model", "config": {"contract": {"enforced": True}}},
        },
        "sources": {"source.p.raw.orders": {"name": "orders", "source_name": "raw", "resource_type": "source"}},
        "exposures": {"exposure.p.e": {"name": "e", "resource_type": "exposure"}},
    }
    uids = ["model.p.a", "model.p.v", "test.p.t", "source.p.raw.orders", "exposure.p.e"]
    assert slim_preview.exact_selector(manifest, uids) == "a source:raw.orders v.v2"
    assert slim_preview.is_protected(manifest, "model.p.k") and slim_preview.is_protected(manifest, "model.p.v")
    assert not slim_preview.is_protected(manifest, "model.p.a")
    assert slim_preview.compare_with_git(manifest, ["model.p.a", "test.p.t"], ["model.p.v"]) == (["a"], ["v"])
    assert slim_preview.compare_with_git(manifest, ["source.p.raw.orders"], []) == (["source:raw.orders"], [])


# ── runs: state / defer flags ─────────────────────────────────────────────────

async def test_sticky_defer_adds_state_and_defer_to_builds(db, client, tmp_path: Path, prod: Path, monkeypatch):
    project = await _project(db, tmp_path, {"STATE_SOURCE": f"path:{prod}", "state_defer": "favor"})
    launched = AsyncMock()
    monkeypatch.setattr(runs_module, "_run_dbt_and_persist", launched)
    r = await client.post(f"/api/projects/{project.id}/build", json={"model": "a"})
    assert r.status_code == 200
    run_state = launched.call_args.args[-1]
    assert run_state.args == ("--defer", "--defer-state", str(prod), "--favor-state")
    assert run_state.record["defer"] and run_state.record["kind"] == "path"

    # explicit override, and seed never defers
    await client.post(f"/api/projects/{project.id}/build", json={"model": "a", "defer": False})
    assert launched.call_args.args[-1].args == ()
    await client.post(f"/api/projects/{project.id}/seed", json={})
    assert launched.call_args.args[-1].args == ()


async def test_state_selector_needs_a_valid_source(db, client, tmp_path: Path, monkeypatch):
    project = await _project(db, tmp_path, {"STATE_SOURCE": f"path:{tmp_path / 'missing'}"})
    monkeypatch.setattr(runs_module, "_run_dbt_and_persist", AsyncMock())
    r = await client.post(f"/api/projects/{project.id}/build", json={"select": "state:modified+", "state": True})
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "missing_folder"


async def test_get_state_reports_folder(db, client, tmp_path: Path, prod: Path):
    project = await _project(db, tmp_path, {"STATE_SOURCE": f"path:{prod}"})
    r = await client.get(f"/api/projects/{project.id}/state")
    assert r.status_code == 200
    assert r.json()["kind"] == "path" and r.json()["dbt_version"] == "1.9.0"


# ── preview ───────────────────────────────────────────────────────────────────

LS_MANIFEST = {
    "nodes": {
        "model.p.a": {"name": "a", "resource_type": "model"},
        "model.p.b": {"name": "b", "resource_type": "model"},
        "model.p.c": {"name": "c", "resource_type": "model"},
        "test.p.t": {"name": "t", "resource_type": "test"},
    },
    "child_map": {"model.p.a": ["model.p.b", "model.p.c", "test.p.t"]},
    "parent_map": {"model.p.b": ["model.p.a"], "model.p.c": ["model.p.a"], "test.p.t": ["model.p.a"]},
}


async def test_preview_lists_state_selection(db, client, tmp_path: Path, prod: Path, monkeypatch):
    project = await _project(db, tmp_path, {"STATE_SOURCE": f"path:{prod}"})
    monkeypatch.setattr(slim_api, "list_state", AsyncMock(return_value=Listed(("model.p.a",), LS_MANIFEST)))
    r = await client.post(f"/api/projects/{project.id}/state/preview", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["select"] == "state:modified+" and body["needs_state"] and not body["pruned"]
    assert [n["name"] for n in body["nodes"]] == ["a", "b", "c"]
    assert body["nodes"][0]["changed"] and body["tests"] == 1


async def test_preview_prune_is_pro_and_uses_the_pruned_list(db, client, tmp_path: Path, prod: Path, monkeypatch):
    project = await _project(db, tmp_path, {"STATE_SOURCE": f"path:{prod}"})
    monkeypatch.setattr(slim_api, "list_state", AsyncMock(return_value=Listed(("model.p.a",), LS_MANIFEST)))

    async def deny(session, *, force: bool = False):
        return entitlements.Entitlement(entitled=False, reason="not_licensed")
    monkeypatch.setattr(entitlements, "check_entitlement", deny)
    r = await client.post(f"/api/projects/{project.id}/state/preview", json={"prune": True})
    assert r.status_code == 403

    async def allow(session, *, force: bool = False):
        return entitlements.Entitlement(entitled=True, reason="granted")
    monkeypatch.setattr(entitlements, "check_entitlement", allow)
    monkeypatch.setattr(slim_api.slim, "is_available", lambda: True)
    pruned = {"select": ["model.p.a", "model.p.b"],
              "kept": [{"unique_id": "model.p.a", "reason": "changed", "columns": ["x"]},
                       {"unique_id": "model.p.b", "reason": "reads changed columns", "columns": ["x"]}],
              "skipped": [{"unique_id": "model.p.c", "reason": "doesn't read the changed columns"}]}
    monkeypatch.setattr(slim_api, "smallest_selection", AsyncMock(return_value=pruned))
    body = (await client.post(f"/api/projects/{project.id}/state/preview", json={"prune": True})).json()
    assert body["pruned"] and not body["needs_state"] and body["select"] == "a b"
    c = next(n for n in body["nodes"] if n["name"] == "c")
    assert not c["selected"] and c["reason"] == "doesn't read the changed columns"


async def test_lineage_must_be_fresh_for_pruning(db, tmp_path: Path):
    project = await _project(db, tmp_path, {})
    manifest = Path(project.path) / "target" / "manifest.json"
    manifest.write_text("{}")
    assert await slim_prune.fresh_lineage(project) is None
    async with db() as session:
        session.add(ColumnLineageSnapshot(project_id=project.id, status="done", results_json='{"m": {}}',
                                          row_dependencies_json="{}", lineage_version=4,
                                          manifest_mtime=manifest.stat().st_mtime))
        await session.commit()
    assert await slim_prune.fresh_lineage(project) == ({"m": {}}, {})
    os.utime(manifest, (time.time() + 10, time.time() + 10))
    assert await slim_prune.fresh_lineage(project) is None


# ── clone / retry ─────────────────────────────────────────────────────────────

async def test_clone_passes_state(db, client, tmp_path: Path, prod: Path, monkeypatch):
    project = await _project(db, tmp_path, {"STATE_SOURCE": f"path:{prod}"})
    run = AsyncMock()
    monkeypatch.setattr(slim_api, "_run_invocation", run)
    r = await client.post(f"/api/projects/{project.id}/clone", json={"select": "orders", "full_refresh": True})
    assert r.status_code == 200
    spec = run.call_args.args[1]
    assert spec.command == "clone" and spec.extra == ("--state", str(prod), "--full-refresh")


async def _invocation(db, project: Project, status: str = "error") -> int:
    async with db() as session:
        inv = RunInvocation(project_id=project.id, command="build", status=status)
        session.add(inv)
        await session.commit()
        return inv.id


async def test_retry_only_the_last_run_with_its_results(db, client, tmp_path: Path, monkeypatch):
    project = await _project(db, tmp_path, {})
    first = await _invocation(db, project)
    last = await _invocation(db, project)
    run = AsyncMock()
    monkeypatch.setattr(slim_api, "_run_invocation", run)
    url = f"/api/projects/{project.id}/runs/retry"
    assert (await client.post(url, json={"invocation_id": first})).status_code == 409
    missing = await client.post(url, json={})
    assert missing.status_code == 409 and "missing" in missing.json()["detail"]
    results = Path(project.path) / "target" / "run_results.json"
    results.write_text(json.dumps({"args": {"which": "show"}}))
    assert "can't resume" in (await client.post(url, json={})).json()["detail"]
    results.write_text(json.dumps({"args": {"which": "build"}}))
    ok = await client.post(url, json={"invocation_id": last})
    assert ok.status_code == 200 and run.call_args.args[1].command == "retry"


async def test_history_marks_the_latest_failed_run_retryable(db, client, tmp_path: Path):
    project = await _project(db, tmp_path, {})
    await _invocation(db, project)
    last = await _invocation(db, project)
    items = (await client.get(f"/api/projects/{project.id}/run-history")).json()["items"]
    assert {i["id"]: i["retryable"] for i in items} == {last: True, last - 1: False}


async def test_preview_flags_missing_lineage(db, client, tmp_path: Path, prod: Path, monkeypatch):
    project = await _project(db, tmp_path, {"STATE_SOURCE": f"path:{prod}"})
    monkeypatch.setattr(slim_api, "list_state", AsyncMock(return_value=Listed(("model.p.a",), LS_MANIFEST)))

    async def allow(session, *, force: bool = False):
        return entitlements.Entitlement(entitled=True, reason="granted")
    monkeypatch.setattr(entitlements, "check_entitlement", allow)
    monkeypatch.setattr(slim_api.slim, "is_available", lambda: True)
    body = (await client.post(f"/api/projects/{project.id}/state/preview", json={"prune": True})).json()
    assert body["lineage_needed"] and not body["pruned"] and body["select"] == "state:modified+"
    assert any("Load column lineage" in n for n in body["notes"])


async def test_git_state_compares_on_the_active_target_and_defers_to_prod(monkeypatch, tmp_path: Path):
    """A source without a database differs per target; selection must not see that as a change."""
    from app.dbt.revisions import SideManifest

    parsed: list[str | None] = []

    async def side(project, *, ref, target):
        parsed.append(target)
        out = tmp_path / "parsed" / (target or "none")
        out.mkdir(parents=True, exist_ok=True)
        (out / "manifest.json").write_text(json.dumps(_manifest()))
        return SideManifest(out / "semantic_manifest.json", "a" * 40, target)

    monkeypatch.setattr(state, "side_manifest", side)
    monkeypatch.setattr(state.settings, "data_dir", tmp_path / "data")
    project = Project(id=7, name="p", path=str(tmp_path))
    resolved = await state.state_dir(project, {"STATE_SOURCE": "git:main", "DIFF_BASE_TARGET": "prod", "DBT_TARGET": "dev"})
    assert parsed == ["dev", "prod"]
    assert resolved.path.name.endswith("-dev") and resolved.relations_path.name.endswith("-prod")
    clone = await state.resolve_run_state(project, {"STATE_SOURCE": "git:main", "DIFF_BASE_TARGET": "prod", "DBT_TARGET": "dev"},
                                          "clone", state=True, defer=False, favor_state=False)
    assert clone.args == ("--state", str(resolved.relations_path))
