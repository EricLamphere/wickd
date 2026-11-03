"""Static board builds: `dct render <board> --format html` into the data dir.

The output is one self-contained HTML file (Vega-Lite, fonts and data inlined; ~1 MB) at
`<data_dir>/charts/<project_id>/boards/<board id>/index.html`, with `meta.json` beside it
(built_at, target, ok, diagnostics), so a build survives restarts without a table. Builds
run every query on the warehouse, so they only happen on request, with `--no-cache`.

A build holds the project's dbt lock: on DuckDB a reader can't open the file while dbt
writes to it, and a dbt run shouldn't wait on a half-finished board either.
"""

import asyncio
import json
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.charts.discovery import Board
from app.charts.env import GLOBAL_FLAGS, DctContext, output_dir
from app.dbt.runner import runner
from app.logging_setup import get_logger

log = get_logger(__name__)

BUILD_TIMEOUT_S = 10 * 60
OUTPUT_FILE = "index.html"
META_FILE = "meta.json"
MAX_DIAGNOSTICS = 200
STDERR_TAIL = 30


@dataclass(frozen=True)
class BuildResult:
    ok: bool
    built_at: str
    target: str | None
    elapsed_ms: int
    diagnostics: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    has_output: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok, "built_at": self.built_at, "target": self.target, "elapsed_ms": self.elapsed_ms,
            "diagnostics": self.diagnostics, "error": self.error, "has_output": self.has_output,
        }


class UnsafePath(ValueError):
    pass


def board_dir(project_id: int, board_id: str) -> Path:
    root = (output_dir(project_id) / "boards").resolve()
    path = (root / board_id).resolve()
    if not path.is_relative_to(root) or path == root:
        raise UnsafePath(f"bad board id: {board_id}")
    return path


def read_meta(project_id: int, board_id: str) -> dict[str, Any] | None:
    try:
        data = json.loads((board_dir(project_id, board_id) / META_FILE).read_text())
    except (OSError, ValueError, UnsafePath):
        return None
    return data if isinstance(data, dict) else None


def static_file(project_id: int, board_id: str, relative: str) -> Path | None:
    """A built file of the board, only from inside its output folder (None when absent or outside)."""
    try:
        root = board_dir(project_id, board_id)
    except UnsafePath:
        return None
    path = (root / (relative or OUTPUT_FILE)).resolve()
    if not path.is_relative_to(root) or not path.is_file() or path.name == META_FILE:
        return None
    return path


def parse_diagnostics(stderr: str) -> tuple[list[dict[str, Any]], list[str]]:
    """`--diagnostics-json` lines → diagnostics; anything else on stderr → plain lines (the failure tail)."""
    diagnostics: list[dict[str, Any]] = []
    other: deque[str] = deque(maxlen=STDERR_TAIL)
    for raw in stderr.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("{"):
            try:
                item = json.loads(line)
            except ValueError:
                item = None
            if isinstance(item, dict) and "code" in item:
                if len(diagnostics) < MAX_DIAGNOSTICS:
                    diagnostics.append({
                        "code": str(item.get("code") or ""), "level": str(item.get("level") or "error"),
                        "message": str(item.get("message") or ""), "hint": item.get("hint") or item.get("fix"),
                        "chart": item.get("chart"), "query": item.get("query"),
                        "line": ((item.get("range") or {}).get("start_line") if isinstance(item.get("range"), dict) else None),
                    })
                continue
        other.append(line)
    return diagnostics, list(other)


def render_args(ctx: DctContext, board: Board, out: Path) -> list[str]:
    return [
        str(ctx.dct), *GLOBAL_FLAGS, "render", board.path, "--format", "html", "--output", str(out),
        "--project-dir", str(ctx.project_path), "--no-cache", "--allow-chart-errors", "--diagnostics-json",
    ]


async def _run(args: list[str], ctx: DctContext) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=str(ctx.project_path), env=ctx.env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        _stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=BUILD_TIMEOUT_S)
    except (TimeoutError, asyncio.CancelledError):
        proc.kill()
        await proc.wait()
        raise
    return proc.returncode or 0, stderr.decode(errors="replace")


async def build_board(project_id: int, ctx: DctContext, board: Board) -> BuildResult:
    """Render one board to static HTML; never raises for a dct failure (the result carries it)."""
    folder = board_dir(project_id, board.id)
    folder.mkdir(parents=True, exist_ok=True)
    out = folder / OUTPUT_FILE
    partial = folder / f".{OUTPUT_FILE}.tmp"
    started = time.monotonic()
    async with runner.project_lock(project_id):
        try:
            code, stderr = await _run(render_args(ctx, board, partial), ctx)
        except TimeoutError:
            code, stderr = -1, f"dct took longer than {BUILD_TIMEOUT_S // 60} minutes"
        except OSError as exc:
            code, stderr = -1, f"could not start dct: {exc}"
    diagnostics, other = parse_diagnostics(stderr)
    ok = code == 0 and partial.is_file()
    if ok:
        partial.replace(out)
    else:
        partial.unlink(missing_ok=True)
    errors = [d["message"] for d in diagnostics if d["level"] == "error"]
    error = None if ok else ("\n".join(errors[:5]) or "\n".join(other[-8:]) or f"dct exited with {code}")
    result = BuildResult(
        ok=ok, built_at=datetime.now(UTC).isoformat(), target=ctx.target,
        elapsed_ms=round((time.monotonic() - started) * 1000), diagnostics=diagnostics, error=error,
        has_output=out.is_file(),
    )
    (folder / META_FILE).write_text(json.dumps(result.to_dict()))
    log.info("dbt_charts_built", project_id=project_id, board=board.id, ok=ok, ms=result.elapsed_ms,
             diagnostics=len(diagnostics))
    return result
