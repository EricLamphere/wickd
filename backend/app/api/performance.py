"""Run performance: per-node durations for the DAG overlay (Base) and the Pro
insights — one run's critical path / regressions / recommendations, and a
project-wide summary over recent runs. The analysis itself is in wickd_pro
(app/performance/pro.py); this module only loads history and shapes it.
"""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_session
from app.db.models import InvocationModelResult, Project, RunInvocation
from app.dbt.manifest import Manifest, load_manifest
from app.licensing.gating import require_pro
from app.logging_setup import get_logger
from app.performance import inputs, pro

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["performance"])

_SLOWEST_LIMIT = 15
_RECOMMENDATION_RUNS = 5  # recent runs with timing whose recommendations are merged
_FINISHED = ("success", "error")
_NO_TIMING_REASON = (
    "This run has no timing details. wickd records them for runs from now on "
    "(dbt writes them to run_results.json)."
)


class NodeDurationDto(BaseModel):
    median_s: float
    last_s: float
    runs: int


class NodeDurationsDto(BaseModel):
    nodes: dict[str, NodeDurationDto]


class CriticalPathStepDto(BaseModel):
    unique_id: str
    name: str
    resource_type: str | None
    materialized: str | None
    duration_s: float
    share: float
    wait_before_s: float
    wait_kind: str | None


class RegressionDto(BaseModel):
    unique_id: str
    name: str
    current: float
    baseline_median: float
    ratio: float
    runs_considered: int


class RecommendationDto(BaseModel):
    kind: str
    unique_id: str | None = None
    name: str | None = None
    title: str
    evidence: list[str]
    confidence: str
    estimated_saving_s: float | None = None
    invocation_id: int | None = None


class RunAnalysisDto(BaseModel):
    invocation_id: int
    has_timing: bool
    reason: str | None
    wall_time: float | None
    ideal_time: float | None
    potential_saving_s: float | None
    threads: int
    utilisation: float | None
    critical_path: list[CriticalPathStepDto]
    critical_path_waiting_s: float
    starvation_s: float
    regressions: list[RegressionDto]
    recommendations: list[RecommendationDto]


class SlowNodeDto(BaseModel):
    unique_id: str
    name: str
    resource_type: str
    median_s: float
    last_s: float
    runs: int
    recent: list[float]


class ProjectPerformanceDto(BaseModel):
    runs_considered: int
    runs_with_timing: int
    slowest: list[SlowNodeDto]
    regressions: list[RegressionDto]
    recommendations: list[RecommendationDto]


async def _project(session: AsyncSession, project_id: int) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _manifest(project: Project) -> Manifest | None:
    return load_manifest(Path(project.path) / "target" / "manifest.json")


async def _rows(session: AsyncSession, *conditions) -> list[InvocationModelResult]:
    result = await session.execute(
        select(InvocationModelResult)
        .where(*conditions)
        .order_by(InvocationModelResult.invocation_id, InvocationModelResult.id)
    )
    return list(result.scalars().all())


def _call_pro(fn, *args):
    """Pro analysis is pure; anything it raises is a bug, not a user error."""
    try:
        return fn(*args)
    except pro.PerformanceUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        log.exception("performance_analysis_failed", fn=getattr(fn, "__name__", str(fn)))
        raise HTTPException(status_code=500, detail="Performance analysis failed — see the API logs.") from exc


def _analyze(
    rows: list[InvocationModelResult],
    earlier: list[InvocationModelResult],
    manifest: Manifest | None,
    threads: int | None,
) -> tuple[dict, list[dict], list[dict]]:
    by_uid = {n.unique_id: n for n in manifest.nodes} if manifest is not None else {}
    nodes = inputs.run_nodes(rows, by_uid)
    parents = inputs.run_parents(manifest, {r.unique_id for r in rows})
    analysis = _call_pro(pro.analyze_run, nodes, parents, threads)
    regressions = _call_pro(pro.detect_regressions, inputs.regression_history(rows, earlier))
    history = inputs.successful_times([*earlier, *rows])
    recommendations = _call_pro(pro.recommend, analysis, inputs.nodes_meta(manifest, rows), history)
    return analysis, regressions, recommendations


@router.get("/{project_id}/node-durations", response_model=NodeDurationsDto)
async def get_node_durations(
    project_id: int,
    command: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
) -> NodeDurationsDto:
    """Median successful execution time per node over its recorded history (Base: DAG overlay)."""
    await _project(session, project_id)
    conditions = [InvocationModelResult.project_id == project_id]
    if command:
        conditions.append(
            InvocationModelResult.invocation_id.in_(
                select(RunInvocation.id).where(
                    RunInvocation.project_id == project_id, RunInvocation.command == command
                )
            )
        )
    durations = inputs.median_durations(await _rows(session, *conditions))
    return NodeDurationsDto(nodes={
        uid: NodeDurationDto(median_s=d["median_s"], last_s=d["last_s"], runs=d["runs"])
        for uid, d in durations.items()
    })


@router.get("/{project_id}/run-history/{invocation_id}/analysis", response_model=RunAnalysisDto)
async def get_run_analysis(
    project_id: int,
    invocation_id: int,
    session: AsyncSession = Depends(get_session),
) -> RunAnalysisDto:
    await require_pro(session, available=pro.is_available)
    project = await _project(session, project_id)
    inv = await session.get(RunInvocation, invocation_id)
    if inv is None or inv.project_id != project_id:
        raise HTTPException(status_code=404, detail="invocation not found")

    rows = await _rows(session, InvocationModelResult.invocation_id == invocation_id)
    earlier = await _rows(
        session,
        InvocationModelResult.project_id == project_id,
        InvocationModelResult.invocation_id < invocation_id,
        InvocationModelResult.unique_id.in_({r.unique_id for r in rows}),
    )
    analysis, regressions, recommendations = _analyze(rows, earlier, _manifest(project), inv.threads)
    return RunAnalysisDto(
        invocation_id=invocation_id,
        has_timing=analysis["has_timing"],
        reason=None if analysis["has_timing"] else _NO_TIMING_REASON,
        wall_time=analysis["wall_time"],
        ideal_time=analysis["ideal_time"],
        potential_saving_s=analysis["potential_saving_s"],
        threads=analysis["threads"],
        utilisation=analysis["utilisation"],
        critical_path=[CriticalPathStepDto(**s) for s in analysis["critical_path"]],
        critical_path_waiting_s=analysis["critical_path_waiting_s"],
        starvation_s=analysis["starvation_s"],
        regressions=[RegressionDto(**r) for r in regressions],
        recommendations=[RecommendationDto(**r) for r in recommendations],
    )


def _slowest(rows: list[InvocationModelResult], manifest: Manifest | None) -> list[SlowNodeDto]:
    by_uid = {n.unique_id: n for n in manifest.nodes} if manifest is not None else {}
    names = {r.unique_id: r.name for r in rows}
    ranked = sorted(inputs.median_durations(rows).items(), key=lambda kv: kv[1]["median_s"], reverse=True)
    return [
        SlowNodeDto(
            unique_id=uid,
            name=by_uid[uid].name if uid in by_uid else names[uid],
            resource_type=by_uid[uid].resource_type if uid in by_uid else uid.split(".", 1)[0],
            **d,
        )
        for uid, d in ranked[:_SLOWEST_LIMIT]
    ]


def _latest_regressions(rows: list[InvocationModelResult]) -> list[dict]:
    """Each node's most recent result in the window against its earlier ones."""
    latest: dict[str, InvocationModelResult] = {}
    for r in rows:
        latest[r.unique_id] = r
    latest_ids = {id(r) for r in latest.values()}
    earlier = [r for r in rows if id(r) not in latest_ids]
    return _call_pro(pro.detect_regressions, inputs.regression_history(list(latest.values()), earlier))


def _merged_recommendations(
    invocations: list[RunInvocation], rows: list[InvocationModelResult], manifest: Manifest | None
) -> tuple[list[RecommendationDto], int]:
    """Recommendations from the most recent runs with timing; the newest wins per (kind, node)."""
    by_inv: dict[int, list[InvocationModelResult]] = {}
    for r in rows:
        by_inv.setdefault(r.invocation_id, []).append(r)
    timed = [inv for inv in invocations if any(r.started_at is not None for r in by_inv.get(inv.id, []))]
    merged: dict[tuple[str, str | None], RecommendationDto] = {}
    for inv in timed[:_RECOMMENDATION_RUNS]:  # newest first
        inv_rows = by_inv[inv.id]
        earlier = [r for r in rows if r.invocation_id < inv.id]
        _, _, recs = _analyze(inv_rows, earlier, manifest, inv.threads)
        for rec in recs:
            merged.setdefault((rec["kind"], rec.get("unique_id")), RecommendationDto(**rec, invocation_id=inv.id))
    ordered = sorted(merged.values(), key=lambda r: -(r.estimated_saving_s or 0.0))
    return ordered, len(timed)


@router.get("/{project_id}/performance", response_model=ProjectPerformanceDto)
async def get_project_performance(
    project_id: int,
    command: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    session: AsyncSession = Depends(get_session),
) -> ProjectPerformanceDto:
    await require_pro(session, available=pro.is_available)
    project = await _project(session, project_id)

    inv_q = select(RunInvocation).where(
        RunInvocation.project_id == project_id, RunInvocation.status.in_(_FINISHED)
    )
    if command:
        inv_q = inv_q.where(RunInvocation.command == command)
    invocations = list(
        (await session.execute(inv_q.order_by(RunInvocation.id.desc()).limit(limit))).scalars().all()
    )
    rows = await _rows(session, InvocationModelResult.invocation_id.in_([i.id for i in invocations]))
    manifest = _manifest(project)
    recommendations, runs_with_timing = _merged_recommendations(invocations, rows, manifest)
    return ProjectPerformanceDto(
        runs_considered=len(invocations),
        runs_with_timing=runs_with_timing,
        slowest=_slowest(rows, manifest),
        regressions=[RegressionDto(**r) for r in _latest_regressions(rows)],
        recommendations=recommendations,
    )
