"""Add to semantic layer: spec choice, the draft pipeline (validation, smoke queries, time
spine) and the proposal routes. wickd_pro, the sidecar and dbt are mocked."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from ruamel.yaml import YAML
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.ai import pro, semantic_draft
from app.ai.errors import NothingToPropose, ProposalError
from app.api import ai_proposals
from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, Project
from app.licensing import entitlements
from app.main import app
from app.semantic import batch, service
from app.semantic import pro as semantic_pro
from app.semantic.batch import BatchResult
from app.semantic.status import SemanticStatus
from tests.test_schema_semantic import LEGACY_ITEMS

UID = "model.proj.stg_payments"
NODE = {"name": "stg_payments", "resource_type": "model", "original_file_path": "models/stg_payments.sql",
        "schema": "main", "database": "dev", "alias": "stg_payments"}
DRAFT = {
    "semantic_model": {"name": "payments", "model": "stg_payments", "description": "", "primary_entity": None,
                       "agg_time_dimension": "paid_at", "entities": [], "dimensions": [],
                       "measures": [{"name": "payment_count", "agg": "count", "column": "payment_id"},
                                    {"name": "paid_amount", "agg": "sum", "column": "amount"}]},
    "metrics": [{"name": "payment_count", "type": "simple", "measure": "payment_count", "label": "Payments"},
                {"name": "paid_amount", "type": "simple", "measure": "paid_amount", "label": "Paid amount"},
                {"name": "avg_payment", "type": "ratio", "numerator": "paid_amount", "denominator": "payment_count"}],
}


def test_draft_spec_never_writes_latest_where_it_cannot_parse() -> None:
    assert semantic_draft.draft_spec("none", "1.12.2") == "latest"
    assert semantic_draft.draft_spec("latest", "1.12.0") == "latest"
    assert semantic_draft.draft_spec("legacy", "1.12.2") == "legacy"  # never introduce a mix
    assert semantic_draft.draft_spec("none", "1.11.4") == "legacy"  # latest fails to parse on 1.11
    assert semantic_draft.draft_spec("none", None) == "legacy"


def test_time_spine_and_existing_semantic_model_detection() -> None:
    assert semantic_draft.has_time_spine({}, {"project_configuration": {"time_spines": [{}]}})
    assert semantic_draft.has_time_spine({"nodes": {"m": {"resource_type": "model", "name": "metricflow_time_spine"}}}, {})
    assert not semantic_draft.has_time_spine({"nodes": {}}, {"project_configuration": {}})
    sem = {"semantic_models": [{"name": "payments", "node_relation": {"alias": "stg_payments", "schema_name": "main"}}]}
    assert semantic_draft.semantic_model_on(NODE, sem) == "payments"
    assert semantic_draft.semantic_model_on({**NODE, "schema": "other"}, sem) is None


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    (root / "models").mkdir(parents=True)
    (root / "target").mkdir()
    (root / "dbt_project.yml").write_text("name: proj\n")
    (root / "models" / "schema.yml").write_text("version: 2\n\nmodels:\n  - name: stg_payments\n")
    manifest = {"metadata": {"dbt_version": "1.10.13"},
                "nodes": {UID: {**NODE, "patch_path": "proj://models/schema.yml"}}}
    (root / "target" / "manifest.json").write_text(json.dumps(manifest))
    (root / "target" / "semantic_manifest.json").write_text(json.dumps({"semantic_models": [], "metrics": []}))
    return root


@pytest.fixture
def mocked(monkeypatch: pytest.MonkeyPatch) -> dict:
    calls: dict = {"validate": [], "batch": []}
    monkeypatch.setattr(semantic_draft, "_columns", AsyncMock(return_value=[{"name": "payment_id", "data_type": "varchar"}]))
    monkeypatch.setattr(semantic_draft, "_show", AsyncMock(return_value=None))
    monkeypatch.setattr(semantic_draft, "llm_ready", lambda config: False)
    monkeypatch.setattr(semantic_pro, "facts_for", lambda *a: {"facts": True})
    monkeypatch.setattr(semantic_pro, "heuristic_draft", lambda facts: DRAFT)
    monkeypatch.setattr(semantic_pro, "to_manifest_json", lambda draft, node, sem: {"semantic_models": [], "metrics": []})
    monkeypatch.setattr(semantic_pro, "to_yaml_items", lambda draft, spec: LEGACY_ITEMS)

    async def validate(project_path, extra, smoke, group_by):
        calls["validate"].append({"extra": extra, "smoke": smoke, "group_by": group_by})
        return {"errors": [], "warnings": [{"message": "heads up"}],
                "smoke": {m: {"sql": f"select '{m}'"} for m in smoke[:-1]} | {smoke[-1]: {"error": "no join path"}}}

    async def run_many(project_id, project_path, sqls, *, limit):
        calls["batch"].append((sqls, limit))
        return [BatchResult(["metric_time__day", "v"], [["2026-10-27", 1]] * 7, True) for _ in sqls]

    monkeypatch.setattr(service, "validate_draft", validate)
    monkeypatch.setattr(batch, "run_many", run_many)
    return calls


async def _generate(project: Path) -> semantic_draft.SemanticDraftResult:
    return await semantic_draft.generate_semantic_draft(
        project_id=1, project_path=project, unique_id=UID, env={}, config=MagicMock(),
    )


async def test_pipeline_validates_smokes_and_proposes_yaml_and_time_spine(project, mocked) -> None:
    result = await _generate(project)
    yaml_change, *spine = result.changes
    assert yaml_change.path == "models/schema.yml" and yaml_change.original.endswith("- name: stg_payments\n")
    assert YAML(typ="safe").load(yaml_change.proposed)["semantic_models"][0]["name"] == "payments"
    assert [c.path for c in spine] == ["models/metricflow_time_spine.sql", "models/metricflow_time_spine.yml"]
    assert "dbt.date_spine" in spine[0].proposed and spine[0].original is None

    validated = mocked["validate"][0]
    assert validated["smoke"] == ["payment_count", "paid_amount", "avg_payment"]
    assert validated["group_by"] == []  # no time spine yet: smoke queries can't use metric_time
    assert validated["extra"]["time_spines"][0]["node_relation"]["alias"] == "metricflow_time_spine"
    assert mocked["batch"] == [(["select 'payment_count'", "select 'paid_amount'"], 5)]  # one dbt show

    summary = result.summary
    assert summary["spec"] == "legacy" and summary["warnings"] == ["heads up"]
    assert summary["note"] == semantic_draft.FACTS_ONLY_NOTE
    by_key = {i["key"]: i for i in summary["items"]}
    assert by_key["metric:paid_amount"]["definition"] == "sum(amount)"
    assert by_key["metric:avg_payment"]["definition"] == "paid_amount / payment_count"
    assert len(by_key["metric:payment_count"]["smoke"]["rows"]) == 5
    assert by_key["metric:avg_payment"]["smoke"] == {"error": "no join path"}
    assert by_key["time_spine_model"]["file"] == "models/metricflow_time_spine.sql"


async def test_existing_time_spine_is_used_for_smoke_queries(project, mocked) -> None:
    sem = project / "target" / "semantic_manifest.json"
    sem.write_text(json.dumps({"project_configuration": {"time_spines": [{"x": 1}]}}))
    result = await _generate(project)
    assert len(result.changes) == 1
    assert mocked["validate"][0]["group_by"] == ["metric_time__day"]


async def test_model_already_in_the_semantic_layer_is_empty(project, mocked) -> None:
    (project / "target" / "semantic_manifest.json").write_text(json.dumps(
        {"semantic_models": [{"name": "payments", "node_relation": {"alias": "stg_payments", "schema_name": "main"}}]}))
    with pytest.raises(NothingToPropose, match="already in the semantic layer"):
        await _generate(project)


async def test_invalid_ai_draft_falls_back_to_the_heuristic_one(project, mocked, monkeypatch) -> None:
    ai_draft = {**DRAFT, "metrics": DRAFT["metrics"][:1]}
    monkeypatch.setattr(semantic_draft, "llm_ready", lambda config: True)
    monkeypatch.setattr(semantic_draft, "_llm_draft", AsyncMock(return_value=(ai_draft, None)))
    results = iter([{"errors": [{"message": "element `country` is of type MEASURE"}]},
                    {"errors": [], "smoke": {}}])
    monkeypatch.setattr(service, "validate_draft", AsyncMock(side_effect=lambda *a: next(results)))
    result = await _generate(project)
    assert "didn't pass MetricFlow's validation" in result.summary["note"]

    monkeypatch.setattr(service, "validate_draft", AsyncMock(return_value={"errors": [{"message": "bad"}]}))
    with pytest.raises(ProposalError, match="MetricFlow rejected the draft: bad"):
        await _generate(project)


# ── routes ───────────────────────────────────────────────────────────────────


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def db_session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'ai.sqlite'}", future=True)
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


def _status(mode: str = "auto", reason_code: str | None = None) -> SemanticStatus:
    return SemanticStatus(
        available=reason_code is None, can_query=reason_code is None, mode=mode, mode_source="global",
        reason_code=reason_code, reason=reason_code, warning=None, dbt_core="1.10.13", python="3.12",
        engine_version="x", sidecar="ready", spec="legacy", adapter_type="duckdb",
        counts={"semantic_models": 0, "metrics": 0, "saved_queries": 0}, compatible_dbt_versions=[],
        recommended_version=None, cli_release=None,
    )


@pytest.fixture
def routes(monkeypatch: pytest.MonkeyPatch, project: Path) -> dict:
    async def _check(session, *, force: bool = False):
        return entitlements.Entitlement(entitled=True, reason="granted")

    monkeypatch.setattr(entitlements, "check_entitlement", _check)
    monkeypatch.setattr(pro, "is_available", lambda: True)
    monkeypatch.setattr(semantic_pro, "is_available", lambda: True)
    monkeypatch.setattr(ai_proposals, "load_project_env", AsyncMock(return_value={}))
    state = {"status": _status(), "verified": []}

    async def status(session, project, want_cli=False):
        return state["status"]

    import app.semantic.status as status_mod
    monkeypatch.setattr(status_mod, "semantic_status", status)
    monkeypatch.setattr(ai_proposals, "start_semantic_verify", lambda *a: state["verified"].append(a))
    return state


async def _add_project(session: AsyncSession, root: Path) -> int:
    project = Project(name="proj", path=str(root), platform="duckdb")
    session.add(project)
    await session.commit()
    return project.id


async def _wait(client: AsyncClient, pid: int, proposal_id: int, status: str) -> dict:
    for _ in range(200):
        body = (await client.get(f"/api/projects/{pid}/ai/proposals/{proposal_id}")).json()
        if body["status"] == status:
            return body
        await asyncio.sleep(0.02)
    raise AssertionError(f"never reached {status}: {body}")


async def test_route_is_gated_on_metricflow_and_pro(client, db_session, routes, project, mocked, monkeypatch) -> None:
    pid = await _add_project(db_session, project)
    routes["status"] = _status(mode="off", reason_code="off")
    r = await client.post(f"/api/projects/{pid}/ai/semantic-draft", json={"unique_id": UID})
    assert r.status_code == 409 and r.json()["detail"]["status"]["mode"] == "off"
    routes["status"] = _status(reason_code="no_semantic_nodes")  # nothing defined yet: allowed
    monkeypatch.setattr(semantic_pro, "is_available", lambda: False)
    assert (await client.post(f"/api/projects/{pid}/ai/semantic-draft", json={"unique_id": UID})).status_code == 503


async def test_review_partial_accept_and_verify(client, db_session, routes, project, mocked) -> None:
    pid = await _add_project(db_session, project)
    r = await client.post(f"/api/projects/{pid}/ai/semantic-draft", json={"unique_id": UID})
    assert r.status_code == 202 and r.json()["kind"] == "semantic"
    proposal = await _wait(client, pid, r.json()["id"], "ready")
    assert proposal["result"]["spec"] == "legacy" and proposal["result"]["semantic_model"] == "payments"
    files = {f["path"]: f for f in proposal["files"]}
    assert files["models/metricflow_time_spine.sql"]["op"] == "create"

    yaml_file = files["models/schema.yml"]
    keep = ["semantic_model", "metric:payment_count"]
    r = await client.put(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/selection",
                         json={"keys": keep, "file_id": yaml_file["id"]})
    assert r.status_code == 200, r.text
    rebuilt = next(f for f in r.json()["files"] if f["id"] == yaml_file["id"])["proposed_text"]
    assert [m["name"] for m in YAML(typ="safe").load(rebuilt)["metrics"]] == ["payment_count"]

    for f in proposal["files"]:
        r = await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/files/{f['id']}/accept")
        assert r.status_code == 200, r.text
    assert r.json()["status"] == "applied"
    assert (project / "models" / "schema.yml").read_text() == rebuilt
    assert (project / "models" / "metricflow_time_spine.sql").exists()
    assert len(routes["verified"]) == 1  # dbt parse + MetricFlow validation after applying


async def test_accept_all_also_verifies(client, db_session, routes, project, mocked) -> None:
    pid = await _add_project(db_session, project)
    r = await client.post(f"/api/projects/{pid}/ai/semantic-draft", json={"unique_id": UID})
    proposal = await _wait(client, pid, r.json()["id"], "ready")
    r = await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/accept")
    assert r.status_code == 200 and r.json()["status"] == "applied"
    assert len(routes["verified"]) == 1
