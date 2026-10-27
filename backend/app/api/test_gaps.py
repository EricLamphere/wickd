"""Test gaps (wickd Pro): the riskiest untested columns, and tests for them in one go.

Both routes read the latest column lineage snapshot, which must record join
pairs and grain (lineage_version 4) — otherwise 409 `{"error":
"lineage_not_ready", "reason": missing | running | outdated | error}` and the
UI offers a refresh. Suggestions come from app/test_targets (ranking in
wickd_pro); nothing here needs the AI model.

Rows can be ignored (app/test_targets/ignores.py): they drop out of the list
and its count, and are listed by GET .../test-gaps/ignored until unignored.

Writing is never direct: the batch route builds a "tests" proposal (one file
per schema YAML, `batch: true`) in the background, announced with
`ai_proposal_updated` and `ai_proposal_progress` per model, and reviewed in the
same modal as every other proposal.
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.documentation import load_manifest_dict
from app.ai.errors import ProposalError
from app.api.ai_dtos import AiProposalDto, iso, proposal_dto
from app.api.ai_proposals import _publish
from app.api.init import load_project_env
from app.db.engine import get_session
from app.db.models import AiProposal, AiProposalFile, Project
from app.events.bus import Event, bus
from app.licensing.gating import require_pro
from app.logging_setup import get_logger
from app.test_targets import ignores, pro
from app.test_targets.batch import BatchResult, build_batch, row_key
from app.test_targets.service import LineageNotReady, latest_inputs, project_ranking

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["test-gaps"])

KIND = "tests"
BATCH_TITLE = "Tests for test gaps"
MAX_LIMIT = 500


async def _require(session: AsyncSession) -> None:
    await require_pro(session, available=pro.is_available, unavailable_detail=pro.UNAVAILABLE)


async def _project(session: AsyncSession, project_id: int) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


async def _ranking(session: AsyncSession, project: Project) -> tuple[int, list[dict]]:
    """(snapshot id, rows with a suggested test, highest score first)."""
    try:
        inputs = await latest_inputs(session, project.id)
    except LineageNotReady as exc:
        raise HTTPException(status_code=409, detail={"error": "lineage_not_ready", "reason": exc.reason}) from exc
    try:
        rows = await asyncio.to_thread(project_ranking, project.id, Path(project.path), inputs)
    except ProposalError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return inputs.snapshot_id, [r for r in rows if r["candidates"]]


class GapCandidateDto(BaseModel):
    test: str  # not_null | unique | relationships | unique_combination_of_columns
    evidence: str
    source: str  # grain | join
    to: str | None = None  # relationships target unique_id
    field: str | None = None
    combination: list[str] | None = None
    models: list[str] = []  # join candidates: the models that join on it


class UsedNodeDto(BaseModel):
    unique_id: str
    name: str
    columns: list[str] = []  # downstream columns built from it (UsedByDto.columns only)


class UsedByDto(BaseModel):
    """What the reach / row_uses / exposures counts are made of (capped; the counts stay exact).
    Empty on older wickd_pro builds that only return counts."""

    columns: list[UsedNodeDto] = []  # downstream models and the columns derived from it
    row_uses: list[UsedNodeDto] = []  # models that filter / join / group on it
    exposures: list[UsedNodeDto] = []


class GapRowDto(BaseModel):
    key: str
    unique_id: str
    name: str
    column: str | None  # None for a model-level test (see columns)
    columns: list[str] | None = None
    score: int
    reach: int  # downstream columns traced from it
    row_uses: int  # models that filter / join / group on it (or on what's derived from it)
    exposures: int
    in_grain: bool
    used_by: UsedByDto = UsedByDto()
    existing: list[str]
    candidates: list[GapCandidateDto]


class GapsDto(BaseModel):
    snapshot_id: int
    total: int  # columns with a suggestion, not counting ignored ones (rows may be limited)
    ignored: int  # rows the user ignored (whether or not they're still gaps)
    rows: list[GapRowDto]


def _gap_dto(row: dict) -> GapRowDto:
    return GapRowDto(
        key=row_key(row),
        unique_id=row["unique_id"],
        name=row["name"],
        column=row.get("column"),
        columns=row.get("columns"),
        score=row["score"],
        reach=row["reach"],
        row_uses=row["row_uses"],
        exposures=row["exposures"],
        in_grain=row["in_grain"],
        used_by=UsedByDto.model_validate(row.get("used_by") or {}),
        existing=row.get("existing") or [],
        candidates=[
            GapCandidateDto(
                test=c["test"], evidence=c.get("evidence") or "", source=c.get("source") or "",
                to=c.get("to"), field=c.get("field"), combination=c.get("combination"),
                models=c.get("models") or [],
            )
            for c in row["candidates"]
        ],
    )


@router.get("/{project_id}/test-gaps", response_model=GapsDto)
async def get_test_gaps(
    project_id: int,
    limit: int = Query(default=50, ge=1, le=MAX_LIMIT),
    session: AsyncSession = Depends(get_session),
) -> GapsDto:
    """The columns most worth testing, highest score first, with evidence-backed tests."""
    await _require(session)
    project = await _project(session, project_id)
    snapshot_id, ranked = await _ranking(session, project)
    hidden = await ignores.ignored_keys(session, project_id)
    rows = [r for r in ranked if row_key(r) not in hidden]
    return GapsDto(
        snapshot_id=snapshot_id, total=len(rows), ignored=len(hidden), rows=[_gap_dto(r) for r in rows[:limit]]
    )


class IgnoredGapDto(BaseModel):
    key: str
    unique_id: str
    name: str
    label: str  # column, or "(a, b)"
    ignored_at: str
    # still suggested by the current ranking? None when column lineage isn't ready to tell
    still_a_gap: bool | None
    candidates: list[GapCandidateDto]  # what would be suggested now (empty once it's no longer a gap)


class IgnoredGapsDto(BaseModel):
    rows: list[IgnoredGapDto]


@router.get("/{project_id}/test-gaps/ignored", response_model=IgnoredGapsDto)
async def get_ignored_gaps(project_id: int, session: AsyncSession = Depends(get_session)) -> IgnoredGapsDto:
    """Every ignored row, newest first, with what the current ranking would suggest for it."""
    await _require(session)
    project = await _project(session, project_id)
    rows = await ignores.ignored(session, project_id)
    current: dict[str, dict] | None
    try:
        _, ranked = await _ranking(session, project)
        current = {row_key(r): r for r in ranked}
    except HTTPException as exc:
        if exc.status_code != 409:
            raise
        current = None  # lineage not ready: still list what's ignored
    return IgnoredGapsDto(rows=[
        IgnoredGapDto(
            key=row.key,
            unique_id=row.unique_id,
            name=row.name,
            label=row.label,
            ignored_at=iso(row.created_at),
            still_a_gap=None if current is None else row.key in current,
            candidates=_gap_dto(current[row.key]).candidates if current and row.key in current else [],
        )
        for row in rows
    ])


class GapKeysDto(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=MAX_LIMIT)  # GapRowDto.key values


class IgnoreResultDto(BaseModel):
    changed: int  # rows newly ignored / unignored


@router.post("/{project_id}/test-gaps/ignore", response_model=IgnoreResultDto)
async def ignore_gaps(
    project_id: int, dto: GapKeysDto, session: AsyncSession = Depends(get_session)
) -> IgnoreResultDto:
    """Hide these rows from Test gaps until they're unignored."""
    await _require(session)
    project = await _project(session, project_id)
    wanted = set(dto.keys)
    _, ranked = await _ranking(session, project)
    rows = [r for r in ranked if row_key(r) in wanted]
    if not rows:
        raise HTTPException(status_code=422, detail="none of these columns is a test gap any more")
    return IgnoreResultDto(changed=await ignores.ignore(session, project_id, rows))


@router.post("/{project_id}/test-gaps/unignore", response_model=IgnoreResultDto)
async def unignore_gaps(
    project_id: int, dto: GapKeysDto, session: AsyncSession = Depends(get_session)
) -> IgnoreResultDto:
    """Show these rows in Test gaps again (if they're still gaps)."""
    await _require(session)
    await _project(session, project_id)
    return IgnoreResultDto(changed=await ignores.unignore(session, project_id, dto.keys))


@router.post("/{project_id}/ai/tests/batch", response_model=AiProposalDto, status_code=202)
async def batch_tests(
    project_id: int, dto: GapKeysDto, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    """One proposal adding the suggested tests for the chosen Test gaps rows."""
    await _require(session)
    project = await _project(session, project_id)
    wanted = set(dto.keys)
    _, ranked = await _ranking(session, project)
    rows = [r for r in ranked if row_key(r) in wanted]
    if not rows:
        raise HTTPException(status_code=422, detail="none of the selected columns has a suggested test any more")
    busy = await session.execute(
        select(AiProposal.id).where(
            AiProposal.project_id == project_id,
            AiProposal.kind == KIND,
            AiProposal.unique_id.is_(None),
            AiProposal.status == "generating",
        )
    )
    if busy.first() is not None:
        raise HTTPException(status_code=409, detail="already generating tests for test gaps")
    models = len({r["unique_id"] for r in rows})
    title = f"Tests for {models} model" + ("" if models == 1 else "s")
    proposal = AiProposal(project_id=project_id, kind=KIND, unique_id=None, title=title, status="generating")
    session.add(proposal)
    await session.commit()
    await session.refresh(proposal, attribute_names=["files"])
    asyncio.create_task(_build(proposal.id, project_id, Path(project.path), rows))
    await _publish(proposal)
    return proposal_dto(proposal)


async def _build(proposal_id: int, project_id: int, project_path: Path, rows: list[dict]) -> None:
    from app.db import engine as db_engine  # patched in tests, like other background writers

    async def on_model(index: int, total: int, name: str) -> None:
        await bus.publish(Event(
            topic=f"project:{project_id}",
            type="ai_proposal_progress",
            data={
                "proposal_id": proposal_id, "unique_id": None, "phase": "checking", "text": "",
                "done": index, "total": total, "current": name,
            },
        ))

    built: BatchResult | None = None
    error: str | None = None
    dbt_version: str | None = None
    try:
        manifest = await asyncio.to_thread(load_manifest_dict, project_path)
        dbt_version = (manifest.get("metadata") or {}).get("dbt_version")
        env = await load_project_env(project_id)
        built = await build_batch(project_id, project_path, env, manifest, rows, on_model)
    except ProposalError as exc:
        error = str(exc)
    except Exception as exc:  # never leave a proposal stuck in `generating`
        log.exception("test_gaps_batch_crashed", proposal_id=proposal_id)
        error = f"unexpected error: {exc}"

    async with db_engine.SessionLocal() as session:
        proposal = await session.get(AiProposal, proposal_id)
        if proposal is None or proposal.status != "generating":
            return  # dismissed while building
        if built is not None and built.changes:
            for change in built.changes:
                session.add(AiProposalFile(
                    proposal_id=proposal_id, path=change.path,
                    original_text=change.original, proposed_text=change.proposed,
                ))
            proposal.status = "ready"
        elif built is not None:
            proposal.status = "empty"
            proposal.error_message = "Nothing to add — the selected columns already have these tests."
        else:
            proposal.status = "error"
            proposal.error_message = error
        proposal.result_json = json.dumps({
            "batch": True,
            "tests": built.tests if built else [],
            "skipped": built.skipped if built else [],
            "dbt_version": dbt_version,
        })
        proposal.updated_at = datetime.now(UTC)
        await session.commit()
        await _publish(proposal)
