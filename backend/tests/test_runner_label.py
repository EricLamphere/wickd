from pathlib import Path

from app.dbt.runner import RunRequest, command_label


def _req(command: str, *extra: str, select: str | None = None) -> RunRequest:
    return RunRequest(project_id=1, project_path=Path("/p"), command=command, select=select, extra=extra)


def test_command_label_keeps_subcommands_up_to_the_first_flag() -> None:
    assert command_label(_req("compile", select="my_model")) == "compile"
    assert command_label(_req("source", "freshness", "--profiles-dir", "/x")) == "source freshness"
    assert command_label(_req("run-operation", "grant_select", "--args", "{}")) == "run-operation grant_select"
    assert command_label(_req("debug", "--target", "dev")) == "debug"
    assert command_label(_req("show", "--inline", "select 1")) == "show"
