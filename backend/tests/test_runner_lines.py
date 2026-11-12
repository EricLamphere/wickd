"""runner.run_lines(): dbt's output line by line, and dbt killed when the caller stops early."""

import asyncio
import os
from contextlib import aclosing
from pathlib import Path

import pytest

from app.dbt.runner import RunRequest, runner


@pytest.fixture
def fake_args(monkeypatch: pytest.MonkeyPatch):
    def use(script: str) -> None:
        monkeypatch.setattr(runner, "build_args", lambda req: ["/bin/sh", "-c", script])
    return use


async def test_yields_stdout_and_stderr_lines_as_printed(fake_args, tmp_path: Path) -> None:
    fake_args("echo one; echo two >&2; printf 'x%.0s' $(seq 1 100000); echo")
    req = RunRequest(project_id=901, project_path=tmp_path, command="show", env=dict(os.environ))
    lines = [line async for line in runner.run_lines(req)]
    assert lines[:2] == ["one", "two"]
    assert lines[2] == "x" * 100000  # longer than asyncio's default 64 KiB line limit
    assert not runner.is_project_busy(901)


async def test_closing_early_kills_dbt_and_releases_the_lock(fake_args, tmp_path: Path) -> None:
    pid_file = tmp_path / "pid"
    fake_args(f"echo $$ > {pid_file}; echo ready; sleep 30; echo late")
    req = RunRequest(project_id=902, project_path=tmp_path, command="show", env=dict(os.environ))
    async with aclosing(runner.run_lines(req)) as lines:
        async for line in lines:
            assert line == "ready"
            break
    assert not runner.is_project_busy(902)
    pid = int(pid_file.read_text())
    await asyncio.sleep(0.05)
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
