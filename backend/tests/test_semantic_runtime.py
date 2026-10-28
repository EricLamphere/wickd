"""MetricFlowRuntime against a fake worker process (no sidecar, no MetricFlow)."""

import asyncio
import os
import sys
from pathlib import Path

import pytest

from app.semantic import runtime as runtime_mod
from app.semantic.runtime import MetricFlowRuntime, RuntimeUnavailable, WorkerRequestError

FAKE = Path(__file__).parent / "fixtures" / "semantic" / "fake_worker.py"


async def _fake_command() -> list[str]:
    return [sys.executable, str(FAKE)]


@pytest.fixture
async def rt():
    runtime = MetricFlowRuntime(command_factory=_fake_command)
    yield runtime
    await runtime.stop()


async def test_round_trip_and_reuse(rt: MetricFlowRuntime) -> None:
    first = await rt.request("explain", {"metrics": ["revenue"]})
    assert first["op"] == "explain"
    assert first["echo"]["metrics"] == ["revenue"]
    second = await rt.request("ping")
    assert second["pid"] == first["pid"]
    assert rt.running


async def test_concurrent_requests_match_by_id(rt: MetricFlowRuntime) -> None:
    results = await asyncio.gather(*(rt.request("echo", {"n": i}) for i in range(10)))
    assert [r["echo"]["n"] for r in results] == list(range(10))


async def test_error_reply_raises(rt: MetricFlowRuntime) -> None:
    with pytest.raises(WorkerRequestError) as exc:
        await rt.request("fail")
    assert exc.value.code == "invalid_query"


async def test_restarts_once_after_a_crash(rt: MetricFlowRuntime, tmp_path: Path) -> None:
    first = await rt.request("ping")
    result = await rt.request("crash_once", {"marker": str(tmp_path / "crashed")})
    assert result["op"] == "crash_once"
    assert result["pid"] != first["pid"]


async def test_gives_up_when_it_keeps_crashing(rt: MetricFlowRuntime) -> None:
    with pytest.raises(RuntimeUnavailable):
        await rt.request("crash")


async def test_timeout(rt: MetricFlowRuntime) -> None:
    with pytest.raises(WorkerRequestError) as exc:
        await rt.request("hang", timeout=0.3)
    assert exc.value.code == "timeout"


async def test_worker_that_never_starts() -> None:
    async def bad() -> list[str]:
        return [sys.executable, "-c", "import sys; print('boom', file=sys.stderr)"]

    runtime = MetricFlowRuntime(command_factory=bad)
    with pytest.raises(RuntimeUnavailable, match="boom"):
        await runtime.request("ping")


async def test_idle_stop(rt: MetricFlowRuntime, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_mod, "IDLE_CHECK_S", 0.05)
    monkeypatch.setattr(runtime_mod, "IDLE_TIMEOUT_S", 0.1)
    await rt.request("ping")
    for _ in range(40):
        if not rt.running:
            break
        await asyncio.sleep(0.05)
    assert not rt.running


@pytest.mark.slow
@pytest.mark.skipif(not os.environ.get("WICKD_SLOW_TESTS"), reason="set WICKD_SLOW_TESTS=1 (builds the sidecar)")
async def test_real_sidecar_explains_fixture(tmp_path_factory: pytest.TempPathFactory, monkeypatch) -> None:
    from app.config import settings

    venv = Path(os.environ.get("WICKD_SLOW_SIDECAR_DIR") or tmp_path_factory.mktemp("mf") / "venv")
    monkeypatch.setattr(settings, "metricflow_venv_dir", venv)
    runtime = MetricFlowRuntime()
    manifest = Path(__file__).parent / "fixtures" / "semantic" / "dbt_1_12" / "semantic_manifest.json"
    try:
        result = await runtime.request(
            "explain",
            {"manifest_path": str(manifest), "dialect": "snowflake", "metrics": ["revenue"], "group_by": ["metric_time__month"]},
            timeout=120,
        )
        assert result["columns"] == ["metric_time__month", "revenue"]
        assert "DATE_TRUNC" in result["sql"]
        validation = await runtime.request("validate", {"manifest_path": str(manifest)})
        assert validation["errors"] == []
    finally:
        await runtime.stop()
