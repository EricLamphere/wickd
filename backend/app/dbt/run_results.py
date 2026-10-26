import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.logging_setup import get_logger

log = get_logger(__name__)

# adapter_response is stored per node in run history; keep it small.
ADAPTER_RESPONSE_MAX_CHARS = 2048


@dataclass(frozen=True)
class NodeResult:
    unique_id: str
    status: str  # success | error | fail | pass | skipped | warn | runtime error
    message: str | None
    execution_time: float | None
    # Timing + adapter details — None when dbt didn't write them (older versions, errored nodes)
    started_at: datetime | None = None
    completed_at: datetime | None = None
    thread_id: str | None = None
    rows_affected: int | None = None
    bytes_processed: int | None = None
    adapter_response: dict[str, Any] | None = None


@dataclass(frozen=True)
class RunResultsFile:
    results: list[NodeResult] = field(default_factory=list)
    elapsed_time: float | None = None
    # --threads for the run; dbt doesn't always record it, so falls back to distinct thread ids
    threads: int | None = None


def _normalize_status(raw: str | None) -> str:
    if not raw:
        return "idle"
    lower = raw.lower().strip()
    mapping = {
        "success": "success",
        "pass": "success",
        "error": "error",
        "fail": "error",
        "runtime error": "error",
        "skipped": "idle",
        "warn": "warn",
    }
    return mapping.get(lower, lower)


def _parse_ts(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _as_int(raw: Any) -> int | None:
    # bool is an int subclass; a True "bytes_processed" is junk, not 1
    return raw if isinstance(raw, int) and not isinstance(raw, bool) else None


def _as_float(raw: Any) -> float | None:
    if isinstance(raw, bool) or not isinstance(raw, int | float):
        return None
    return float(raw)


def _timing_window(timing: Any) -> tuple[datetime | None, datetime | None]:
    """The execute step's window; the compile step's when execute is missing (e.g. errors)."""
    if not isinstance(timing, list):
        return None, None
    steps = {t.get("name"): t for t in timing if isinstance(t, dict)}
    for name in ("execute", "compile"):
        step = steps.get(name)
        if step is None:
            continue
        started, completed = _parse_ts(step.get("started_at")), _parse_ts(step.get("completed_at"))
        if started is not None or completed is not None:
            return started, completed
    return None, None


def _capped_adapter_response(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not raw:
        return None
    if len(json.dumps(raw, default=str)) <= ADAPTER_RESPONSE_MAX_CHARS:
        return raw
    scalars = {k: v for k, v in raw.items() if isinstance(v, str | int | float | bool) or v is None}
    if scalars and len(json.dumps(scalars)) <= ADAPTER_RESPONSE_MAX_CHARS:
        return scalars
    return None


def _parse_entry(entry: dict[str, Any], unique_id: str) -> NodeResult:
    started_at, completed_at = _timing_window(entry.get("timing"))
    adapter = entry.get("adapter_response") if isinstance(entry.get("adapter_response"), dict) else {}
    thread_id = entry.get("thread_id")
    return NodeResult(
        unique_id=unique_id,
        status=_normalize_status(entry.get("status")),
        message=entry.get("message"),
        execution_time=entry.get("execution_time"),
        started_at=started_at,
        completed_at=completed_at,
        thread_id=thread_id if isinstance(thread_id, str) and thread_id else None,
        rows_affected=_as_int(adapter.get("rows_affected")),
        bytes_processed=_as_int(adapter.get("bytes_processed")),
        adapter_response=_capped_adapter_response(adapter),
    )


def _thread_count(data: dict[str, Any], results: list[NodeResult]) -> int | None:
    args = data.get("args")
    threads = _as_int(args.get("threads")) if isinstance(args, dict) else None
    if threads is not None and threads > 0:
        return threads
    distinct = {r.thread_id for r in results if r.thread_id}
    return len(distinct) or None


def load_run_results_file(run_results_path: Path) -> RunResultsFile:
    if not run_results_path.exists():
        return RunResultsFile()
    try:
        data = json.loads(run_results_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("run_results_read_failed", path=str(run_results_path), error=str(exc))
        return RunResultsFile()
    if not isinstance(data, dict):
        return RunResultsFile()

    raw_results: list[dict[str, Any]] = data.get("results") or []
    results = [
        _parse_entry(entry, entry["unique_id"])
        for entry in raw_results
        if isinstance(entry, dict) and isinstance(entry.get("unique_id"), str)
    ]
    return RunResultsFile(
        results=results,
        elapsed_time=_as_float(data.get("elapsed_time")),
        threads=_thread_count(data, results),
    )


def load_run_results(run_results_path: Path) -> list[NodeResult]:
    return load_run_results_file(run_results_path).results
