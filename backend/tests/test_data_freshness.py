"""semantic/data_freshness.py: when a project's data last changed."""

import json
from datetime import UTC, datetime
from pathlib import Path

from app.semantic.data_freshness import is_stale, run_results_changed_at


def _write(target: Path, which: str, generated_at: str, target_name: str | None = None) -> None:
    target.mkdir(parents=True, exist_ok=True)
    args = {"which": which, **({"target": target_name} if target_name else {})}
    (target / "run_results.json").write_text(json.dumps({"metadata": {"generated_at": generated_at}, "args": args}))


def test_run_results_counts_only_data_commands_on_the_target(tmp_path: Path) -> None:
    target = tmp_path / "target"
    assert run_results_changed_at(target, "dev") is None  # no file
    _write(target, "build", "2026-11-13T14:21:46.123Z")
    assert run_results_changed_at(target, "dev") == datetime(2026, 11, 13, 14, 21, 46, 123000, tzinfo=UTC)
    _write(target, "show", "2026-11-13T14:21:46Z")
    assert run_results_changed_at(target, "dev") is None
    _write(target, "seed", "2026-11-13T14:21:46Z", target_name="prod")
    assert run_results_changed_at(target, "dev") is None and run_results_changed_at(target, "prod") is not None
    (target / "run_results.json").write_text("{not json")
    assert run_results_changed_at(target, "dev") is None


def test_is_stale() -> None:
    changed = datetime(2026, 11, 13, 12, tzinfo=UTC)
    assert is_stale(datetime(2026, 11, 13, 11), changed)  # naive values read as UTC
    assert not is_stale(datetime(2026, 11, 13, 13, tzinfo=UTC), changed)
    assert not is_stale(datetime(2026, 11, 13, 11, tzinfo=UTC), None)
