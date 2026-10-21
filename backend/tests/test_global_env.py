"""Global (default) environment variables: CRUD, layering precedence, and where they apply."""
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import init as init_api
from app.db.engine import get_session
from app.db.models import GlobalEnvVar, GlobalProfile, GlobalProfileVar, Project, ProjectEnvVar
from app.envvars import is_valid_env_key, layer_env
from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _session():
    """The test DB session wired in by conftest's override_db."""
    gen = app.dependency_overrides[get_session]()
    return gen, await gen.__anext__()


# ---- pure layering ----


def test_layer_env_precedence_project_over_profile_over_global() -> None:
    env = layer_env(
        base={"PATH": "/bin", "A": "process"},
        global_vars={"A": "global", "B": "global", "C": "global"},
        profile_vars={"B": "profile", "C": "profile"},
        project_vars={"C": "project"},
    )
    assert env == {"PATH": "/bin", "A": "global", "B": "profile", "C": "project"}


def test_layer_env_does_not_mutate_inputs() -> None:
    base = {"A": "1"}
    layer_env(base=base, global_vars={"A": "2"}, profile_vars={}, project_vars={})
    assert base == {"A": "1"}


@pytest.mark.parametrize("key", ["FOO", "_foo", "a1_B2"])
def test_valid_env_keys(key: str) -> None:
    assert is_valid_env_key(key)


@pytest.mark.parametrize("key", ["", "1FOO", "FOO BAR", "FOO=1", "FOO-BAR"])
def test_invalid_env_keys(key: str) -> None:
    assert not is_valid_env_key(key)


# ---- CRUD ----


async def test_global_env_crud(client: AsyncClient) -> None:
    assert (await client.get("/api/global-env")).json() == []

    resp = await client.put("/api/global-env/PIP_INDEX_URL", json={"value": "https://pypi.example"})
    assert resp.status_code == 200
    await client.put("/api/global-env/AWS_REGION", json={"value": "us-east-1"})
    await client.put("/api/global-env/AWS_REGION", json={"value": "us-west-2"})

    listed = (await client.get("/api/global-env")).json()
    assert listed == [
        {"key": "AWS_REGION", "value": "us-west-2"},
        {"key": "PIP_INDEX_URL", "value": "https://pypi.example"},
    ]

    assert (await client.delete("/api/global-env/AWS_REGION")).status_code == 204
    assert [v["key"] for v in (await client.get("/api/global-env")).json()] == ["PIP_INDEX_URL"]


async def test_global_env_rejects_invalid_key(client: AsyncClient) -> None:
    resp = await client.put("/api/global-env/BAD KEY", json={"value": "x"})
    assert resp.status_code == 422


async def test_global_env_delete_missing_is_noop(client: AsyncClient) -> None:
    assert (await client.delete("/api/global-env/NOPE")).status_code == 204


# ---- project env resolution ----


async def test_project_env_layers_all_three_sources(tmp_path: Path) -> None:
    gen, session = await _session()
    try:
        project = Project(name="p", path=str(tmp_path))
        profile = GlobalProfile(name="dev")
        session.add_all([project, profile])
        await session.flush()
        session.add_all([
            GlobalEnvVar(key="ONLY_GLOBAL", value="g"),
            GlobalEnvVar(key="SHARED", value="g"),
            GlobalProfileVar(profile_id=profile.id, key="SHARED", value="profile"),
            GlobalProfileVar(profile_id=profile.id, key="PROFILE_AND_PROJECT", value="profile"),
            ProjectEnvVar(project_id=project.id, key="PROFILE_AND_PROJECT", value="project"),
            ProjectEnvVar(project_id=project.id, key="active_global_profile_id", value=str(profile.id)),
        ])
        await session.commit()

        env = await init_api.project_env(session, project.id, base={})
    finally:
        await gen.aclose()

    assert env["ONLY_GLOBAL"] == "g"
    assert env["SHARED"] == "profile"
    assert env["PROFILE_AND_PROJECT"] == "project"


async def test_project_env_without_active_profile(tmp_path: Path) -> None:
    gen, session = await _session()
    try:
        project = Project(name="p", path=str(tmp_path))
        session.add(project)
        await session.flush()
        session.add_all([
            GlobalEnvVar(key="SHARED", value="g"),
            ProjectEnvVar(project_id=project.id, key="active_global_profile_id", value="999"),
        ])
        await session.commit()

        env = await init_api.project_env(session, project.id, base={"SHARED": "process"})
    finally:
        await gen.aclose()

    assert env["SHARED"] == "g"


# ---- global setup ----


async def test_global_setup_passes_global_env_to_pip(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    envs: list[dict] = []

    def fake_pip(pip: Path, install_args: list[str], pip_env: dict) -> None:
        envs.append(pip_env)
        init_api._global_output_queue.put(None)

    monkeypatch.setattr(init_api, "_run_pip_in_thread", fake_pip)
    monkeypatch.setattr(init_api, "venv_pip", lambda: tmp_path / "pip")
    await client.put("/api/global-env/PIP_INDEX_URL", json={"value": "https://pypi.example"})

    resp = await client.post("/api/init/global-setup")
    init_api._global_setup_thread.join(timeout=5)

    assert resp.status_code == 200
    assert envs[0]["PIP_INDEX_URL"] == "https://pypi.example"
    assert envs[0]["PYTHONUNBUFFERED"] == "1"
