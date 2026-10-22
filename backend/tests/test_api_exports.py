import base64
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.db.engine import get_session
from app.db.models import Project
from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def project(tmp_path: Path) -> Project:
    session_gen = app.dependency_overrides[get_session]()
    session = await session_gen.__anext__()
    proj = Project(name="demo", path=str(tmp_path / "demo"), platform="duckdb")
    session.add(proj)
    await session.commit()
    await session.refresh(proj)
    await session_gen.aclose()
    return proj


def _body(directory: Path, **overrides) -> dict:
    return {
        "directory": str(directory),
        "filename": "dag.svg",
        "format": "svg",
        "content": "<svg/>",
        "encoding": "utf8",
        **overrides,
    }


async def test_writes_text_export(client, project, tmp_path: Path):
    res = await client.post(f"/api/projects/{project.id}/exports/dag", json=_body(tmp_path))
    assert res.status_code == 201
    assert res.json()["path"] == str(tmp_path / "dag.svg")
    assert (tmp_path / "dag.svg").read_text() == "<svg/>"


async def test_writes_base64_png(client, project, tmp_path: Path):
    payload = b"\x89PNG\r\n\x1a\nbytes"
    body = _body(
        tmp_path,
        filename="dag",
        format="png",
        content=base64.b64encode(payload).decode(),
        encoding="base64",
    )
    res = await client.post(f"/api/projects/{project.id}/exports/dag", json=body)
    assert res.status_code == 201
    assert (tmp_path / "dag.png").read_bytes() == payload


async def test_invalid_base64_is_400(client, project, tmp_path: Path):
    body = _body(tmp_path, format="png", filename="dag.png", content="!!!", encoding="base64")
    res = await client.post(f"/api/projects/{project.id}/exports/dag", json=body)
    assert res.status_code == 400
    assert res.json()["detail"]["field"] == "content"


async def test_existing_file_is_409_unless_overwrite(client, project, tmp_path: Path):
    (tmp_path / "dag.svg").write_text("old")
    res = await client.post(f"/api/projects/{project.id}/exports/dag", json=_body(tmp_path))
    assert res.status_code == 409
    assert (tmp_path / "dag.svg").read_text() == "old"

    res = await client.post(
        f"/api/projects/{project.id}/exports/dag", json=_body(tmp_path, overwrite=True)
    )
    assert res.status_code == 201
    assert (tmp_path / "dag.svg").read_text() == "<svg/>"


async def test_bad_directory_is_400_with_field(client, project, tmp_path: Path):
    res = await client.post(
        f"/api/projects/{project.id}/exports/dag", json=_body(tmp_path / "missing")
    )
    assert res.status_code == 400
    assert res.json()["detail"]["field"] == "directory"


async def test_unknown_format_is_422(client, project, tmp_path: Path):
    res = await client.post(
        f"/api/projects/{project.id}/exports/dag", json=_body(tmp_path, format="pdf")
    )
    assert res.status_code == 422


async def test_unknown_project_is_404(client, tmp_path: Path):
    res = await client.post("/api/projects/999/exports/dag", json=_body(tmp_path))
    assert res.status_code == 404


async def test_default_dir(client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "Downloads").mkdir()
    res = await client.get("/api/exports/default-dir")
    assert res.status_code == 200
    assert res.json()["path"] == str(tmp_path / "Downloads")


async def test_reveal_rejects_missing_file(client, tmp_path: Path):
    res = await client.post("/api/exports/reveal", json={"path": str(tmp_path / "nope.svg")})
    assert res.status_code == 404
