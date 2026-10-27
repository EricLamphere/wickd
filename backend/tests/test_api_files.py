from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import files as files_api
from app.config import settings
from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _seed(client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[int, Path]:
    monkeypatch.setattr(settings, "dbt_projects_path", tmp_path)
    d = tmp_path / "proj"
    (d / "models" / "staging").mkdir(parents=True)
    (d / "models" / "marts").mkdir()
    (d / "dbt_project.yml").write_text("name: proj\nprofile: p\nversion: '1.0'\n")
    (d / "models" / "staging" / "stg_a.sql").write_text("select 1")
    (d / "models" / "marts" / "orders.sql").write_text("select 2")
    resp = await client.post("/api/projects/rescan")
    return resp.json()[0]["id"], d


async def test_list_shows_non_text_files(client, tmp_path, monkeypatch) -> None:
    pid, d = await _seed(client, tmp_path, monkeypatch)
    (d / ".gitignore").write_text("target/\n")
    (d / "dev.duckdb").write_bytes(b"DUCK\x00")
    names = {n["name"] for n in (await client.get(f"/api/projects/{pid}/files")).json()}
    assert {".gitignore", "dev.duckdb", "models", "dbt_project.yml"} <= names


async def test_content_reads_extensionless_text_but_not_binary(client, tmp_path, monkeypatch) -> None:
    pid, d = await _seed(client, tmp_path, monkeypatch)
    (d / ".gitignore").write_text("target/\n")
    (d / "dev.duckdb").write_bytes(b"DUCK\x00")
    ok = await client.get(f"/api/projects/{pid}/files/content", params={"path": ".gitignore"})
    assert ok.status_code == 200 and ok.json()["content"] == "target/\n"
    binary = await client.get(f"/api/projects/{pid}/files/content", params={"path": "dev.duckdb"})
    assert binary.status_code == 400


async def test_move(client, tmp_path, monkeypatch) -> None:
    pid, d = await _seed(client, tmp_path, monkeypatch)
    r = await client.post(
        f"/api/projects/{pid}/files/move",
        json={"paths": ["models/staging/stg_a.sql"], "dest_dir": "models/marts"},
    )
    assert r.status_code == 200
    assert r.json() == [{"src": "models/staging/stg_a.sql", "dst": "models/marts/stg_a.sql", "is_dir": False}]
    assert (d / "models" / "marts" / "stg_a.sql").exists()


async def test_move_to_root(client, tmp_path, monkeypatch) -> None:
    pid, d = await _seed(client, tmp_path, monkeypatch)
    r = await client.post(f"/api/projects/{pid}/files/move", json={"paths": ["models/staging"], "dest_dir": ""})
    assert r.status_code == 200
    assert (d / "staging" / "stg_a.sql").exists()


async def test_move_conflict_is_409(client, tmp_path, monkeypatch) -> None:
    pid, d = await _seed(client, tmp_path, monkeypatch)
    (d / "models" / "marts" / "stg_a.sql").write_text("other")
    r = await client.post(
        f"/api/projects/{pid}/files/move",
        json={"paths": ["models/staging/stg_a.sql"], "dest_dir": "models/marts"},
    )
    assert r.status_code == 409
    assert (d / "models" / "staging" / "stg_a.sql").exists()


async def test_move_into_itself_is_400(client, tmp_path, monkeypatch) -> None:
    pid, _ = await _seed(client, tmp_path, monkeypatch)
    r = await client.post(f"/api/projects/{pid}/files/move", json={"paths": ["models"], "dest_dir": "models/marts"})
    assert r.status_code == 400


async def test_move_outside_project_is_400(client, tmp_path, monkeypatch) -> None:
    pid, _ = await _seed(client, tmp_path, monkeypatch)
    r = await client.post(f"/api/projects/{pid}/files/move", json={"paths": ["models/marts"], "dest_dir": ".."})
    assert r.status_code == 400


async def test_copy_duplicates_in_place(client, tmp_path, monkeypatch) -> None:
    pid, d = await _seed(client, tmp_path, monkeypatch)
    r = await client.post(
        f"/api/projects/{pid}/files/copy",
        json={"paths": ["models/marts/orders.sql"], "dest_dir": "models/marts"},
    )
    assert r.status_code == 200
    assert r.json()[0]["dst"] == "models/marts/orders copy.sql"
    assert (d / "models" / "marts" / "orders.sql").exists()


async def test_upload_with_folders(client, tmp_path, monkeypatch) -> None:
    pid, d = await _seed(client, tmp_path, monkeypatch)
    r = await client.post(
        f"/api/projects/{pid}/files/upload",
        data={"dest_dir": "models"},
        files=[("files", ("new/x.sql", b"select 9", "application/octet-stream"))],
    )
    assert r.status_code == 201
    assert r.json() == [{"name": "x.sql", "path": "models/new/x.sql", "is_dir": False, "children": None}]
    assert (d / "models" / "new" / "x.sql").read_text() == "select 9"


async def test_upload_conflict_then_overwrite(client, tmp_path, monkeypatch) -> None:
    pid, d = await _seed(client, tmp_path, monkeypatch)
    payload = [("files", ("orders.sql", b"select 42", "text/plain"))]
    r = await client.post(f"/api/projects/{pid}/files/upload", data={"dest_dir": "models/marts"}, files=payload)
    assert r.status_code == 409
    r = await client.post(
        f"/api/projects/{pid}/files/upload",
        data={"dest_dir": "models/marts", "overwrite": "true"},
        files=payload,
    )
    assert r.status_code == 201
    assert (d / "models" / "marts" / "orders.sql").read_text() == "select 42"


async def test_upload_traversal_is_400(client, tmp_path, monkeypatch) -> None:
    pid, _ = await _seed(client, tmp_path, monkeypatch)
    r = await client.post(
        f"/api/projects/{pid}/files/upload",
        data={"dest_dir": ""},
        files=[("files", ("../evil.sql", b"x", "text/plain"))],
    )
    assert r.status_code == 400


async def test_reveal(client, tmp_path, monkeypatch) -> None:
    pid, d = await _seed(client, tmp_path, monkeypatch)
    monkeypatch.setattr(files_api.sys, "platform", "darwin")
    proc = AsyncMock()
    with patch.object(files_api.asyncio, "create_subprocess_exec", new=AsyncMock(return_value=proc)) as spawn:
        r = await client.post(f"/api/projects/{pid}/files/reveal", json={"path": "models/marts/orders.sql"})
    assert r.status_code == 204
    assert spawn.call_args.args == ("open", "-R", str(d / "models" / "marts" / "orders.sql"))


async def test_reveal_linux_opens_parent_dir(client, tmp_path, monkeypatch) -> None:
    pid, d = await _seed(client, tmp_path, monkeypatch)
    monkeypatch.setattr(files_api.sys, "platform", "linux")
    proc = AsyncMock()
    with patch.object(files_api.asyncio, "create_subprocess_exec", new=AsyncMock(return_value=proc)) as spawn:
        r = await client.post(f"/api/projects/{pid}/files/reveal", json={"path": "models/marts/orders.sql"})
    assert r.status_code == 204
    assert spawn.call_args.args == ("xdg-open", str(d / "models" / "marts"))


async def test_reveal_missing_is_404(client, tmp_path, monkeypatch) -> None:
    pid, _ = await _seed(client, tmp_path, monkeypatch)
    r = await client.post(f"/api/projects/{pid}/files/reveal", json={"path": "nope.sql"})
    assert r.status_code == 404
