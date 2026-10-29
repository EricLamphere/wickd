"""Metric compare mode (plan 14): one metric query explained and run two ways, then aligned.

Modes (the "current" side is always the working copy on the active target):

- `working`  — vs HEAD: what your uncommitted changes do.
- `branch`   — vs the merge base with the base branch (main): what this branch changes.
- `targets`  — vs the same definitions on another target (dev vs prod).
- `metrics`  — vs another metric, same query otherwise (`revenue` vs `revenue_v2`).

In `working` / `branch` the base side is parsed for DIFF_BASE_TARGET when it's set, so it reads
that target's tables (model SQL changes show up); otherwise both sides read the active target's
tables and only semantic YAML changes can differ — a note says so. Explaining uses
revisions.side_manifest(); both SQLs run through batch.run_many() (one `dbt show` when they share
a target). Aligning and summarising is Pro (compare_pro.py). Results aren't cached: a compare
is a deliberate check.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Project, ProjectEnvVar
from app.git.changeset import ChangeSetError, resolve_base
from app.git.repo import find_repo_root
from app.git.runner import GitRequest, git_runner
from app.semantic import compare_pro, service
from app.semantic.batch import run_many
from app.semantic.query_service import query_context
from app.semantic.query_spec import QueryInvalid, check_query, checked_sql
from app.semantic.revisions import RevisionError, SideManifest, side_manifest

Mode = Literal["working", "branch", "targets", "metrics"]
BASE_TARGET_KEY = "DIFF_BASE_TARGET"


@dataclass
class Side:
    ref: str | None  # the git ref asked for (None: the working copy)
    sha: str | None
    target: str  # '' = the active target
    query: dict[str, Any]
    sql: str | None = None
    columns: list[str] = field(default_factory=list)
    rows: list[list] = field(default_factory=list)
    truncated: bool = False
    error: str | None = None
    # the query's metric isn't defined on this side (new in your changes, or not committed yet)
    missing: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {"ref": self.ref, "sha": self.sha, "target": self.target or None, "query": self.query, "sql": self.sql,
                "columns": self.columns, "rows": self.rows, "truncated": self.truncated, "error": self.error,
                "missing": self.missing}


async def base_target_setting(session: AsyncSession, project_id: int) -> str | None:
    value = (await session.execute(
        select(ProjectEnvVar.value).where(ProjectEnvVar.project_id == project_id, ProjectEnvVar.key == BASE_TARGET_KEY)
    )).scalar_one_or_none()
    return (value.strip() or None) if value else None


def _git_for(project: Project):
    repo = find_repo_root(Path(project.path))

    async def git(*args: str) -> tuple[int, str]:
        if repo is None:
            return 128, "not a git repository"
        return await git_runner.run(GitRequest(project_id=project.id, repo_root=repo, args=args))
    return git


async def default_branch_base(project: Project) -> str | None:
    """What `branch` compares with when no base is given (origin/HEAD, else main/master)."""
    try:
        return await resolve_base(_git_for(project), None)
    except ChangeSetError:
        return None


async def _merge_base(project: Project, base: str | None) -> tuple[str, str]:
    """(the base branch, its merge base with HEAD)."""
    git = _git_for(project)
    try:
        resolved = await resolve_base(git, base)
    except ChangeSetError as exc:
        raise RevisionError("unknown_ref", str(exc)) from exc
    rc, out = await git("merge-base", resolved, "HEAD")
    if rc != 0 or not out.strip():
        raise RevisionError("unknown_ref", f"`{resolved}` and this branch have no common commit.")
    return resolved, out.strip()


def _defined_metrics(manifest: Path) -> set[str] | None:
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return {m.get("name") for m in data.get("metrics") or [] if isinstance(m, dict)}


async def _explain(project: Project, side: Side, manifest: SideManifest, adapter_type: str | None) -> None:
    try:
        explained = await service.explain_on(Path(project.path), manifest.path, side.query)
        side.sql = checked_sql(explained["sql"], adapter_type)
    except (service.SemanticError, QueryInvalid) as exc:
        side.error = getattr(exc, "message", None) or str(exc)
        # say why when the metric simply isn't there (a new metric, an uncommitted semantic layer)
        defined = _defined_metrics(manifest.path)
        absent = [m for m in side.query.get("metrics") or [] if defined is not None and m not in defined]
        if absent and side.ref:
            side.missing = True
            side.error = (f"There's no semantic layer at {side.ref} yet (it isn't committed), so there's nothing to compare with."
                          if not defined else
                          f"`{absent[0]}` doesn't exist at {side.ref} — it's new in these changes, so there's nothing to compare it with.")


async def _run(project: Project, sides: list[Side]) -> None:
    by_target: dict[str, list[Side]] = {}
    for s in sides:
        if s.sql and not s.error:
            by_target.setdefault(s.target, []).append(s)
    for target, group in by_target.items():
        results = await run_many(project.id, Path(project.path), [s.sql for s in group], target=target or None)
        for s, res in zip(group, results, strict=True):
            if res.error:
                s.error = res.error
            else:
                s.columns, s.rows, s.truncated = res.columns, res.rows, res.truncated


def _group_columns(columns: list[str], metrics: list[str]) -> list[str]:
    return [c for c in columns if c not in metrics]


async def run_compare(
    session: AsyncSession, project: Project, adapter_type: str | None, *, query: dict[str, Any], mode: Mode,
    base_ref: str | None = None, base_target: str | None = None, other_metric: str | None = None,
) -> dict[str, Any]:
    """Both sides' results, what differs (Pro) and notes. RevisionError when a side can't be prepared."""
    path = Path(project.path)
    catalog = await service.catalog(path)
    check_query(query, catalog, adapter_type)
    labels = {m.get("name"): m.get("label") or m.get("name") for m in catalog.get("metrics") or []}
    active = (await query_context(session, project.id, path)).target
    setting = await base_target_setting(session, project.id)
    metrics = list(query.get("metrics") or [])
    notes: list[str] = []

    base_query = dict(query)
    if mode == "metrics":
        if len(metrics) != 1 or not other_metric:
            raise RevisionError("invalid_compare", "Comparing metrics takes one metric in the query and another to compare it with.")
        base_query["metrics"] = [other_metric]
        for key in ("order_by",):
            base_query.pop(key, None)

    if mode in ("working", "branch"):
        label, ref = ("HEAD", "HEAD") if mode == "working" else await _merge_base(project, base_ref)
        target = setting
        if not setting:
            notes.append("Both sides read your active target's tables, so changes to model SQL don't show here — only "
                         f"semantic YAML changes. Set {BASE_TARGET_KEY} (Environment) to compare against another target's tables.")
        base_manifest = await side_manifest(project, ref=ref, target=target)
        base = Side(ref=label, sha=base_manifest.sha, target=target or "", query=base_query)
    elif mode == "targets":
        target = base_target or setting
        if not target:
            raise RevisionError("no_base_target", f"Pick a target to compare with, or set {BASE_TARGET_KEY} in Environment.")
        base_manifest = await side_manifest(project, ref=None, target=target)
        base = Side(ref=None, sha=None, target=target, query=base_query)
    else:
        base_manifest = await side_manifest(project, ref=None, target=None)
        base = Side(ref=None, sha=None, target="", query=base_query)
    notes.extend(base_manifest.notes)

    current = Side(ref=None, sha=None, target="", query=dict(query))
    await _explain(project, current, await side_manifest(project, ref=None, target=None), adapter_type)
    await _explain(project, base, base_manifest, adapter_type)
    await _run(project, [current, base])

    diff = None
    if not current.error and not base.error:
        keys = _group_columns(current.columns, metrics)
        time_column = next((k for k in keys if k.startswith("metric_time")), None)
        names = {metrics[0]: other_metric} if mode == "metrics" and other_metric else None
        rows = compare_pro.align({"columns": current.columns, "rows": current.rows},
                                 {"columns": base.columns, "rows": base.rows}, keys, metrics, base_metrics=names)
        diff = {
            "key_columns": keys, "rows": rows,
            # two metrics: the headline names them, not "now" / "before"
            "summary": compare_pro.summarize(rows, keys, metrics, time_column=time_column, side_names=(
                (labels.get(metrics[0], metrics[0]), labels.get(other_metric, other_metric))
                if mode == "metrics" and other_metric else ("now", "before"))),
            "sql_diff": compare_pro.sql_diff(current.sql or "", base.sql or "", adapter_type),
        }
    return {
        "mode": mode, "metrics": metrics, "other_metric": other_metric, "active_target": active or None,
        "current": current.to_dict(), "base": base.to_dict(), "diff": diff, "notes": notes,
    }
