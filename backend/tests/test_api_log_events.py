"""Warnings and errors from the backend's logs, copied into API Logs (the bottom pane tab)."""

from app.logging_setup import forward_to_api_log
from app.logs import api_logger
from app.logs.api_logger import format_log_event


def test_format_puts_level_and_event_first_and_collapses_whitespace() -> None:
    line, project_id = format_log_event("warning", {
        "event": "metric_query_timeout", "project_id": 7, "query": 3, "of": 6,
        "sql": "select a\n  from b\n", "timestamp": "x", "logger": "y", "level": "warning",
    })
    assert line == 'WARNING metric_query_timeout · project_id=7 query=3 of=6 sql="select a from b"'
    assert project_id == 7


def test_format_reads_project_too_and_tolerates_missing_event() -> None:
    line, project_id = format_log_event("error", {"project": 4, "error": "boom"})
    assert line == "ERROR log · project=4 error=boom" and project_id == 4
    assert format_log_event("error", {"event": "x", "project": "abc"})[1] is None


def test_format_caps_long_values() -> None:
    line, _ = format_log_event("warning", {"event": "e", "sql": "x" * 5000})
    assert len(line) < 1200 and line.endswith('…')


def test_processor_forwards_warnings_and_errors_only(monkeypatch) -> None:
    sent: list[tuple[str, int | None]] = []
    monkeypatch.setattr(api_logger, "append_api_log", lambda line, project_id=None: sent.append((line, project_id)))
    for level in ("debug", "info", "warning", "error"):
        out = forward_to_api_log(None, level, {"event": f"e_{level}", "level": level, "project_id": 1})
        assert out["event"] == f"e_{level}"  # passed through unchanged
    assert [line.split(" ")[0] for line, _ in sent] == ["WARNING", "ERROR"]


def test_processor_forwards_info_that_asks_for_it(monkeypatch) -> None:
    sent: list[str] = []
    monkeypatch.setattr(api_logger, "append_api_log", lambda line, project_id=None: sent.append(line))
    out = forward_to_api_log(None, "info", {"event": "metric_query_batch", "level": "info", "api_log": True, "queries": 6})
    assert "api_log" not in out and sent == ["INFO metric_query_batch · queries=6"]


def test_processor_does_not_recurse_when_writing_fails(monkeypatch) -> None:
    calls = []

    def failing(line, project_id=None):
        calls.append(line)
        forward_to_api_log(None, "warning", {"event": "api_log_write_failed", "level": "warning"})

    monkeypatch.setattr(api_logger, "append_api_log", failing)
    forward_to_api_log(None, "error", {"event": "boom", "level": "error"})
    assert len(calls) == 1
