import json
from datetime import UTC, datetime
from pathlib import Path

from app.dbt.run_results import load_run_results, load_run_results_file


def _write_rr(tmp_path: Path, results: list) -> Path:
    path = tmp_path / "run_results.json"
    path.write_text(json.dumps({"metadata": {}, "results": results}))
    return path


def test_missing_file(tmp_path: Path) -> None:
    assert load_run_results(tmp_path / "run_results.json") == []


def test_invalid_json(tmp_path: Path) -> None:
    path = tmp_path / "run_results.json"
    path.write_text("{{{{")
    assert load_run_results(path) == []


def test_success_result(tmp_path: Path) -> None:
    path = _write_rr(
        tmp_path,
        [{"unique_id": "model.proj.orders", "status": "success", "message": None, "execution_time": 1.2}],
    )
    results = load_run_results(path)
    assert len(results) == 1
    assert results[0].unique_id == "model.proj.orders"
    assert results[0].status == "success"


def test_fail_maps_to_error(tmp_path: Path) -> None:
    path = _write_rr(
        tmp_path,
        [{"unique_id": "test.proj.not_null", "status": "fail", "message": "1 rows", "execution_time": 0.5}],
    )
    results = load_run_results(path)
    assert results[0].status == "error"


def test_pass_maps_to_success(tmp_path: Path) -> None:
    path = _write_rr(
        tmp_path,
        [{"unique_id": "test.proj.unique", "status": "pass", "message": None, "execution_time": 0.1}],
    )
    results = load_run_results(path)
    assert results[0].status == "success"


def test_skipped_maps_to_idle(tmp_path: Path) -> None:
    path = _write_rr(
        tmp_path,
        [{"unique_id": "model.proj.x", "status": "skipped", "message": None, "execution_time": 0.0}],
    )
    results = load_run_results(path)
    assert results[0].status == "idle"


# ── timing / adapter capture ────────────────────────────────────────────────


def _write_doc(tmp_path: Path, doc: dict) -> Path:
    path = tmp_path / "run_results.json"
    path.write_text(json.dumps(doc))
    return path


def _timing(name: str, start: str, end: str) -> dict:
    return {"name": name, "started_at": start, "completed_at": end}


def test_dbt_110_shape_captures_timing_thread_and_adapter(tmp_path: Path) -> None:
    path = _write_doc(tmp_path, {
        "elapsed_time": 12.5,
        "args": {"threads": 8},
        "results": [{
            "unique_id": "model.proj.orders",
            "status": "success",
            "message": "OK",
            "execution_time": 2.0,
            "thread_id": "Thread-1 (worker)",
            "timing": [
                _timing("compile", "2026-10-22T10:00:00.000000Z", "2026-10-22T10:00:00.500000Z"),
                _timing("execute", "2026-10-22T10:00:00.500000Z", "2026-10-22T10:00:02.500000Z"),
            ],
            "adapter_response": {"_message": "OK", "rows_affected": 42, "bytes_processed": 1024},
        }],
    })
    parsed = load_run_results_file(path)
    assert parsed.elapsed_time == 12.5
    assert parsed.threads == 8
    [r] = parsed.results
    assert r.started_at == datetime(2026, 10, 22, 10, 0, 0, 500000, tzinfo=UTC)
    assert r.completed_at == datetime(2026, 10, 22, 10, 0, 2, 500000, tzinfo=UTC)
    assert r.thread_id == "Thread-1 (worker)"
    assert r.rows_affected == 42
    assert r.bytes_processed == 1024
    assert r.adapter_response == {"_message": "OK", "rows_affected": 42, "bytes_processed": 1024}


def test_dbt_15_shape_without_threads_counts_distinct_thread_ids(tmp_path: Path) -> None:
    results = [
        {"unique_id": f"model.proj.m{i}", "status": "success", "execution_time": 1.0,
         "thread_id": f"Thread-{i % 2 + 1}", "timing": [], "adapter_response": {}}
        for i in range(4)
    ]
    parsed = load_run_results_file(_write_doc(tmp_path, {"elapsed_time": 3.0, "args": {}, "results": results}))
    assert parsed.threads == 2
    assert all(r.started_at is None and r.completed_at is None for r in parsed.results)
    assert all(r.rows_affected is None for r in parsed.results)


def test_errored_node_falls_back_to_compile_timing(tmp_path: Path) -> None:
    path = _write_doc(tmp_path, {"results": [{
        "unique_id": "model.proj.broken",
        "status": "error",
        "execution_time": 0.2,
        "timing": [_timing("compile", "2026-10-22T10:00:00Z", "2026-10-22T10:00:00.200000Z")],
    }]})
    [r] = load_run_results_file(path).results
    assert r.started_at == datetime(2026, 10, 22, 10, 0, 0, tzinfo=UTC)
    assert r.completed_at == datetime(2026, 10, 22, 10, 0, 0, 200000, tzinfo=UTC)


def test_missing_timing_and_garbage_values_are_tolerated(tmp_path: Path) -> None:
    path = _write_doc(tmp_path, {"elapsed_time": "soon", "args": None, "results": [{
        "unique_id": "model.proj.x",
        "status": "success",
        "execution_time": 1.0,
        "timing": [{"name": "execute", "started_at": None, "completed_at": "not a date"}],
        "adapter_response": {"rows_affected": "many", "bytes_processed": True},
        "thread_id": 7,
    }]})
    parsed = load_run_results_file(path)
    assert parsed.elapsed_time is None
    assert parsed.threads is None
    [r] = parsed.results
    assert (r.started_at, r.completed_at, r.thread_id) == (None, None, None)
    assert (r.rows_affected, r.bytes_processed) == (None, None)


def test_oversized_adapter_response_keeps_scalars_only(tmp_path: Path) -> None:
    path = _write_doc(tmp_path, {"results": [{
        "unique_id": "model.proj.x",
        "status": "success",
        "adapter_response": {"rows_affected": 3, "query_id": "abc", "plan": ["x" * 100] * 50},
    }]})
    [r] = load_run_results_file(path).results
    assert r.adapter_response == {"rows_affected": 3, "query_id": "abc"}
