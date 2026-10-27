"""Test gaps routes: gating, lineage readiness, the ranked list, and the batch
"tests" proposal (one file per schema YAML, per-file partial accept). The Pro
ranking is faked (app.test_targets.pro._pro) and the warehouse pre-check stubbed."""

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
from app.db.models import Base, ColumnLineageSnapshot, Project
from app.licensing import entitlements
from app.main import app
from app.test_targets import batch, pro, service

ORDERS = "model.proj.stg_orders"
CUSTOMERS = "model.proj.dim_customers"
DAILY = "model.proj.daily"

STAGING_YML = """version: 2

models:
  - name: stg_orders
    columns:
      - name: order_id
        data_tests:
          - unique
  - name: dim_customers
"""

MANIFEST = {
    "metadata": {"project_name": "proj", "dbt_version": "1.9.0"},
    "nodes": {
        ORDERS: {
            "name": "stg_orders", "resource_type": "model", "package_name": "proj",
            "original_file_path": "models/staging/stg_orders.sql",
            "patch_path": "proj://models/staging/schema.yml", "columns": {},
        },
        CUSTOMERS: {
            "name": "dim_customers", "resource_type": "model", "package_name": "proj",
            "original_file_path": "models/staging/dim_customers.sql",
            "patch_path": "proj://models/staging/schema.yml", "columns": {},
        },
        DAILY: {
            "name": "daily", "resource_type": "model", "package_name": "proj",
            "original_file_path": "models/marts/daily.sql", "patch_path": None, "columns": {},
        },
    },
    "sources": {},
}

RANKING = [
    {"unique_id": ORDERS, "name": "stg_orders", "column": "customer_id", "score": 9, "reach": 1, "row_uses": 1,
     "exposures": 1, "in_grain": False, "existing": [], "used_by": {
         "columns": [{"unique_id": "model.proj.fct", "name": "fct", "columns": ["customer_id"]}],
         "row_uses": [{"unique_id": "model.proj.fct", "name": "fct"}],
         "exposures": [{"unique_id": "exposure.proj.dash", "name": "Sales dashboard"}],
     }, "candidates": [
         {"test": "not_null", "evidence": "inner-joined on in 1 model", "source": "join", "models": ["fct"]},
         {"test": "relationships", "to": CUSTOMERS, "field": "customer_id",
          "evidence": "joined to `dim_customers.customer_id` in 1 model", "source": "join"},
     ]},
    {"unique_id": CUSTOMERS, "name": "dim_customers", "column": "customer_id", "score": 6, "reach": 0,
     "row_uses": 1, "exposures": 0, "in_grain": True, "existing": [], "candidates": [
         {"test": "unique", "evidence": "one row per `customer_id` (grouped by)", "source": "grain"},
     ]},
    {"unique_id": DAILY, "name": "daily", "column": None, "columns": ["day", "status"], "score": 2, "reach": 0,
     "row_uses": 0, "exposures": 0, "in_grain": True, "existing": [], "candidates": [
         {"test": "unique_combination_of_columns", "combination": ["day", "status"],
          "evidence": "one row per (day, status) (grouped by)", "source": "grain"},
     ]},
    {"unique_id": DAILY, "name": "daily", "column": "amount", "score": 1, "reach": 1, "row_uses": 0,
     "exposures": 0, "in_grain": False, "existing": [], "candidates": []},
]

KEYS = {
    "orders": f"{ORDERS}::customer_id",
    "customers": f"{CUSTOMERS}::customer_id",
    "daily": f"{DAILY}::(day, status)",
}


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def db_session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'g.sqlite'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with sessions() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    monkeypatch.setattr(db_engine, "SessionLocal", sessions)
    service._cache.clear()
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
    recorded: dict = {"rank": 0, "prechecks": []}

    def rank_test_targets(manifest, lineage, row_deps, structure, unique_ids=None):
        recorded["rank"] += 1
        recorded["structure"] = structure
        return RANKING

    async def _precheck(project_id, project_path, env, model_ref, pairs):
        recorded["prechecks"].append(model_ref)
        return [0] * len(pairs)

    monkeypatch.setattr(pro, "_pro", lambda: SimpleNamespace(rank_test_targets=rank_test_targets))
    monkeypatch.setattr(batch, "precheck_tests", _precheck)
    monkeypatch.setattr(ai_pro, "is_available", lambda: True)
    monkeypatch.setattr(ai_proposals, "_compile_model", AsyncMock())
    _entitle(monkeypatch)
    return recorded


async def _project(session: AsyncSession, tmp_path: Path, lineage_version: int | None = 4) -> tuple[int, Path]:
    root = tmp_path / "proj"
    (root / "models" / "staging").mkdir(parents=True)
    (root / "models" / "marts").mkdir(parents=True)
    (root / "target").mkdir()
    (root / "target" / "manifest.json").write_text(json.dumps(MANIFEST))
    (root / "models" / "staging" / "schema.yml").write_text(STAGING_YML)
    project = Project(name="proj", path=str(root), platform="local")
    session.add(project)
    await session.commit()
    if lineage_version is not None:
        session.add(ColumnLineageSnapshot(
            project_id=project.id, status="done", results_json="{}", lineage_version=lineage_version,
            join_keys_json=json.dumps({DAILY: {"join_pairs": [], "grain": {"columns": ["day"], "via": "distinct"}}}),
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
        await client.get(f"/api/projects/{pid}/test-gaps"),
        await client.post(f"/api/projects/{pid}/ai/tests/batch", json={"keys": ["x"]}),
    ):
        assert r.status_code == 403
        assert r.json()["detail"]["error"] == "pro_feature_required"


async def test_503_without_pro_package(client, db_session, tmp_path, monkeypatch):
    _entitle(monkeypatch)
    pid, _ = await _project(db_session, tmp_path)

    def _missing():
        raise pro.TestTargetsUnavailable("missing")

    monkeypatch.setattr(pro, "_pro", _missing)
    assert (await client.get(f"/api/projects/{pid}/test-gaps")).status_code == 503


@pytest.mark.parametrize(("version", "reason"), [(None, "missing"), (3, "outdated")])
async def test_409_until_lineage_records_structure(client, db_session, calls, tmp_path, version, reason):
    pid, _ = await _project(db_session, tmp_path, lineage_version=version)
    r = await client.get(f"/api/projects/{pid}/test-gaps")
    assert r.status_code == 409
    assert r.json()["detail"] == {"error": "lineage_not_ready", "reason": reason}


async def test_running_scan_is_not_ready(client, db_session, calls, tmp_path):
    pid, _ = await _project(db_session, tmp_path, lineage_version=None)
    db_session.add(ColumnLineageSnapshot(project_id=pid, status="running", lineage_version=4))
    await db_session.commit()
    r = await client.get(f"/api/projects/{pid}/test-gaps")
    assert r.json()["detail"]["reason"] == "running"


# ── the list ─────────────────────────────────────────────────────────────────


async def test_lists_rows_with_suggestions_and_caches_the_ranking(client, db_session, calls, tmp_path):
    pid, _ = await _project(db_session, tmp_path)
    r = await client.get(f"/api/projects/{pid}/test-gaps", params={"limit": 2})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3  # `amount` has no candidate
    assert [row["key"] for row in body["rows"]] == [KEYS["orders"], KEYS["customers"]]
    rel = body["rows"][0]["candidates"][1]
    assert rel == {
        "test": "relationships", "evidence": "joined to `dim_customers.customer_id` in 1 model",
        "source": "join", "to": CUSTOMERS, "field": "customer_id", "combination": None, "models": [],
    }
    assert body["rows"][0]["candidates"][0]["models"] == ["fct"]
    assert body["rows"][0]["used_by"] == {
        "columns": [{"unique_id": "model.proj.fct", "name": "fct", "columns": ["customer_id"]}],
        "row_uses": [{"unique_id": "model.proj.fct", "name": "fct", "columns": []}],
        "exposures": [{"unique_id": "exposure.proj.dash", "name": "Sales dashboard", "columns": []}],
    }
    # older wickd_pro builds return counts only
    assert body["rows"][1]["used_by"] == {"columns": [], "row_uses": [], "exposures": []}
    assert calls["structure"][DAILY]["grain"]["columns"] == ["day"]

    await client.get(f"/api/projects/{pid}/test-gaps")
    assert calls["rank"] == 1  # same snapshot + manifest → cached


# ── batch proposal ───────────────────────────────────────────────────────────


async def test_batch_proposal_spans_files_with_partial_accept(client, db_session, calls, tmp_path):
    pid, root = await _project(db_session, tmp_path)
    r = await client.post(f"/api/projects/{pid}/ai/tests/batch", json={"keys": list(KEYS.values())})
    assert r.status_code == 202
    assert r.json()["kind"] == "tests" and r.json()["unique_id"] is None
    assert r.json()["title"] == "Tests for 3 models"
    proposal = await _wait_status(client, pid, r.json()["id"], "ready")
    assert calls["prechecks"] == ["ref('stg_orders')", "ref('dim_customers')", "ref('daily')"]

    files = {f["path"]: f for f in proposal["files"]}
    assert set(files) == {"models/staging/schema.yml", "models/marts/schema.yml"}
    staging = yaml.safe_load(files["models/staging/schema.yml"]["proposed_text"])["models"]
    assert staging[0]["columns"][1] == {
        "name": "customer_id",
        "data_tests": ["not_null", {"relationships": {"to": "ref('dim_customers')", "field": "customer_id"}}],
    }
    assert staging[1]["columns"] == [{"name": "customer_id", "data_tests": ["unique"]}]
    daily = yaml.safe_load(files["models/marts/schema.yml"]["proposed_text"])["models"][0]
    assert daily["data_tests"] == [
        {"dbt_utils.unique_combination_of_columns": {"combination_of_columns": ["day", "status"]}},
    ]

    result = proposal["result"]
    assert result["batch"] is True
    tests = result["tests"]
    assert [(t["name"], t["column"], t["test"]) for t in tests] == [
        ("stg_orders", "customer_id", "not_null"),
        ("stg_orders", "customer_id", "relationships"),
        ("dim_customers", "customer_id", "unique"),
        ("daily", None, "unique_combination_of_columns"),
    ]
    assert all(t["failures"] == 0 and t["source"] == "lineage" for t in tests)
    assert tests[1]["evidence"] == "joined to `dim_customers.customer_id` in 1 model"

    # keep only the relationships test in the staging file
    staging_file = files["models/staging/schema.yml"]
    keep = [tests[1]["key"]]
    base = f"/api/projects/{pid}/ai/proposals/{proposal['id']}"
    r = await client.put(f"{base}/selection", json={"keys": keep, "file_id": staging_file["id"]})
    assert r.status_code == 200
    assert set(r.json()["result"]["selected"]) == {tests[1]["key"], tests[3]["key"]}
    rebuilt = next(f for f in r.json()["files"] if f["id"] == staging_file["id"])
    models = yaml.safe_load(rebuilt["proposed_text"])["models"]
    assert models[0]["columns"][1]["data_tests"] == [
        {"relationships": {"to": "ref('dim_customers')", "field": "customer_id"}},
    ]
    assert "columns" not in models[1]

    r = await client.post(f"{base}/files/{staging_file['id']}/accept")
    assert r.status_code == 200
    ai_proposals._compile_model.assert_awaited_with(pid, str(root), "dim_customers stg_orders")
    marts = files["models/marts/schema.yml"]
    assert (await client.post(f"{base}/files/{marts['id']}/accept")).json()["status"] == "applied"
    assert (root / "models" / "marts" / "schema.yml").exists()


async def test_batch_with_only_stale_keys_is_rejected(client, db_session, calls, tmp_path):
    pid, _ = await _project(db_session, tmp_path)
    r = await client.post(f"/api/projects/{pid}/ai/tests/batch", json={"keys": [f"{DAILY}::amount"]})
    assert r.status_code == 422


async def test_batch_is_empty_when_tests_already_exist(client, db_session, calls, tmp_path):
    manifest = json.loads(json.dumps(MANIFEST))
    manifest["nodes"]["test.proj.u"] = {
        "resource_type": "test", "attached_node": CUSTOMERS, "column_name": "customer_id",
        "test_metadata": {"name": "unique"},
    }
    pid, root = await _project(db_session, tmp_path)
    (root / "target" / "manifest.json").write_text(json.dumps(manifest))
    r = await client.post(f"/api/projects/{pid}/ai/tests/batch", json={"keys": [KEYS["customers"]]})
    proposal = await _wait_status(client, pid, r.json()["id"], "empty")
    assert "already have these tests" in proposal["error_message"]


# ── ignoring ─────────────────────────────────────────────────────────────────


async def test_ignored_rows_leave_the_list_and_can_be_unignored(client, db_session, calls, tmp_path):
    pid, _ = await _project(db_session, tmp_path)
    base = f"/api/projects/{pid}/test-gaps"

    r = await client.post(f"{base}/ignore", json={"keys": [KEYS["orders"], KEYS["daily"], "model.proj.gone::x"]})
    assert r.json() == {"changed": 2}
    assert (await client.post(f"{base}/ignore", json={"keys": [KEYS["orders"]]})).json() == {"changed": 0}

    body = (await client.get(base)).json()
    assert [row["key"] for row in body["rows"]] == [KEYS["customers"]]
    assert (body["total"], body["ignored"]) == (1, 2)

    ignored = (await client.get(f"{base}/ignored")).json()["rows"]
    assert {(i["key"], i["name"], i["label"], i["still_a_gap"]) for i in ignored} == {
        (KEYS["orders"], "stg_orders", "customer_id", True),
        (KEYS["daily"], "daily", "(day, status)", True),
    }
    orders = next(i for i in ignored if i["key"] == KEYS["orders"])
    assert [c["test"] for c in orders["candidates"]] == ["not_null", "relationships"]
    assert orders["ignored_at"]

    assert (await client.post(f"{base}/unignore", json={"keys": [KEYS["orders"]]})).json() == {"changed": 1}
    body = (await client.get(base)).json()
    assert [row["key"] for row in body["rows"]] == [KEYS["orders"], KEYS["customers"]]
    assert body["ignored"] == 1


async def test_ignored_list_survives_the_gap_disappearing_and_lineage_going_stale(
    client, db_session, calls, tmp_path, monkeypatch
):
    pid, _ = await _project(db_session, tmp_path)
    base = f"/api/projects/{pid}/test-gaps"
    await client.post(f"{base}/ignore", json={"keys": [KEYS["customers"]]})

    remaining = [r for r in RANKING if r["unique_id"] != CUSTOMERS]
    monkeypatch.setattr(pro, "_pro", lambda: SimpleNamespace(rank_test_targets=lambda *a, **k: remaining))
    service._cache.clear()
    [row] = (await client.get(f"{base}/ignored")).json()["rows"]
    assert (row["still_a_gap"], row["candidates"]) == (False, [])

    db_session.add(ColumnLineageSnapshot(project_id=pid, status="running", lineage_version=4))
    await db_session.commit()
    [row] = (await client.get(f"{base}/ignored")).json()["rows"]
    assert row["still_a_gap"] is None and row["label"] == "customer_id"


async def test_ignore_needs_current_gaps_and_pro(client, db_session, calls, tmp_path, monkeypatch):
    pid, _ = await _project(db_session, tmp_path)
    base = f"/api/projects/{pid}/test-gaps"
    assert (await client.post(f"{base}/ignore", json={"keys": ["model.proj.gone::x"]})).status_code == 422
    assert (await client.post(f"{base}/ignore", json={"keys": []})).status_code == 422
    _entitle(monkeypatch, entitled=False)
    for r in (
        await client.post(f"{base}/ignore", json={"keys": [KEYS["orders"]]}),
        await client.post(f"{base}/unignore", json={"keys": [KEYS["orders"]]}),
        await client.get(f"{base}/ignored"),
    ):
        assert r.status_code == 403
