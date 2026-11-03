"""Static board builds and `dct validate` parsing (dct stubbed)."""

import asyncio
import json
from pathlib import Path

import pytest

from app.charts import build as builds
from app.charts.discovery import Board
from app.charts.env import DctContext
from app.charts.validate import ValidateFailed, parse_validate
from app.config import settings
from app.dbt.runner import runner

BOARD = Board(id="sales", path="charts/sales.yml", url_path="sales", title="Sales", chart_count=1)


@pytest.fixture
def ctx(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> DctContext:
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    return DctContext(dct=Path("/x/dct"), env={"DBT_TARGET": "dev"}, project_path=tmp_path, target="dev", adapter_type="duckdb")


def _diag(code: str, level: str, message: str) -> str:
    return json.dumps({"code": code, "level": level, "message": message, "chart": "c", "range": {"start_line": 4}})


def test_parse_diagnostics() -> None:
    stderr = "\n".join([_diag("WARN-X", "warning", "careful"), "plain line", "{not json", _diag("ERR-Y", "error", "broken")])
    diagnostics, other = builds.parse_diagnostics(stderr)
    assert [d["code"] for d in diagnostics] == ["WARN-X", "ERR-Y"]
    assert diagnostics[0]["line"] == 4 and diagnostics[0]["chart"] == "c"
    assert other == ["plain line", "{not json"]


async def test_build_writes_output_and_meta_under_the_project_lock(ctx: DctContext, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}

    async def fake_run(args: list[str], c: DctContext) -> tuple[int, str]:
        seen["locked"] = runner.project_lock(7).locked()
        seen["args"] = args
        seen["env"] = c.env
        Path(args[args.index("--output") + 1]).write_text("<html>board</html>")
        return 0, _diag("WARN-X", "warning", "careful")

    monkeypatch.setattr(builds, "_run", fake_run)
    result = await builds.build_board(7, ctx, BOARD)
    assert result.ok and result.has_output and result.target == "dev"
    assert seen["locked"] is True
    assert seen["env"]["DBT_TARGET"] == "dev"
    assert {"--no-cache", "--allow-chart-errors", "--diagnostics-json"} <= set(seen["args"])
    assert seen["args"][seen["args"].index("--format") + 1] == "html"
    assert builds.static_file(7, "sales", builds.OUTPUT_FILE).read_text() == "<html>board</html>"
    meta = builds.read_meta(7, "sales")
    assert meta["ok"] and meta["diagnostics"][0]["code"] == "WARN-X"


async def test_failed_build_keeps_previous_output_and_reports(ctx: DctContext, monkeypatch: pytest.MonkeyPatch) -> None:
    async def ok(args: list[str], c: DctContext) -> tuple[int, str]:
        Path(args[args.index("--output") + 1]).write_text("old")
        return 0, ""

    async def broken(args: list[str], c: DctContext) -> tuple[int, str]:
        return 1, _diag("ERR-SOURCE", "error", "Could not open the warehouse")

    monkeypatch.setattr(builds, "_run", ok)
    await builds.build_board(7, ctx, BOARD)
    monkeypatch.setattr(builds, "_run", broken)
    result = await builds.build_board(7, ctx, BOARD)
    assert not result.ok
    assert result.error == "Could not open the warehouse"
    assert result.has_output  # the last good build is still shown
    assert builds.read_meta(7, "sales")["ok"] is False


async def test_build_waits_for_a_dbt_command(ctx: DctContext, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_run(args: list[str], c: DctContext) -> tuple[int, str]:
        Path(args[args.index("--output") + 1]).write_text("x")
        return 0, ""

    monkeypatch.setattr(builds, "_run", fake_run)
    lock = runner.project_lock(8)
    await lock.acquire()
    task = asyncio.create_task(builds.build_board(8, ctx, BOARD))
    await asyncio.sleep(0.05)
    assert not task.done()
    lock.release()
    assert (await task).ok


@pytest.mark.parametrize("bad", ["../x", "../../etc", "/abs", ""])
def test_static_file_refuses_paths_outside(ctx: DctContext, bad: str) -> None:
    assert builds.static_file(7, bad, builds.OUTPUT_FILE) is None


def test_static_file_never_serves_meta(ctx: DctContext) -> None:
    folder = builds.board_dir(7, "sales")
    folder.mkdir(parents=True)
    (folder / builds.META_FILE).write_text("{}")
    assert builds.static_file(7, "sales", builds.META_FILE) is None
    assert builds.static_file(7, "sales", "../other/index.html") is None


def test_parse_validate_single_and_list() -> None:
    one = json.dumps({"success": False, "path": "charts/a.yml", "errors": [{"code": "ERR-X", "message": "bad", "range": {"start_line": 2}}], "warnings": []})
    parsed = parse_validate(one)
    assert parsed["charts/a.yml"]["ok"] is False
    assert parsed["charts/a.yml"]["errors"][0]["line"] == 2
    many = json.dumps([
        {"success": True, "path": "charts/a.yml", "errors": [], "warnings": [{"code": "WARN-Y", "message": "hm", "fix": "do x"}]},
        {"success": True, "path": "charts/b.yml", "errors": [], "warnings": []},
    ])
    parsed = parse_validate(many)
    assert set(parsed) == {"charts/a.yml", "charts/b.yml"}
    assert parsed["charts/a.yml"]["warnings"][0]["hint"] == "do x"


def test_parse_validate_rejects_non_json() -> None:
    with pytest.raises(ValidateFailed):
        parse_validate("Traceback: boom")
