"""When a project's warehouse data last changed, so stored metric results older than that read
as `stale` (the metric index and pages run them again on Run all, or by themselves).

Two signals, the later wins:
- the latest finished run / build / seed / snapshot wickd ran on the target (run_invocations);
- target/run_results.json when it's from one of those commands, so a `dbt build` from the
  command line counts too (metric queries write their artifacts elsewhere, so they don't
  overwrite it; another command afterwards does, and then only wickd's own runs are known).

Data loaded outside dbt (an ingestion job) isn't seen: Refresh all reruns everything.
"""

import json
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import RunInvocation
from app.logging_setup import get_logger
from app.semantic import service

log = get_logger(__name__)

DATA_COMMANDS = frozenset({"run", "build", "seed", "snapshot"})


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def run_results_changed_at(target_dir: Path, target: str) -> datetime | None:
    """run_results.json's generated_at when a data command on `target` wrote it, else None."""
    try:
        data = json.loads((target_dir / "run_results.json").read_bytes())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    args = data.get("args") if isinstance(data.get("args"), dict) else {}
    metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    if args.get("which") not in DATA_COMMANDS:
        return None
    ran_on = args.get("target")
    if ran_on and target and ran_on != target:
        return None
    try:
        return _aware(datetime.fromisoformat(str(metadata.get("generated_at", ""))))
    except ValueError:
        return None


async def data_changed_at(session: AsyncSession, project_id: int, project_path: Path, target: str) -> datetime | None:
    """The latest moment the project's data on `target` may have changed (None = unknown)."""
    query = select(func.max(RunInvocation.finished_at)).where(
        RunInvocation.project_id == project_id,
        RunInvocation.command.in_(DATA_COMMANDS),
        RunInvocation.finished_at.is_not(None),
    )
    if target:
        query = query.where(or_(RunInvocation.target == target, RunInvocation.target.is_(None)))
    latest = (await session.execute(query)).scalar_one_or_none()
    candidates = [_aware(latest)] if latest else []
    from_file = run_results_changed_at(service.target_dir(project_path), target)
    if from_file:
        candidates.append(from_file)
    return max(candidates) if candidates else None


def is_stale(ran_at: datetime, changed_at: datetime | None) -> bool:
    return changed_at is not None and _aware(ran_at) < changed_at
