"""The dbt Charts sidecar venv: marker / rebuild logic and adapter extras (nothing is installed)."""

import json
from pathlib import Path

import pytest

from app import sidecar as shared
from app.charts import sidecar_env
from app.config import settings


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    return tmp_path


def _fake_venv(python: str, version: str = sidecar_env.DCT_VERSION, extras: list[str] | None = None) -> None:
    venv = sidecar_env.venv_dir()
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "dct").write_text("")
    (venv / sidecar_env.MARKER_NAME).write_text(json.dumps({"version": version, "python": python, "extras": extras or []}))


def test_missing(data_dir: Path) -> None:
    assert sidecar_env.status().state == "missing"


def test_ready_and_needs_extra(data_dir: Path, tmp_path: Path) -> None:
    python = tmp_path / "python3"
    python.write_text("")
    _fake_venv(str(python), extras=["snowflake"])
    assert sidecar_env.status().state == "ready"
    assert sidecar_env.status("snowflake").state == "ready"
    assert sidecar_env.status("bigquery").state == "needs_extra"


def test_stale_on_new_pin_or_missing_python(data_dir: Path, tmp_path: Path) -> None:
    _fake_venv(str(tmp_path / "gone"))
    assert sidecar_env.status().state == "stale"


def test_stale_on_other_version(data_dir: Path, tmp_path: Path) -> None:
    python = tmp_path / "python3"
    python.write_text("")
    _fake_venv(str(python), version="0.0.1")
    assert sidecar_env.status().state == "stale"


def test_adds_an_extra_without_rebuilding(data_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    python = tmp_path / "python3"
    python.write_text("")
    _fake_venv(str(python), extras=["postgresql"])
    calls: list[list[str]] = []
    monkeypatch.setattr(shared, "run_step", lambda args, what, **kw: calls.append(args))
    sidecar_env.ensure_sidecar("snowflake")
    assert len(calls) == 1
    assert calls[0][-1] == f"dbt-charts[postgresql,snowflake]=={sidecar_env.DCT_VERSION}"
    assert sidecar_env.status("snowflake").extras == ("postgresql", "snowflake")


def test_build_failure_removes_the_venv(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shared, "choose_python", lambda *a: "/usr/bin/python3")

    def fail(args: list[str], what: str, **kw: object) -> None:
        if "pip" in args:
            raise shared.SidecarUnavailable("pip failed")
        sidecar_env.venv_dir().mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(shared, "run_step", fail)
    with pytest.raises(shared.SidecarUnavailable):
        sidecar_env.ensure_sidecar()
    assert not sidecar_env.venv_dir().exists()


def test_requirement() -> None:
    assert sidecar_env.requirement(()) == f"dbt-charts=={sidecar_env.DCT_VERSION}"
    assert sidecar_env.requirement(("trino", "bigquery")) == f"dbt-charts[bigquery,trino]=={sidecar_env.DCT_VERSION}"


@pytest.mark.parametrize(("adapter", "extra", "unsupported"), [
    ("duckdb", None, False), ("postgres", "postgresql", False), ("Snowflake", "snowflake", False),
    (None, None, False), ("oracle", None, True),
])
def test_extras(adapter: str | None, extra: str | None, unsupported: bool) -> None:
    assert sidecar_env.extra_for(adapter) == extra
    assert sidecar_env.unsupported_adapter(adapter) is unsupported


def test_adapter_type_from_profiles(tmp_path: Path) -> None:
    (tmp_path / "dbt_project.yml").write_text("name: p\nprofile: shop\n")
    (tmp_path / "profiles.yml").write_text(
        "shop:\n  target: dev\n  outputs:\n    dev: {type: duckdb}\n    prod: {type: snowflake}\n"
    )
    assert sidecar_env.adapter_type(tmp_path, {}) == "duckdb"
    assert sidecar_env.adapter_type(tmp_path, {"DBT_TARGET": "prod"}) == "snowflake"
    assert sidecar_env.adapter_type(tmp_path, {"DBT_TARGET": "nope"}) is None
