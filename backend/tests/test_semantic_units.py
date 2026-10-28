"""Small pure pieces of the semantic layer: summary, mode, auto-parse debounce, pip diff."""

import asyncio
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.health.summary import summarize_semantic
from app.semantic import autoparse
from app.semantic.dbt_change import adapter_packages, diff_report, install_args, resolution_error
from app.semantic.mode import normalize_global, resolve
from app.semantic.service import drop_conversion_warnings

NOW = datetime(2026, 10, 27, tzinfo=UTC)


def _snap(results: dict, status: str = "done", digest: str | None = "aaa") -> dict:
    return {"status": status, "results": results, "finished_at": NOW, "manifest_hash": digest}


def test_summarize_semantic_states() -> None:
    assert summarize_semantic(None, metricflow_off=False, manifest_hash="aaa").status == "not_run"
    off = summarize_semantic(_snap({}), metricflow_off=True, manifest_hash="aaa")
    assert (off.status, off.headline) == ("not_run", "MetricFlow is off for this project")
    assert summarize_semantic(_snap({}, "running"), metricflow_off=False, manifest_hash="aaa").status == "running"
    assert summarize_semantic(_snap({}, "error"), metricflow_off=False, manifest_hash="aaa").status == "fail"

    ok = summarize_semantic(_snap({"errors": [], "warnings": []}), metricflow_off=False, manifest_hash="aaa")
    assert (ok.status, ok.headline, ok.issues, ok.stale_reasons) == ("ok", "Semantic layer is valid", 0, ())

    warn = summarize_semantic(_snap({"errors": [], "warnings": [{}], "future_errors": [{}]}),
                              metricflow_off=False, manifest_hash="bbb")
    assert (warn.status, warn.headline, warn.issues) == ("warn", "2 warnings", 2)
    assert warn.stale_reasons == ("The semantic layer changed since this check",)

    fail = summarize_semantic(
        _snap({"errors": [{}, {}], "warnings": [], "warehouse": [{"ok": True}, {"ok": False}]}),
        metricflow_off=False, manifest_hash="aaa",
    )
    assert (fail.status, fail.headline, fail.issues) == ("fail", "2 errors · 1 metric failed in the warehouse", 3)


def test_summarize_semantic_blocked() -> None:
    blocked = summarize_semantic(_snap({"errors": []}), metricflow_off=False, manifest_hash="aaa",
                                 blocked_reason="needs dbt-core 1.12")
    assert (blocked.status, blocked.headline, blocked.issues, blocked.runnable) == ("warn", "needs dbt-core 1.12", 1, False)
    assert summarize_semantic(None, metricflow_off=True, manifest_hash=None).runnable is False
    assert summarize_semantic(None, metricflow_off=False, manifest_hash=None).runnable is True


@pytest.mark.parametrize(("project", "global_", "expected"), [
    ("", "auto", ("auto", "global")),
    ("", "off", ("off", "global")),
    ("off", "auto", ("off", "project")),
    ("auto", "off", ("auto", "project")),
    (None, None, ("auto", "global")),
    ("weird", "OFF", ("off", "global")),
])
def test_resolve_mode(project, global_, expected) -> None:
    effective = resolve(project, global_)
    assert (effective.mode, effective.source) == expected


def test_normalize_global() -> None:
    assert normalize_global(" Off ") == "off"
    assert normalize_global("nope") == "auto"


async def test_autoparse_debounces(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    parsed: list[int] = []

    async def fake_parse(project_id: int, project_path: Path) -> None:
        parsed.append(project_id)

    monkeypatch.setattr(autoparse, "_maybe_parse", fake_parse)
    for _ in range(5):
        autoparse.schedule(7, tmp_path, delay=0.05)
        await asyncio.sleep(0.01)
    autoparse.schedule(8, tmp_path, delay=0.05)
    await asyncio.sleep(0.15)
    assert sorted(parsed) == [7, 8]


async def test_autoparse_cancel_all(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    parsed: list[int] = []

    async def fake_parse(project_id: int, project_path: Path) -> None:
        parsed.append(project_id)

    monkeypatch.setattr(autoparse, "_maybe_parse", fake_parse)
    autoparse.schedule(9, tmp_path, delay=0.05)
    autoparse.cancel_all()
    await asyncio.sleep(0.1)
    assert parsed == []


def test_is_yaml_change() -> None:
    assert autoparse.is_yaml_change(["models/a.sql", "models/schema.yml"])
    assert not autoparse.is_yaml_change(["models/a.sql"])


def test_adapters_and_install_args() -> None:
    installed = {"dbt-core": "1.10.2", "dbt-adapters": "1.16", "dbt-snowflake": "1.10.2", "dbt-duckdb": "1.10.0",
                 "dbt-metricflow": "0.13.0", "requests": "2"}
    assert adapter_packages(installed) == ["dbt-duckdb", "dbt-snowflake"]
    assert install_args("1.12.6", ["dbt-duckdb"], want_cli=False) == ["dbt-core==1.12.6", "dbt-duckdb"]


def test_diff_report_classifies_changes() -> None:
    report = {"install": [
        {"metadata": {"name": "dbt-core", "version": "1.9.11"}},
        {"metadata": {"name": "Dbt_Adapters", "version": "1.16.3"}},
        {"metadata": {"name": "new-pkg", "version": "1.0"}},
        {"metadata": {}},
    ]}
    changes = diff_report(report, {"dbt-core": "1.10.2", "dbt-adapters": "1.16.3"})
    assert [(c.name, c.change) for c in changes] == [("dbt-core", "downgrade"), ("new-pkg", "install")]


def test_resolution_error_keeps_the_useful_lines() -> None:
    stderr = "Collecting x\nINFO: pip is looking\nERROR: Cannot install a because b requires c<2\nERROR: ResolutionImpossible\n"
    assert resolution_error(stderr) == "ERROR: Cannot install a because b requires c<2\nERROR: ResolutionImpossible"
    assert resolution_error("") == "pip couldn't resolve this version."


def test_drop_conversion_warnings_only_for_measure_only_cumulative_metrics() -> None:
    manifest = {"metrics": [
        {"name": "cumulative_revenue", "type": "cumulative",
         "type_params": {"measure": {"name": "net_revenue"}, "cumulative_type_params": {"window": None}}},
        {"name": "both_inputs", "type": "cumulative",
         "type_params": {"measure": {"name": "x"}, "cumulative_type_params": {"metric": {"name": "y"}}}},
        {"name": "revenue", "type": "simple", "type_params": {"measure": {"name": "net_revenue"}}},
    ]}
    both = "should not have both a measure and a metric as inputs. The measure will be ignored"
    results = {"errors": [], "warnings": [
        {"object_name": "cumulative_revenue", "message": f"Cumulative metric 'cumulative_revenue' {both}"},
        {"object_name": "both_inputs", "message": f"Cumulative metric 'both_inputs' {both}"},
        {"object_name": "cumulative_revenue", "message": "something else"},
    ]}
    kept = drop_conversion_warnings(results, manifest)["warnings"]
    assert [(w["object_name"], w["message"][:20]) for w in kept] == [
        ("both_inputs", "Cumulative metric 'b"),
        ("cumulative_revenue", "something else"),
    ]
    assert drop_conversion_warnings({"warnings": []}, {}) == {"warnings": []}


def test_project_log_command_line_is_shell_quoted(tmp_path: Path) -> None:
    from app.dbt.runner import RunRequest, command_line

    sql = "-- Read Elements From Semantic Model 'orders'\nSELECT 1 AS a"
    req = RunRequest(project_id=1, project_path=tmp_path, command="show", extra=("--inline", sql, "--limit", "5"))
    line = command_line(req)
    assert line.startswith("dbt show --inline '-- Read Elements From Semantic Model '\"'\"'orders'\"'\"'\nSELECT 1 AS a'")
    assert line.endswith(" --limit 5")
    plain = RunRequest(project_id=1, project_path=tmp_path, command="run", select="my_model+")
    assert command_line(plain) == "dbt run --select my_model+"
