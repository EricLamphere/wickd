"""A node's latest run and its tests' results, for AI context.

Read from model_statuses (written after every run, see api/runs.py) plus the
manifest's test → model links. Failing rows come from re-running a failing
test with `dbt show`, which is a warehouse query, so only Explain failure
asks for them.
"""

import asyncio
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.ai_dtos import iso
from app.db.models import ModelStatus
from app.dbt.runner import RunRequest, runner
from app.dbt.show_parser import parse_show_json
from app.logging_setup import get_logger

log = get_logger(__name__)

FAILING_STATUSES = ("error", "warn")
MAX_TESTS = 40
MAX_FAILING_TESTS_WITH_ROWS = 2
FAILING_ROWS_LIMIT = 10
SHOW_TIMEOUT_S = 30


def tests_on(manifest: dict, unique_id: str) -> list[dict]:
    """Test nodes attached to `unique_id` (or the test itself, when it is one)."""
    nodes = manifest.get("nodes") or {}
    if unique_id.startswith("test."):
        node = nodes.get(unique_id)
        return [{"unique_id": unique_id, **node}] if isinstance(node, dict) else []
    return [
        {"unique_id": uid, **node}
        for uid, node in nodes.items()
        if isinstance(node, dict)
        and node.get("resource_type") == "test"
        and node.get("attached_node") == unique_id
    ][:MAX_TESTS]


async def node_run_info(
    session: AsyncSession, project_id: int, manifest: dict, unique_id: str
) -> dict:
    tests = tests_on(manifest, unique_id)
    ids = [unique_id, *(t["unique_id"] for t in tests)]
    result = await session.execute(
        select(ModelStatus).where(ModelStatus.project_id == project_id, ModelStatus.unique_id.in_(ids))
    )
    rows = {r.unique_id: r for r in result.scalars().all()}
    own = rows.get(unique_id)
    return {
        "status": own.status if own else None,
        "message": own.message if own else None,
        "finished_at": iso(own.finished_at) if own and own.finished_at else None,
        "tests": [
            {
                "unique_id": t["unique_id"],
                "name": t.get("name"),
                "column": t.get("column_name"),
                "test": (t.get("test_metadata") or {}).get("name"),
                "status": rows[t["unique_id"]].status if t["unique_id"] in rows else None,
                "message": rows[t["unique_id"]].message if t["unique_id"] in rows else None,
            }
            for t in tests
        ],
    }


def has_failures(run_info: dict) -> bool:
    return run_info.get("status") in FAILING_STATUSES or any(
        t.get("status") in FAILING_STATUSES for t in run_info.get("tests") or []
    )


async def _show_test(
    project_id: int, project_path: Path, env: dict[str, str], test_name: str
) -> dict | None:
    target = env.get("DBT_TARGET")
    req = RunRequest(
        project_id=project_id,
        project_path=project_path,
        command="show",
        select=test_name,
        extra=("--limit", str(FAILING_ROWS_LIMIT), "--output", "json")
        + (("--target", target) if target else ()),
        env=env,
    )
    try:
        async with asyncio.timeout(SHOW_TIMEOUT_S):
            code, stdout, _ = await runner.run(req)
    except (TimeoutError, OSError) as exc:
        log.info("ai_failing_rows_failed", test=test_name, error=str(exc))
        return None
    if code != 0:
        return None
    columns, rows = parse_show_json(stdout.decode(errors="replace"))
    return {"columns": columns, "rows": rows} if columns else None


async def failing_rows(
    project_id: int, project_path: Path, env: dict[str, str], run_info: dict
) -> list[dict]:
    """A few rows behind each failing test (best effort; skipped on any error)."""
    out = []
    failing = [t for t in run_info.get("tests") or [] if t.get("status") in FAILING_STATUSES]
    for test in failing[:MAX_FAILING_TESTS_WITH_ROWS]:
        rows = await _show_test(project_id, project_path, env, str(test.get("name")))
        if rows:
            out.append({"unique_id": test["unique_id"], **rows})
    return out
