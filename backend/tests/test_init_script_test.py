"""POST /init/test-script: runs editor content with the project env, persists nothing."""
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.api import init_script_test
from app.db.engine import get_session
from app.db.models import GlobalEnvVar, InitStep, Project, ProjectEnvVar
from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _session():
    gen = app.dependency_overrides[get_session]()
    return gen, await gen.__anext__()


async def _project(tmp_path: Path, **env: str) -> int:
    gen, session = await _session()
    try:
        project = Project(name="p", path=str(tmp_path))
        session.add(project)
        await session.flush()
        session.add_all(ProjectEnvVar(project_id=project.id, key=k, value=v) for k, v in env.items())
        await session.commit()
        return project.id
    finally:
        await gen.aclose()


async def test_runs_script_with_layered_env(client: AsyncClient, tmp_path: Path) -> None:
    pid = await _project(tmp_path, PROJECT_VAR="from-project")
    gen, session = await _session()
    try:
        session.add(GlobalEnvVar(key="GLOBAL_VAR", value="from-global"))
        await session.commit()
    finally:
        await gen.aclose()

    resp = await client.post(
        f"/api/projects/{pid}/init/test-script",
        json={"content": 'echo "$PROJECT_VAR $GLOBAL_VAR"\necho oops >&2\n'},
    )

    body = resp.json()
    assert resp.status_code == 200
    assert body["ok"] is True
    assert body["return_code"] == 0
    assert body["log"].splitlines() == ["from-project from-global", "oops"]


async def test_failure_reports_return_code(client: AsyncClient, tmp_path: Path) -> None:
    pid = await _project(tmp_path)
    resp = await client.post(
        f"/api/projects/{pid}/init/test-script",
        json={"content": "echo before\nfalse\necho after\n"},
    )
    body = resp.json()
    assert body["ok"] is False
    assert body["return_code"] == 1
    assert body["log"] == "before"  # set -e stops at `false`


async def test_unset_var_fails_like_a_real_run(client: AsyncClient, tmp_path: Path) -> None:
    pid = await _project(tmp_path)
    resp = await client.post(
        f"/api/projects/{pid}/init/test-script",
        json={"content": "echo $DEFINITELY_NOT_SET_WICKD\n"},
    )
    assert resp.json()["ok"] is False


async def test_reports_captured_and_missing_vars_without_saving(
    client: AsyncClient, tmp_path: Path
) -> None:
    pid = await _project(tmp_path)
    resp = await client.post(
        f"/api/projects/{pid}/init/test-script",
        json={"content": "export TOKEN=abc\n", "captured_vars": ["TOKEN", "NOPE", " "]},
    )
    body = resp.json()
    assert body["captured"] == {"TOKEN": "abc"}
    assert body["missing"] == ["NOPE"]

    gen, session = await _session()
    try:
        rows = (await session.execute(select(ProjectEnvVar).where(ProjectEnvVar.key == "TOKEN"))).all()
    finally:
        await gen.aclose()
    assert rows == []


async def test_runs_in_the_init_dir_or_the_steps_script_dir(
    client: AsyncClient, tmp_path: Path
) -> None:
    init_dir = tmp_path / "wickd" / "init"
    init_dir.mkdir(parents=True)
    linked_dir = tmp_path / "elsewhere"
    linked_dir.mkdir()
    pid = await _project(tmp_path)
    gen, session = await _session()
    try:
        session.add(InitStep(
            project_id=pid, name="custom: linked", order=0, is_base=False,
            enabled=True, script_path=str(linked_dir / "linked.sh"),
        ))
        await session.commit()
    finally:
        await gen.aclose()

    new = await client.post(f"/api/projects/{pid}/init/test-script", json={"content": "pwd\n"})
    linked = await client.post(
        f"/api/projects/{pid}/init/test-script", json={"content": "pwd\n", "step_name": "linked"}
    )

    assert Path(new.json()["log"]).resolve() == init_dir.resolve()
    assert Path(linked.json()["log"]).resolve() == linked_dir.resolve()


async def test_timeout_kills_the_script(
    client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(init_script_test, "TEST_TIMEOUT_S", 0.3)
    pid = await _project(tmp_path)
    resp = await client.post(
        f"/api/projects/{pid}/init/test-script", json={"content": "echo start\nsleep 30\n"}
    )
    body = resp.json()
    assert body["timed_out"] is True
    assert body["ok"] is False
    assert body["log"].startswith("start")


async def test_unknown_project_404(client: AsyncClient) -> None:
    resp = await client.post("/api/projects/999/init/test-script", json={"content": "true"})
    assert resp.status_code == 404
