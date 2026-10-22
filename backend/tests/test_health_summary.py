from datetime import datetime, timedelta, timezone

from app.health.summary import (
    summarize_connection,
    summarize_drift,
    summarize_freshness,
)

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)
RECENT = NOW - timedelta(minutes=5)
OLD = NOW - timedelta(days=2)


def _debug(ok: bool = True, target: str | None = None, checks: list[dict] | None = None) -> dict:
    return {
        "overall_ok": ok,
        "finished_at": RECENT.isoformat(),
        "target_name": target or "dev",
        "requested_target": target,
        "checks": checks or [],
    }


# ── connection ────────────────────────────────────────────────────────────────

def test_connection_not_run():
    s = summarize_connection(None, running=False, current_target=None, now=NOW)
    assert s.status == "not_run" and s.issues == 0 and s.stale_reasons == ()


def test_connection_running_wins_over_last_result():
    s = summarize_connection(_debug(ok=False), running=True, current_target=None, now=NOW)
    assert s.status == "running"


def test_connection_ok_and_failed():
    ok = summarize_connection(_debug(), running=False, current_target=None, now=NOW)
    assert ok.status == "ok" and ok.headline == "Connected · dev"
    failed = summarize_connection(
        _debug(ok=False, checks=[{"status": "fail"}, {"status": "ok"}, {"status": "fail"}]),
        running=False, current_target=None, now=NOW,
    )
    assert failed.status == "fail" and failed.issues == 2 and failed.headline == "2 checks failed"


def test_connection_stale_when_target_changed_or_old():
    s = summarize_connection(_debug(target="dev"), running=False, current_target="prod", now=NOW)
    assert s.stale_reasons == ("Target changed to prod since this run",)
    old = {**_debug(), "finished_at": OLD.isoformat()}
    assert summarize_connection(old, running=False, current_target=None, now=NOW).stale_reasons == (
        "Last run over a day ago",
    )


# ── drift ─────────────────────────────────────────────────────────────────────

def _r(name: str, *, drift=False, not_built=False, error=None) -> dict:
    return {"unique_id": f"model.p.{name}", "name": name, "has_drift": drift,
            "not_built": not_built, "error": error}


def test_drift_not_run_and_running():
    assert summarize_drift(None, rebuilt_since=0, current_target=None).status == "not_run"
    snap = {"status": "running", "results": [], "target": None, "finished_at": None, "total": 3}
    assert summarize_drift(snap, rebuilt_since=0, current_target=None).status == "running"


def test_drift_all_in_sync():
    snap = {"status": "done", "results": [_r("a"), _r("b")], "target": None,
            "finished_at": RECENT, "total": 2}
    s = summarize_drift(snap, rebuilt_since=0, current_target=None)
    assert s.status == "ok" and s.headline == "All 2 models in sync" and s.issues == 0


def test_drift_counts_drift_not_built_and_errors():
    results = [_r("a", drift=True), _r("b", drift=True), _r("c", not_built=True, error="x"),
               _r("d", error="boom"), _r("e")]
    snap = {"status": "done", "results": results, "target": None, "finished_at": RECENT, "total": 5}
    s = summarize_drift(snap, rebuilt_since=0, current_target=None)
    assert s.status == "fail"  # probe errors are worse than drift
    assert s.headline == "2 drifted · 1 not built · 1 error"
    assert s.issues == 4


def test_drift_warns_for_drift_or_not_built_only():
    snap = {"status": "done", "results": [_r("a", not_built=True, error="x")], "target": None,
            "finished_at": RECENT, "total": 1}
    assert summarize_drift(snap, rebuilt_since=0, current_target=None).status == "warn"


def test_drift_scan_error():
    snap = {"status": "error", "results": [], "target": None, "finished_at": RECENT, "total": 0,
            "error_message": "manifest gone"}
    s = summarize_drift(snap, rebuilt_since=0, current_target=None)
    assert s.status == "fail" and s.headline == "Scan failed"


def test_drift_stale_after_rebuilds_and_target_change():
    snap = {"status": "done", "results": [_r("a")], "target": "dev", "finished_at": RECENT, "total": 1}
    s = summarize_drift(snap, rebuilt_since=3, current_target=None)
    assert s.stale_reasons == ("3 models rebuilt since this scan", "Target changed to default since this run")
    one = summarize_drift({**snap, "target": None}, rebuilt_since=1, current_target=None)
    assert one.stale_reasons == ("1 model rebuilt since this scan",)


# ── freshness ─────────────────────────────────────────────────────────────────

def _f(status: str) -> dict:
    return {"status": status}


def test_freshness_levels():
    base = {"status": "done", "target": None, "finished_at": RECENT}
    ok = summarize_freshness({**base, "results": [_f("pass")]}, current_target=None, now=NOW)
    assert ok.status == "ok" and ok.headline == "1 pass"
    warn = summarize_freshness({**base, "results": [_f("pass"), _f("warn")]}, current_target=None, now=NOW)
    assert warn.status == "warn" and warn.issues == 1 and warn.headline == "1 warn · 1 pass"
    err = summarize_freshness(
        {**base, "results": [_f("runtime error"), _f("error"), _f("warn")]}, current_target=None, now=NOW
    )
    assert err.status == "fail" and err.issues == 3 and err.headline == "2 errors · 1 warn"


def test_freshness_no_sources_and_stale():
    snap = {"status": "done", "target": None, "finished_at": OLD, "results": []}
    s = summarize_freshness(snap, current_target=None, now=NOW)
    assert s.status == "ok" and s.headline == "No sources with freshness checks"
    assert s.stale_reasons == ("Last run over a day ago",)
