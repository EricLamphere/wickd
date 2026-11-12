"""Removing a custom init step keeps its script unless asked to delete it."""
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def project(client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[int, Path]:
    proj = tmp_path / "jaffle"
    proj.mkdir()
    (proj / "dbt_project.yml").write_text("name: jaffle\nprofile: jaffle\n")
    monkeypatch.setattr(settings, "dbt_projects_path", tmp_path)
    resp = await client.post("/api/projects/rescan")
    return resp.json()[0]["id"], proj


async def _custom_steps(client: AsyncClient, pid: int) -> list[str]:
    steps = (await client.get(f"/api/projects/{pid}/init/steps")).json()
    return [s["name"] for s in steps if not s["is_base"]]


async def test_remove_keeps_script_and_step_stays_removed(client: AsyncClient, project: tuple[int, Path]) -> None:
    pid, proj = project
    await client.post(f"/api/projects/{pid}/init/steps", json={"name": "seed", "content": "echo hi\n"})
    assert await _custom_steps(client, pid) == ["custom: seed"]

    resp = await client.delete(f"/api/projects/{pid}/init/steps/seed")

    assert resp.json() == {"ok": True, "script_deleted": False}
    assert (proj / "wickd/init/seed.sh").read_text() == "echo hi\n"
    # The disk sync doesn't bring it back
    assert await _custom_steps(client, pid) == []
    assert await _custom_steps(client, pid) == []


async def test_remove_with_delete_script_deletes_file(client: AsyncClient, project: tuple[int, Path]) -> None:
    pid, proj = project
    await client.post(f"/api/projects/{pid}/init/steps", json={"name": "seed", "content": "echo hi\n"})

    resp = await client.delete(f"/api/projects/{pid}/init/steps/seed", params={"delete_script": "true"})

    assert resp.json()["script_deleted"] is True
    assert not (proj / "wickd/init/seed.sh").exists()
    assert await _custom_steps(client, pid) == []


async def test_relinking_a_removed_script_adds_it_back(client: AsyncClient, project: tuple[int, Path]) -> None:
    pid, proj = project
    await client.get(f"/api/projects/{pid}/init/steps")  # base steps exist
    await client.post(f"/api/projects/{pid}/init/steps", json={"name": "seed", "content": "echo hi\n"})
    await client.delete(f"/api/projects/{pid}/init/steps/seed")

    resp = await client.post(f"/api/projects/{pid}/init/steps/link", json={"path": "wickd/init/seed.sh"})

    assert resp.status_code == 200
    steps = (await client.get(f"/api/projects/{pid}/init/steps")).json()
    assert [s["name"] for s in steps][-1] == "custom: seed"
    assert (proj / "wickd/init/seed.sh").read_text() == "echo hi\n"


async def test_linked_external_script_never_deleted(
    client: AsyncClient, project: tuple[int, Path], tmp_path: Path
) -> None:
    pid, _proj = project
    external = tmp_path / "shared.sh"
    external.write_text("echo shared\n")
    await client.post(f"/api/projects/{pid}/init/steps/link", json={"path": str(external)})

    resp = await client.delete(f"/api/projects/{pid}/init/steps/shared", params={"delete_script": "true"})

    assert resp.json()["script_deleted"] is False
    assert external.exists()
    assert await _custom_steps(client, pid) == []


async def test_removed_script_deleted_by_hand_drops_hidden_row(client: AsyncClient, project: tuple[int, Path]) -> None:
    pid, proj = project
    await client.post(f"/api/projects/{pid}/init/steps", json={"name": "seed", "content": "echo hi\n"})
    await client.delete(f"/api/projects/{pid}/init/steps/seed")
    (proj / "wickd/init/seed.sh").unlink()
    await client.get(f"/api/projects/{pid}/init/steps")  # sync drops the hidden row

    # A new script with that name is a fresh step again
    (proj / "wickd/init/seed.sh").write_text("echo again\n")
    assert await _custom_steps(client, pid) == ["custom: seed"]


async def test_base_step_cannot_be_removed(client: AsyncClient, project: tuple[int, Path]) -> None:
    pid, _proj = project
    await client.get(f"/api/projects/{pid}/init/steps")
    # base steps aren't addressed as custom:, so this is simply a no-op on an unknown name
    resp = await client.delete(f"/api/projects/{pid}/init/steps/nope")
    assert resp.json() == {"ok": True, "script_deleted": False}
