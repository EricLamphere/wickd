"""A node's run timings and recent code changes, for "Ask Wicky why it's slow".

Timings come from invocation_model_results (last 20 per node, see api/runs.py),
joined to their invocation for the command and when it ran. Code changes are the
commits since the oldest of those runs that touched the node's SQL or schema
YAML, plus any uncommitted edits — the usual suspects when a model gets slower.
The pure part (performance_info) is unit-tested; git goes through git_runner.
"""

import json
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from statistics import median

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import InvocationModelResult, RunInvocation
from app.git.repo import find_repo_root
from app.git.runner import GitRequest, git_runner
from app.logging_setup import get_logger

log = get_logger(__name__)

MAX_RUNS = 20
MAX_UPSTREAM = 8
MAX_COMMITS = 5
MAX_DIFF_CHARS = 6_000
DEFAULT_LOOKBACK = timedelta(days=30)
_COMMIT_SEP = "\x1e"


def _aware(value: datetime) -> datetime:
    """SQLite hands back naive datetimes; they're stored as UTC."""
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _iso(value: datetime | None) -> str | None:
    return _aware(value).isoformat() if value is not None else None


def _adapter_response(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _median(values: Sequence[float | None]) -> float | None:
    timed = [v for v in values if v is not None]
    return median(timed) if timed else None


def performance_info(
    unique_id: str,
    rows: Sequence[tuple[InvocationModelResult, RunInvocation]],
    parents: Sequence[str],
    parent_rows: Sequence[InvocationModelResult],
) -> dict:
    """`rows`: the node's results with their invocation, newest first."""
    runs = [
        {
            "ran_at": _iso(inv.started_at or r.started_at),
            "command": inv.command,
            "target": inv.target,
            "status": r.status,
            "execution_time": r.execution_time,
            "rows_affected": r.rows_affected,
            "bytes_processed": r.bytes_processed,
            "adapter_response": _adapter_response(r.adapter_response_json),
            "threads": inv.threads,
        }
        for r, inv in rows[:MAX_RUNS]
    ]
    by_parent: dict[str, list[float | None]] = {}
    for r in parent_rows:
        by_parent.setdefault(r.unique_id, []).append(r.execution_time)
    upstream = [
        {"unique_id": p, "median_s": _median(by_parent[p])}
        for p in parents[:MAX_UPSTREAM]
        if p in by_parent
    ]
    times = [run["execution_time"] for run in runs]
    return {
        "unique_id": unique_id,
        "runs": runs,
        "latest_s": times[0] if times else None,
        "median_s": _median(times),
        "upstream": upstream,
        "changes": [],
        "uncommitted_diff": None,
    }


def _node_files(manifest: dict, unique_id: str) -> list[str]:
    """Project-relative paths of the node's SQL and the schema YAML that configures it."""
    node = (manifest.get("nodes") or {}).get(unique_id) or {}
    files = [node.get("original_file_path")]
    patch = node.get("patch_path") or ""
    files.append(patch.split("://", 1)[-1] if patch else None)
    return [f for f in dict.fromkeys(files) if f]


def parse_log(output: str) -> list[dict]:
    """`git log --format=<SEP>%h%x1f%ad%x1f%an%x1f%s -p` → commits, each with its diff."""
    commits = []
    for chunk in output.split(_COMMIT_SEP):
        header, _, diff = chunk.partition("\n")
        fields = header.split("\x1f")
        if len(fields) != 4:
            continue
        sha, date, author, subject = fields
        commits.append({"sha": sha, "date": date, "author": author, "subject": subject, "diff": diff.strip()})
    return commits


def _cap(text: str, budget: int) -> str:
    return text if len(text) <= budget else text[:budget].rstrip() + "\n… (diff truncated)"


async def recent_changes(project_id: int, project_path: Path, files: list[str], since: datetime) -> dict:
    """Commits since `since` touching `files`, and their uncommitted diff. Empty outside a repo."""
    repo = find_repo_root(project_path)
    if repo is None or not files:
        return {"changes": [], "uncommitted_diff": None}
    paths = [str((project_path / f).resolve().relative_to(repo.resolve())) for f in files]

    async def git(*args: str) -> str | None:
        rc, out = await git_runner.run(GitRequest(project_id=project_id, repo_root=repo, args=args))
        if rc != 0:
            log.warning("perf_context_git_failed", args=args[:2], output=out[:300])
            return None
        return out

    log_out = await git(
        "log", f"--since={_iso(since)}", f"-n{MAX_COMMITS}", "--no-color", "--date=short",
        f"--format={_COMMIT_SEP}%h%x1f%ad%x1f%an%x1f%s", "-p", "--", *paths,
    )
    budget = MAX_DIFF_CHARS
    changes = []
    for commit in parse_log(log_out or ""):
        commit = {**commit, "diff": _cap(commit["diff"], max(budget, 0))}
        budget -= len(commit["diff"])
        changes.append(commit)
    diff = await git("diff", "--no-color", "HEAD", "--", *paths)
    uncommitted = _cap(diff.strip(), MAX_DIFF_CHARS // 2) if diff and diff.strip() else None
    return {"changes": changes, "uncommitted_diff": uncommitted}


async def node_performance_info(
    session: AsyncSession, project_id: int, project_path: Path, manifest: dict, unique_id: str
) -> dict:
    result = await session.execute(
        select(InvocationModelResult, RunInvocation)
        .join(RunInvocation, RunInvocation.id == InvocationModelResult.invocation_id)
        .where(InvocationModelResult.project_id == project_id, InvocationModelResult.unique_id == unique_id)
        .order_by(InvocationModelResult.invocation_id.desc())
        .limit(MAX_RUNS)
    )
    rows = [(r, inv) for r, inv in result.all()]
    parents = [
        p for p in ((manifest.get("parent_map") or {}).get(unique_id) or [])
        if not p.startswith("test.")
    ]
    parent_rows: list[InvocationModelResult] = []
    if parents:
        parent_result = await session.execute(
            select(InvocationModelResult).where(
                InvocationModelResult.project_id == project_id,
                InvocationModelResult.unique_id.in_(parents[:MAX_UPSTREAM]),
            )
        )
        parent_rows = list(parent_result.scalars().all())
    info = performance_info(unique_id, rows, parents, parent_rows)

    oldest = min((_aware(inv.started_at) for _, inv in rows if inv.started_at), default=None)
    since = oldest or datetime.now(UTC) - DEFAULT_LOOKBACK
    try:
        info.update(await recent_changes(project_id, project_path, _node_files(manifest, unique_id), since))
    except (OSError, ValueError) as exc:  # path outside the repo, unreadable repo
        log.warning("perf_context_changes_failed", unique_id=unique_id, error=str(exc))
    return info
