"""Lineage propagation routes: gating, stale lineage, description/tag proposals,
per-file partial accept. The Pro engine is faked (app.propagation.pro._pro)."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import yaml
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.ai import pro as ai_pro
from app.api import ai_proposals
from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, ColumnLineageSnapshot, Project, ProjectEnvVar
from app.licensing import entitlements
from app.main import app
from app.propagation import pro

SRC = "source.proj.raw.users"
STG = "model.proj.stg_users"
MART = "model.proj.mart_users"

SOURCES_YML = """version: 2
sources:
  - name: raw
    tables:
      - name: users
        columns:
          - name: id
            description: '{{ doc("user_id") }}'
          - name: email
            description: Email address.
            tags: [pii]
"""
STG_YML = """version: 2

models:
  - name: stg_users
    columns:
      - name: user_id
"""

MANIFEST = {
    "metadata": {"project_name": "proj"},
    "nodes": {
        STG: {
            "name": "stg_users", "resource_type": "model", "package_name": "proj",
            "original_file_path": "models/staging/stg_users.sql",
            "patch_path": "proj://models/staging/schema.yml",
            "columns": {"user_id": {"name": "user_id", "description": ""}},
        },
        MART: {
            "name": "mart_users", "resource_type": "model", "package_name": "proj",
            "original_file_path": "models/marts/mart_users.sql", "patch_path": None, "columns": {},
        },
    },
    "sources": {
        SRC: {
            "name": "users", "source_name": "raw", "resource_type": "source",
            "original_file_path": "models/staging/sources.yml",
            "columns": {
                "id": {"name": "id", "description": "Rendered user id."},
                "email": {"name": "email", "description": "Email address.", "tags": ["pii"]},
            },
        },
    },
    "exposures": {"exposure.proj.crm": {"name": "crm", "depends_on": {"nodes": [MART]}}},
}
LINEAGE = {
    STG: {"user_id": [{"node": SRC, "column": "id", "kind": "rename"}],
          "email": [{"node": SRC, "column": "email", "kind": "identity"}]},
    MART: {"email": [{"node": STG, "column": "email", "kind": "identity"}],
           "email_hash": [{"node": STG, "column": "email", "kind": "derived"}]},
}


def _fake_engine(calls: dict) -> SimpleNamespace:
    def inherit_descriptions(lineage, docs, *, allowed_kinds, unique_ids=None):
        calls["descriptions"] = {"allowed": set(allowed_kinds), "scope": unique_ids, "docs": docs}
        fills = [
            {"unique_id": STG, "column": "user_id", "description": "Rendered user id.",
             "source": {"node": SRC, "column": "id"}, "kind": "rename", "path": []},
            {"unique_id": STG, "column": "email", "description": "Email address.",
             "source": {"node": SRC, "column": "email"}, "kind": "identity", "path": []},
            {"unique_id": MART, "column": "email", "description": "Email address.",
             "source": {"node": SRC, "column": "email"}, "kind": "identity", "path": []},
        ]
        return {"fills": [f for f in fills if unique_ids is None or f["unique_id"] in unique_ids],
                "conflicts": [{"unique_id": MART, "column": "x", "candidates": []}]}

    def tag_flow(lineage, declared, tags, exposures):
        calls["tag_flow"] = {"declared": declared, "tags": tags, "exposures": exposures}
        return {
            "columns": [
                {"unique_id": SRC, "column": "email", "tag": "pii", "declared": True, "via_kind": None,
                 "path": [{"node": SRC, "column": "email"}]},
                {"unique_id": MART, "column": "email_hash", "tag": "pii", "declared": False,
                 "via_kind": "derived", "path": []},
            ],
            "exposures": [{"unique_id": "exposure.proj.crm", "name": "crm", "tag": "pii", "via": [MART]}],
        }

    def inherit_tags(lineage, declared, tags):
        calls["inherit_tags"] = tags
        return [{"unique_id": MART, "column": "email_hash", "tags": ["pii"], "via_kind": {"pii": "derived"}}]

    return SimpleNamespace(
        inherit_descriptions=inherit_descriptions, tag_flow=tag_flow, inherit_tags=inherit_tags
    )


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def db_session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'p.sqlite'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with sessions() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    monkeypatch.setattr(db_engine, "SessionLocal", sessions)
    async with sessions() as session:
        yield session
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


def _entitle(monkeypatch: pytest.MonkeyPatch, entitled: bool = True) -> None:
    async def _check(session, *, force: bool = False):
        return entitlements.Entitlement(entitled=entitled, reason="granted" if entitled else "not_licensed")

    monkeypatch.setattr(entitlements, "check_entitlement", _check)


@pytest.fixture
def calls(monkeypatch) -> dict:
    recorded: dict = {}
    monkeypatch.setattr(pro, "_pro", lambda: _fake_engine(recorded))
    monkeypatch.setattr(ai_pro, "is_available", lambda: True)
    _entitle(monkeypatch)
    return recorded


@pytest.fixture
def compiled(monkeypatch) -> AsyncMock:
    mock = AsyncMock()
    monkeypatch.setattr(ai_proposals, "_compile_model", mock)
    return mock


async def _project(session: AsyncSession, tmp_path: Path, lineage_version: int | None = 3) -> tuple[int, Path]:
    root = tmp_path / "proj"
    (root / "models" / "staging").mkdir(parents=True)
    (root / "models" / "marts").mkdir(parents=True)
    (root / "target").mkdir()
    (root / "target" / "manifest.json").write_text(json.dumps(MANIFEST))
    (root / "models" / "staging" / "sources.yml").write_text(SOURCES_YML)
    (root / "models" / "staging" / "schema.yml").write_text(STG_YML)
    project = Project(name="proj", path=str(root), platform="local")
    session.add(project)
    await session.commit()
    if lineage_version is not None:
        session.add(ColumnLineageSnapshot(
            project_id=project.id, status="done", results_json=json.dumps(LINEAGE),
            lineage_version=lineage_version,
        ))
        await session.commit()
    return project.id, root


async def _wait_status(client: AsyncClient, pid: int, proposal_id: int, status: str) -> dict:
    for _ in range(100):
        r = await client.get(f"/api/projects/{pid}/ai/proposals/{proposal_id}")
        if r.json()["status"] == status:
            return r.json()
        await asyncio.sleep(0.02)
    raise AssertionError(f"proposal never reached {status}: {r.json()}")


# ── gating + readiness ───────────────────────────────────────────────────────


async def test_routes_require_pro(client, db_session, tmp_path, monkeypatch):
    _entitle(monkeypatch, entitled=False)
    pid, _ = await _project(db_session, tmp_path)
    for r in (
        await client.get(f"/api/projects/{pid}/propagate/descriptions"),
        await client.post(f"/api/projects/{pid}/propagate/descriptions", json={}),
        await client.get(f"/api/projects/{pid}/lineage/tag-flow"),
        await client.post(f"/api/projects/{pid}/propagate/tags", json={}),
    ):
        assert r.status_code == 403
        assert r.json()["detail"]["error"] == "pro_feature_required"


async def test_503_without_pro_package(client, db_session, tmp_path, monkeypatch):
    _entitle(monkeypatch)
    pid, _ = await _project(db_session, tmp_path)

    def _missing():
        raise pro.PropagationUnavailable("missing")

    monkeypatch.setattr(pro, "_pro", _missing)
    assert (await client.get(f"/api/projects/{pid}/lineage/tag-flow")).status_code == 503


@pytest.mark.parametrize(("version", "reason"), [(None, "missing"), (2, "outdated")])
async def test_409_until_lineage_records_kinds(client, db_session, calls, tmp_path, version, reason):
    pid, _ = await _project(db_session, tmp_path, lineage_version=version)
    r = await client.get(f"/api/projects/{pid}/propagate/descriptions")
    assert r.status_code == 409
    assert r.json()["detail"] == {"error": "lineage_not_ready", "reason": reason}


# ── descriptions ─────────────────────────────────────────────────────────────


async def test_preview_counts_fillable_columns(client, db_session, calls, tmp_path):
    pid, _ = await _project(db_session, tmp_path)
    r = await client.get(f"/api/projects/{pid}/propagate/descriptions", params={"include_casts": "false"})
    assert r.json() == {"fillable": 3, "conflicts": 1, "by_node": {STG: 2, MART: 1}}
    assert calls["descriptions"]["allowed"] == {"identity", "rename"}
    assert set(calls["descriptions"]["scope"]) == {STG, MART}
    assert calls["descriptions"]["docs"][SRC]["id"] == "Rendered user id."

    r = await client.get(f"/api/projects/{pid}/propagate/descriptions", params={"unique_id": STG})
    assert r.json()["by_node"] == {STG: 2}
    assert calls["descriptions"]["allowed"] == {"identity", "rename", "cast"}


async def test_description_proposal_spans_files_and_keeps_doc_blocks(
    client, db_session, calls, compiled, tmp_path
):
    pid, root = await _project(db_session, tmp_path)
    r = await client.post(f"/api/projects/{pid}/propagate/descriptions", json={})
    assert r.status_code == 202
    assert r.json()["kind"] == "propagate"
    proposal = await _wait_status(client, pid, r.json()["id"], "ready")

    files = {f["path"]: f for f in proposal["files"]}
    assert set(files) == {"models/staging/schema.yml", "models/marts/schema.yml"}
    stg = yaml.safe_load(files["models/staging/schema.yml"]["proposed_text"])["models"][0]
    assert stg["columns"] == [
        {"name": "user_id", "description": '{{ doc("user_id") }}'},
        {"name": "email", "description": "Email address."},
    ]
    assert files["models/marts/schema.yml"]["original_text"] is None
    items = proposal["result"]["items"]
    assert {(i["file"], i["column"]) for i in items} == {
        ("models/staging/schema.yml", "user_id"),
        ("models/staging/schema.yml", "email"),
        ("models/marts/schema.yml", "email"),
    }
    assert proposal["result"]["conflicts"][0]["column"] == "x"

    # reject one item in the staging file: only that file is rebuilt
    stg_file = files["models/staging/schema.yml"]
    keep = [i["key"] for i in items if i["file"] == stg_file["path"] and i["column"] == "user_id"]
    base = f"/api/projects/{pid}/ai/proposals/{proposal['id']}"
    r = await client.put(f"{base}/selection", json={"keys": keep, "accepted": keep, "file_id": stg_file["id"]})
    assert r.status_code == 200
    result = r.json()["result"]
    mart_key = next(i["key"] for i in items if i["file"] == "models/marts/schema.yml")
    assert set(result["selected"]) == {*keep, mart_key}
    assert result["accepted"] == keep
    rebuilt = next(f for f in r.json()["files"] if f["id"] == stg_file["id"])
    assert yaml.safe_load(rebuilt["proposed_text"])["models"][0]["columns"] == [
        {"name": "user_id", "description": '{{ doc("user_id") }}'},
    ]

    assert (await client.put(f"{base}/selection", json={"keys": keep})).status_code == 422  # file_id needed
    assert (await client.put(
        f"{base}/selection", json={"keys": [mart_key], "file_id": stg_file["id"]}
    )).status_code == 422  # another file's item

    assert (await client.post(f"{base}/files/{stg_file['id']}/accept")).status_code == 200
    written = yaml.safe_load((root / "models" / "staging" / "schema.yml").read_text())
    assert written["models"][0]["columns"] == [{"name": "user_id", "description": '{{ doc("user_id") }}'}]
    compiled.assert_awaited_with(pid, str(root), "stg_users")
    assert (await client.get(base)).json()["status"] == "ready"  # the marts file is still pending

    mart_file = files["models/marts/schema.yml"]
    r = await client.post(f"{base}/files/{mart_file['id']}/accept")
    assert r.json()["status"] == "applied"
    assert (root / "models" / "marts" / "schema.yml").exists()


async def test_nothing_selected_in_a_file_cannot_be_accepted(client, db_session, calls, compiled, tmp_path):
    pid, _ = await _project(db_session, tmp_path)
    r = await client.post(f"/api/projects/{pid}/propagate/descriptions", json={"unique_ids": [STG]})
    proposal = await _wait_status(client, pid, r.json()["id"], "ready")
    assert proposal["title"] == "Inherited descriptions for stg_users"
    assert proposal["unique_id"] == STG
    [file] = proposal["files"]
    base = f"/api/projects/{pid}/ai/proposals/{proposal['id']}"
    await client.put(f"{base}/selection", json={"keys": []})
    assert (await client.post(f"{base}/files/{file['id']}/accept")).status_code == 409


async def test_empty_when_nothing_to_fill(client, db_session, calls, tmp_path, monkeypatch):
    pid, _ = await _project(db_session, tmp_path)
    engine = _fake_engine(calls)
    engine.inherit_descriptions = lambda *a, **k: {"fills": [], "conflicts": []}
    monkeypatch.setattr(pro, "_pro", lambda: engine)
    r = await client.post(f"/api/projects/{pid}/propagate/descriptions", json={})
    proposal = await _wait_status(client, pid, r.json()["id"], "empty")
    assert "Nothing to fill" in proposal["error_message"]


# ── tags ─────────────────────────────────────────────────────────────────────


async def test_tag_flow_uses_the_project_setting(client, db_session, calls, tmp_path):
    pid, _ = await _project(db_session, tmp_path)
    db_session.add(ProjectEnvVar(project_id=pid, key="PROPAGATE_TAGS", value="PII, gdpr"))
    await db_session.commit()
    r = await client.get(f"/api/projects/{pid}/lineage/tag-flow")
    body = r.json()
    assert body["tag"] == "pii"
    assert body["tags"] == ["pii", "gdpr"]
    assert body["columns"][0]["name"] == "users"
    assert body["columns"][0]["resource_type"] == "source"
    assert body["columns"][1]["via_kind"] == "derived"
    assert body["exposures"] == [{"unique_id": "exposure.proj.crm", "name": "crm", "via": [MART]}]
    assert calls["tag_flow"]["declared"] == {SRC: {"email": ["pii"]}}
    assert calls["tag_flow"]["exposures"]["exposure.proj.crm"]["depends_on"] == [MART]

    r = await client.get(f"/api/projects/{pid}/lineage/tag-flow", params={"tag": "gdpr"})
    assert calls["tag_flow"]["tags"] == ["gdpr"]


async def test_tag_proposal_writes_inherited_tags(client, db_session, calls, compiled, tmp_path):
    pid, root = await _project(db_session, tmp_path)
    r = await client.post(f"/api/projects/{pid}/propagate/tags", json={"tag": "pii"})
    assert r.json()["title"] == "Inherited `pii` tags"
    proposal = await _wait_status(client, pid, r.json()["id"], "ready")
    assert calls["inherit_tags"] == ["pii"]
    [file] = proposal["files"]
    assert file["path"] == "models/marts/schema.yml"
    assert yaml.safe_load(file["proposed_text"])["models"][0]["columns"] == [
        {"name": "email_hash", "tags": ["pii"]},
    ]
    r = await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/files/{file['id']}/accept")
    assert r.json()["status"] == "applied"
    compiled.assert_awaited_with(pid, str(root), "mart_users")
