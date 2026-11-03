"""`dct validate --json`: YAML schema + cross-reference checks per board (no warehouse, a few seconds).

dct prints one object for a single board and a list for several; each is
`{success, path, errors: [...], warnings: [...]}`. Issues are keyed by board path
(relative to the project, as dct prints it).
"""

import asyncio
import json
from typing import Any

from app.charts.discovery import CHARTS_DIR
from app.charts.env import GLOBAL_FLAGS, DctContext
from app.logging_setup import get_logger

log = get_logger(__name__)

VALIDATE_TIMEOUT_S = 120
MAX_ISSUES_PER_BOARD = 50


class ValidateFailed(Exception):
    pass


def _issue(item: Any, level: str) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    rng = item.get("range") if isinstance(item.get("range"), dict) else {}
    return {
        "code": str(item.get("code") or ""), "level": str(item.get("level") or level),
        "message": str(item.get("message") or ""), "hint": item.get("hint") or item.get("fix"),
        "chart": item.get("chart"), "query": item.get("query"), "line": rng.get("start_line"),
    }


def parse_validate(stdout: str) -> dict[str, dict[str, Any]]:
    """dct's JSON → {board path: {ok, errors, warnings}}; ValidateFailed when it isn't JSON."""
    try:
        data = json.loads(stdout)
    except ValueError as exc:
        raise ValidateFailed(stdout.strip()[-500:] or "dct validate printed nothing") from exc
    entries = data if isinstance(data, list) else [data]
    out: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            continue
        errors = [i for i in (_issue(e, "error") for e in entry.get("errors") or []) if i][:MAX_ISSUES_PER_BOARD]
        warnings = [i for i in (_issue(w, "warning") for w in entry.get("warnings") or []) if i][:MAX_ISSUES_PER_BOARD]
        out[entry["path"]] = {"ok": bool(entry.get("success")) and not errors, "errors": errors, "warnings": warnings}
    return out


async def validate(ctx: DctContext) -> dict[str, dict[str, Any]]:
    args = [str(ctx.dct), *GLOBAL_FLAGS, "validate", CHARTS_DIR, "--json", "--project-dir", str(ctx.project_path)]
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=str(ctx.project_path), env=ctx.env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=VALIDATE_TIMEOUT_S)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise ValidateFailed(f"dct validate took longer than {VALIDATE_TIMEOUT_S}s") from None
    text = stdout.decode(errors="replace")
    if not text.strip():
        raise ValidateFailed(stderr.decode(errors="replace").strip()[-500:] or f"dct validate exited with {proc.returncode}")
    return parse_validate(text)
