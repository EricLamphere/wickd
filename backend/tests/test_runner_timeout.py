"""runner.run(timeout=): the clock starts once the project's dbt lock is held, so time spent queued
behind another dbt command never counts against a query's timeout."""

import asyncio
import os
from pathlib import Path

import pytest

from app.dbt.runner import RunRequest, runner
from app.semantic.execute import timeout_message


@pytest.fixture
def fake_args(monkeypatch: pytest.MonkeyPatch):
    def use(script: str) -> None:
        monkeypatch.setattr(runner, "build_args", lambda req: ["/bin/sh", "-c", script])
    return use


async def test_waiting_for_the_lock_doesnt_count(fake_args, tmp_path: Path) -> None:
    fake_args("echo done")
    req = RunRequest(project_id=911, project_path=tmp_path, command="show", env=dict(os.environ))
    lock = runner._lock_for(911)
    await lock.acquire()
    asyncio.get_running_loop().call_later(0.4, lock.release)
    code, out, _ = await runner.run(req, timeout=0.3)
    assert code == 0 and out.strip() == b"done"


async def test_a_slow_command_times_out_and_is_killed(fake_args, tmp_path: Path) -> None:
    pid_file = tmp_path / "pid"
    fake_args(f"echo $$ > {pid_file}; exec sleep 30")
    req = RunRequest(project_id=912, project_path=tmp_path, command="show", env=dict(os.environ))
    with pytest.raises(TimeoutError):
        await runner.run(req, timeout=0.3)
    assert not runner.is_project_busy(912)
    await asyncio.sleep(0.05)
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


def test_timeout_message_names_the_whole_allowance() -> None:
    msg = timeout_message(120, startup=120)
    assert "240s" in msg and "120s for dbt to start" in msg and "METRIC_QUERY_TIMEOUT" in msg and "120s" in msg


def test_timeout_message_for_a_later_query_in_a_batch() -> None:
    msg = timeout_message(60, index=2, total=6)
    assert msg.startswith("Query 3 of 6") and "60s" in msg and "start" not in msg
