from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.main import app
from app.projects.workspaces import parse_workspaces


def test_parse_single_and_none() -> None:
    assert parse_workspaces(None) == []
    assert parse_workspaces("  ") == []
    assert parse_workspaces("/a") == [Path("/a")]
    assert parse_workspaces(Path("/a")) == [Path("/a")]


def test_parse_comma_list_trims_and_drops_blanks_and_dupes() -> None:
    assert parse_workspaces(" /a , /b,, /a ,") == [Path("/a"), Path("/b")]


def test_parse_drops_folders_inside_another_listed_one() -> None:
    assert parse_workspaces("/a/inner, /b, /a") == [Path("/b"), Path("/a")]


def test_parse_expands_user(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    assert parse_workspaces("~/x, /y") == [tmp_path / "x", Path("/y")]


def _project(root: Path, name: str) -> None:
    (root / name).mkdir(parents=True)
    (root / name / "dbt_project.yml").write_text(f"name: {name}\nprofile: {name}\n")


async def test_rescan_discovers_every_listed_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    a, b = tmp_path / "a", tmp_path / "b"
    _project(a, "alpha")
    _project(b, "beta")
    monkeypatch.setattr(settings, "dbt_projects_path", None)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.put("/api/settings", json={"dbt_projects_path": f"{a}, {b}"})
        resp = await client.post("/api/projects/rescan")
        assert resp.status_code == 200
        names = sorted(p["name"] for p in resp.json())
        assert names == ["alpha", "beta"]

        # Dropping a folder from the list drops its projects, as with one folder
        await client.put("/api/settings", json={"dbt_projects_path": str(a)})
        names = [p["name"] for p in (await client.post("/api/projects/rescan")).json()]
        assert names == ["alpha"]
