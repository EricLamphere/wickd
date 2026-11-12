"""process_env(): read-only `dbt show` skips the relation cache (on Athena/Glue, listing every
schema's tables before each query took over a minute)."""

from pathlib import Path

from app.dbt.runner import RunRequest, process_env


def _req(command: str, env: dict[str, str] | None) -> RunRequest:
    return RunRequest(project_id=1, project_path=Path("/p"), command=command, env=env)


def test_show_turns_off_cache_population() -> None:
    env = {"A": "1"}
    out = process_env(_req("show", env))
    assert out == {"A": "1", "DBT_POPULATE_CACHE": "false"}
    assert env == {"A": "1"}  # the request's env isn't changed


def test_show_keeps_the_users_own_setting() -> None:
    assert process_env(_req("show", {"DBT_POPULATE_CACHE": "true"}))["DBT_POPULATE_CACHE"] == "true"


def test_show_without_env_inherits_the_process_env(monkeypatch) -> None:
    monkeypatch.setenv("WICKD_TEST_MARKER", "x")
    out = process_env(_req("show", None))
    assert out is not None and out["WICKD_TEST_MARKER"] == "x" and out["DBT_POPULATE_CACHE"] == "false"


def test_other_commands_are_unchanged() -> None:
    env = {"A": "1"}
    assert process_env(_req("run", env)) is env
    assert process_env(_req("build", None)) is None
