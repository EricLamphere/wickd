import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
import yaml
from httpx import ASGITransport, AsyncClient

from app.api import document as document_api
from app.config import settings
from app.dbt.probe import ProbeResult
from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def project_env():
    with patch.object(document_api, "load_project_env", new=AsyncMock(return_value={})):
        yield


async def _seed(client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[int, Path]:
    monkeypatch.setattr(settings, "dbt_projects_path", tmp_path)
    d = tmp_path / "proj"
    (d / "models" / "marts").mkdir(parents=True)
    (d / "target").mkdir()
    (d / "dbt_project.yml").write_text("name: proj\nprofile: p\nversion: '1.0'\n")
    (d / "models" / "marts" / "orders.sql").write_text("select 1 as id")
    manifest = {
        "nodes": {
            "model.proj.orders": {
                "unique_id": "model.proj.orders",
                "name": "orders",
                "resource_type": "model",
                "config": {"materialized": "table"},
                "original_file_path": "models/marts/orders.sql",
            },
            "test.proj.not_null_orders_id": {
                "unique_id": "test.proj.not_null_orders_id",
                "name": "not_null_orders_id",
                "resource_type": "test",
                "config": {},
                "original_file_path": "models/marts/schema.yml",
            },
        },
        "sources": {},
    }
    (d / "target" / "manifest.json").write_text(json.dumps(manifest))
    resp = await client.post("/api/projects/rescan")
    return resp.json()[0]["id"], d


async def test_document_probes_warehouse_when_no_columns_given(client, tmp_path, monkeypatch) -> None:
    pid, _ = await _seed(client, tmp_path, monkeypatch)

    probe = AsyncMock(return_value=ProbeResult(columns=("ID", "TOTAL"), error=None))
    with patch.object(document_api, "probe_warehouse_columns", new=probe):
        resp = await client.post(f"/api/projects/{pid}/models/model.proj.orders/document/propose", json={})

    assert resp.status_code == 200
    assert resp.json()["result"]["summary"]["added_columns"] == ["ID", "TOTAL"]
    probe.assert_awaited_once()


async def test_document_probe_failure_returns_422_and_writes_nothing(client, tmp_path, monkeypatch) -> None:
    pid, d = await _seed(client, tmp_path, monkeypatch)

    probe = AsyncMock(return_value=ProbeResult(columns=(), error="relation does not exist"))
    with patch.object(document_api, "probe_warehouse_columns", new=probe):
        resp = await client.post(f"/api/projects/{pid}/models/model.proj.orders/document/propose", json={})

    assert resp.status_code == 422
    assert "relation does not exist" in resp.json()["detail"]
    assert not (d / "models" / "marts" / "schema.yml").exists()


async def test_document_unsupported_resource_type(client, tmp_path, monkeypatch) -> None:
    pid, _ = await _seed(client, tmp_path, monkeypatch)

    resp = await client.post(
        f"/api/projects/{pid}/models/test.proj.not_null_orders_id/document/propose", json={"columns": ["x"]}
    )

    assert resp.status_code == 422


async def test_document_unknown_node(client, tmp_path, monkeypatch) -> None:
    pid, _ = await _seed(client, tmp_path, monkeypatch)

    resp = await client.post(f"/api/projects/{pid}/models/model.proj.nope/document/propose", json={"columns": ["x"]})

    assert resp.status_code == 404


async def test_document_unknown_project(client) -> None:
    resp = await client.post("/api/projects/9999/models/model.proj.orders/document/propose", json={})

    assert resp.status_code == 404


async def test_document_rejects_oversized_column_names(client, tmp_path, monkeypatch) -> None:
    pid, _ = await _seed(client, tmp_path, monkeypatch)

    resp = await client.post(
        f"/api/projects/{pid}/models/model.proj.orders/document/propose", json={"columns": ["x" * 1000]}
    )

    assert resp.status_code == 422


# ── Review first: POST .../document/propose (Base, no Pro license needed) ────


async def test_propose_builds_a_reviewable_proposal_and_writes_nothing(client, tmp_path, monkeypatch) -> None:
    from app.api import ai_proposals

    pid, d = await _seed(client, tmp_path, monkeypatch)
    resp = await client.post(
        f"/api/projects/{pid}/models/model.proj.orders/document/propose", json={"columns": ["id", "amount"]}
    )
    assert resp.status_code == 200
    proposal = resp.json()
    assert proposal["kind"] == "document_stub" and proposal["status"] == "ready"
    assert proposal["title"] == "Docs YAML for orders"
    assert proposal["result"]["summary"]["added_columns"] == ["id", "amount"]
    [file] = proposal["files"]
    assert file["path"] == "models/marts/schema.yml" and file["op"] == "create"
    assert not (d / "models" / "marts" / "schema.yml").exists()

    # accepting needs no Pro entitlement (this test DB has no license at all)
    with patch.object(ai_proposals, "_compile_model", new=AsyncMock()) as compiled:
        r = await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/files/{file['id']}/accept")
    assert r.status_code == 200 and r.json()["status"] == "applied"
    data = yaml.safe_load((d / "models" / "marts" / "schema.yml").read_text())
    assert data["models"][0]["columns"] == [{"name": "id"}, {"name": "amount"}]
    compiled.assert_called_once()


async def test_propose_is_empty_when_everything_is_documented(client, tmp_path, monkeypatch) -> None:
    pid, d = await _seed(client, tmp_path, monkeypatch)
    (d / "models" / "marts" / "schema.yml").write_text(
        "version: 2\nmodels:\n  - name: orders\n    columns:\n      - name: id\n"
    )
    resp = await client.post(
        f"/api/projects/{pid}/models/model.proj.orders/document/propose", json={"columns": ["id"]}
    )
    assert resp.json()["status"] == "empty" and resp.json()["files"] == []
    assert "already in models/marts/schema.yml" in resp.json()["error_message"]
