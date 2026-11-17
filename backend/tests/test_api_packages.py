"""Package manager routes: listing (Hub stubbed), proposals, dbt deps, Hub search, compat,
and the Health summary's packages check."""
from pathlib import Path

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from app.api import packages as packages_api
from app.api import runs as runs_api
from app.config import settings
from app.db.engine import get_session
from app.db.models import Project
from app.dbt import hub
from app.main import app

UTILS = {
    "name": "dbt_utils", "namespace": "dbt-labs", "description": "macros",
    "versions": {
        "1.1.1": {"version": "1.1.1", "require_dbt_version": [">=1.3.0", "<2.0.0"],
                  "_source": {"url": "https://github.com/dbt-labs/dbt-utils/tree/1.1.1/",
                              "readme": "https://raw.githubusercontent.com/dbt-labs/dbt-utils/1.1.1/README.md"}},
        "1.3.0": {"version": "1.3.0", "require_dbt_version": [">=1.3.0", "<2.0.0"], "_source": {}},
    },
}


@pytest.fixture(autouse=True)
def stubs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    monkeypatch.setattr(hub, "_locks", {})

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/index.json"):
            return httpx.Response(200, json=["dbt-labs/dbt_utils", "dbt-labs/codegen"])
        if path.endswith("/dbt-labs/dbt_utils.json"):
            return httpx.Response(200, json=UTILS)
        if path.endswith("README.md"):
            return httpx.Response(200, text="# utils")
        return httpx.Response(404)

    monkeypatch.setattr(hub, "transport", httpx.MockTransport(handler))

    async def version() -> str:
        return "1.10.0"

    monkeypatch.setattr(packages_api, "installed_dbt_version", version)
    monkeypatch.setattr("app.dbt.installed_version.installed_dbt_version", version)


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _project(tmp_path: Path, *, with_packages: bool = True) -> Project:
    root = tmp_path / "proj"
    root.mkdir()
    (root / "dbt_project.yml").write_text("name: proj\n")
    if with_packages:
        (root / "packages.yml").write_text("packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.1.1  # keep\n")
        pkg = root / "dbt_packages" / "dbt_utils"
        pkg.mkdir(parents=True)
        (pkg / "dbt_project.yml").write_text("name: dbt_utils\nversion: '1.1.1'\nrequire-dbt-version: ['>=1.3.0', '<1.9.0']\n")
    async for session in app.dependency_overrides[get_session]():
        project = Project(name="proj", path=str(root), platform="duckdb")
        session.add(project)
        await session.commit()
        await session.refresh(project)
        return project
    raise AssertionError("no session")


async def test_list_packages(client: AsyncClient, tmp_path: Path):
    project = await _project(tmp_path)
    res = await client.get(f"/api/projects/{project.id}/packages")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["file"] == "packages.yml" and body["dbt_version"] == "1.10.0" and not body["hub_unreachable"]
    [row] = body["rows"]
    assert row["installed"] == "1.1.1" and row["compatible"] is False
    assert row["latest"] == "1.3.0" and row["upgrade_to"] == "1.3.0"


async def test_list_without_packages_file(client: AsyncClient, tmp_path: Path):
    project = await _project(tmp_path, with_packages=False)
    body = (await client.get(f"/api/projects/{project.id}/packages")).json()
    assert body["file"] is None and body["rows"] == []


async def test_propose_creates_base_proposal(client: AsyncClient, tmp_path: Path):
    project = await _project(tmp_path)
    res = await client.post(f"/api/projects/{project.id}/packages/propose", json={"changes": [
        {"op": "set_version", "key": "dbt-labs/dbt_utils", "version": "1.3.0"},
        {"op": "add", "key": "dbt-labs/codegen", "version": "0.12.1"},
    ]})
    assert res.status_code == 200, res.text
    proposal = res.json()
    assert proposal["kind"] == "packages" and proposal["status"] == "ready"
    assert proposal["title"] == "Update 2 packages"
    [file] = proposal["files"]
    assert file["path"] == "packages.yml"
    assert "version: 1.3.0  # keep" in file["proposed_text"]
    assert "package: dbt-labs/codegen" in file["proposed_text"]
    # reviewing it needs no Pro: accept writes the file
    res = await client.post(f"/api/projects/{project.id}/ai/proposals/{proposal['id']}/accept", json={})
    assert res.status_code == 200, res.text
    assert "dbt-labs/codegen" in (Path(project.path) / "packages.yml").read_text()


async def test_propose_new_file_and_errors(client: AsyncClient, tmp_path: Path):
    project = await _project(tmp_path, with_packages=False)
    res = await client.post(f"/api/projects/{project.id}/packages/propose",
                            json={"changes": [{"op": "add", "key": "dbt-labs/codegen", "version": "0.12.1"}]})
    assert res.status_code == 200
    assert res.json()["files"][0]["op"] == "create"
    bad = await client.post(f"/api/projects/{project.id}/packages/propose",
                            json={"changes": [{"op": "add", "key": "not a name", "version": "1.0.0"}]})
    assert bad.status_code == 400
    bad = await client.post(f"/api/projects/{project.id}/packages/propose",
                            json={"changes": [{"op": "remove", "key": "nope/nope"}]})
    assert bad.status_code == 422


async def test_deps_launches_runner(client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    project = await _project(tmp_path)
    launched: list[tuple[str, ...]] = []
    monkeypatch.setattr(runs_api, "_launch_custom", lambda p, parsed, trigger="manual": launched.append(parsed.args))
    res = await client.post(f"/api/projects/{project.id}/packages/deps", json={"upgrade": True})
    assert res.json() == {"accepted": True, "command": "dbt deps --upgrade"}
    await client.post(f"/api/projects/{project.id}/packages/deps", json={})
    assert launched == [("deps", "--upgrade"), ("deps",)]


async def test_hub_routes(client: AsyncClient):
    assert (await client.get("/api/packages/hub/search?q=codegen")).json() == {"reachable": True, "results": ["dbt-labs/codegen"]}
    pkg = (await client.get("/api/packages/hub/dbt-labs/dbt_utils")).json()
    assert pkg["latest_compatible"] == "1.3.0" and pkg["versions"][0]["compatible"] is True
    assert (await client.get("/api/packages/hub/dbt-labs/missing")).status_code == 404
    assert (await client.get("/api/packages/hub/dbt-labs/dbt_utils/readme?version=1.1.1")).json() == {"text": "# utils"}
    assert (await client.get("/api/packages/hub/dbt-labs/dbt_utils/readme?version=1.3.0")).json() == {"text": None}


async def test_compat_and_health(client: AsyncClient, tmp_path: Path):
    project = await _project(tmp_path)
    body = (await client.get("/api/packages/compat")).json()
    assert body["dbt_version"] == "1.10.0"
    assert body["projects"][0]["incompatible"][0]["name"] == "dbt-labs/dbt_utils"
    assert (await client.get("/api/packages/compat?dbt_version=1.8.0")).json()["projects"] == []
    assert (await client.get("/api/packages/compat?dbt_version=nope")).status_code == 400
    health = (await client.get(f"/api/projects/{project.id}/health/summary")).json()
    assert health["packages"]["status"] == "fail"
