"""dbt-core status reports whether the installed version meets what global setup
would install (the requirements file's dbt-core line, else the dbt_core_version pin),
and Global Settings keeps that version setting from going stale."""
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import init as init_api
from app.config import settings
from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def no_env_requirements(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "global_requirements_path", None)


@pytest.fixture
def installed_dbt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A fake `dbt` whose --version reports the given dbt-core version."""
    def install(version: str) -> None:
        dbt = tmp_path / "dbt"
        dbt.write_text(f"#!/bin/sh\necho 'Core:'\necho '  - installed: {version}'\necho 'dbt-core {version}'\n")
        dbt.chmod(0o755)
        monkeypatch.setattr(init_api, "existing_bin", lambda name: dbt if name == "dbt" else None)
    return install


async def _status(client: AsyncClient) -> dict:
    resp = await client.get("/api/init/dbt-core-status")
    assert resp.status_code == 200
    return resp.json()


async def test_nothing_to_compare_without_file_or_version(client, installed_dbt) -> None:
    installed_dbt("1.12.6")
    body = await _status(client)
    assert body == {"installed": True, "version": "1.12.6", "expected": None, "expected_source": None, "matches": None}


async def test_setting_pin_matches(client, installed_dbt) -> None:
    installed_dbt("1.10.13")
    await client.put("/api/settings", json={"dbt_core_version": "1.10.13"})
    body = await _status(client)
    assert body["expected"] == "dbt-core==1.10.13"
    assert body["expected_source"] == "setting"
    assert body["matches"] is True


async def test_setting_pin_drifted(client, installed_dbt) -> None:
    installed_dbt("1.12.6")  # e.g. an adapter upgraded it during a project install
    await client.put("/api/settings", json={"dbt_core_version": "1.10.13"})
    assert (await _status(client))["matches"] is False


async def test_requirements_range_checked(client, installed_dbt, tmp_path: Path) -> None:
    installed_dbt("1.12.6")
    req = tmp_path / "requirements.txt"
    req.write_text("dbt-duckdb\ndbt-core>=1.8,<1.11  # keep below 1.11\n")
    await client.put("/api/settings", json={"global_requirements_path": str(req)})
    body = await _status(client)
    assert body["expected"] == "dbt-core>=1.8,<1.11"
    assert body["expected_source"] == "requirements"
    assert body["matches"] is False


async def test_requirements_without_dbt_core_or_version(client, installed_dbt, tmp_path: Path) -> None:
    installed_dbt("1.12.6")
    req = tmp_path / "requirements.txt"
    req.write_text("dbt-core\n")
    await client.put("/api/settings", json={"global_requirements_path": str(req)})
    body = await _status(client)
    assert body["expected"] == "dbt-core"
    assert body["matches"] is None


async def test_not_installed_still_reports_expected(client, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(init_api, "existing_bin", lambda name: None)
    await client.put("/api/settings", json={"dbt_core_version": "1.10.13"})
    body = await _status(client)
    assert body["installed"] is False
    assert body["expected"] == "dbt-core==1.10.13"
    assert body["matches"] is None


async def test_setting_a_requirements_file_clears_the_version(client, tmp_path: Path) -> None:
    await client.put("/api/settings", json={"dbt_core_version": "1.10.13"})
    req = tmp_path / "requirements.txt"
    req.write_text("dbt-core==1.9.0\n")
    body = (await client.put("/api/settings", json={"global_requirements_path": str(req)})).json()
    assert body["dbt_core_version"] is None
    # Clearing the file later doesn't bring the old version back
    body = (await client.put("/api/settings", json={"global_requirements_path": ""})).json()
    assert body["dbt_core_version"] is None


async def test_version_refused_while_a_file_is_set(client, tmp_path: Path) -> None:
    req = tmp_path / "requirements.txt"
    req.write_text("dbt-duckdb\n")
    await client.put("/api/settings", json={"global_requirements_path": str(req)})
    resp = await client.put("/api/settings", json={"dbt_core_version": "1.10.13"})
    assert resp.status_code == 400
    assert "requirements file" in resp.json()["detail"]
    # Clearing it is always allowed
    assert (await client.put("/api/settings", json={"dbt_core_version": ""})).status_code == 200


async def test_version_allowed_when_the_same_update_clears_the_file(client, tmp_path: Path) -> None:
    req = tmp_path / "requirements.txt"
    req.write_text("dbt-duckdb\n")
    await client.put("/api/settings", json={"global_requirements_path": str(req)})
    body = (await client.put("/api/settings", json={"global_requirements_path": "", "dbt_core_version": "1.9.0"})).json()
    assert body["dbt_core_version"] == "1.9.0"
