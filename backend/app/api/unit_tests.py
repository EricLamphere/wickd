"""Unit tests (plan 19): generate one for a model (Pro), list focus options (Pro),
and accept a failing test's actual rows as its expectation (Base).

POST /api/projects/{id}/ai/unit-tests                  → proposal `unit_test` (background)
GET  /api/projects/{id}/unit-tests/focus-options?unique_id=  → CTEs / CASE columns to aim at
GET  /api/projects/{id}/unit-tests/file-options?unique_id=   → default file, this model's files, YAML files
POST /api/projects/{id}/unit-tests/{unique_id}/rebaseline    → proposal `unit_test_rebaseline`
"""

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.documentation import DocumentationError, load_manifest_dict
from app.ai.gating import UNIT_TEST_KIND, require_unit_tests
from app.api.ai_dtos import AiProposalDto, proposal_dto
from app.api.ai_proposals import _publish, _start
from app.api.init import load_project_env
from app.db.engine import get_session
from app.db.models import AiProposal, AiProposalFile, ModelStatus, Project
from app.dbt.manifest import load_manifest
from app.dbt.unit_test_diff import parse_unit_test_diff
from app.logging_setup import get_logger
from app.unit_tests import pro
from app.unit_tests.context import (
    UnitTestError,
    check_model,
    compile_model,
    compiled_on_disk,
    model_inputs,
)
from app.unit_tests.files import file_options, resolve_file
from app.unit_tests.rebaseline import KIND as REBASELINE_KIND
from app.unit_tests.rebaseline import RebaselineError, build_rebaseline

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["unit-tests"])

FOCUS_PATTERN = r"^(cte|case):.{1,200}$"


class GenerateUnitTestDto(BaseModel):
    unique_id: str = Field(min_length=1, max_length=512)
    focus: str | None = Field(default=None, pattern=FOCUS_PATTERN)
    mask: bool = False  # replace text values with deterministic fakes
    # YAML file to write to (existing, or created): project-relative, or a bare name for the
    # model's folder; None = the default (beside its other unit tests, else its schema YAML)
    file: str | None = Field(default=None, max_length=255)
    conversation_id: int | None = None


class FocusOptionDto(BaseModel):
    id: str
    label: str
    kind: str


class FileOptionsDto(BaseModel):
    default: str  # where the test goes when no file is chosen
    existing: list[str]  # files already holding this model's unit tests
    files: list[str]  # YAML files under the model paths, to pick from
    model_dir: str  # where a bare file name goes


class FocusOptionsDto(BaseModel):
    options: list[FocusOptionDto]
    compiled: bool  # False: the model has no compiled SQL yet (compile it to see options)


async def _project(session: AsyncSession, project_id: int) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


@router.post("/{project_id}/ai/unit-tests", response_model=AiProposalDto, status_code=202)
async def generate(
    project_id: int, dto: GenerateUnitTestDto, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    name = dto.unique_id.split(".")[-1]
    focus = dto.focus.split(":", 1)[-1] if dto.focus else None
    file = None
    if dto.file:  # checked now, so a bad name is a 422 rather than a failed proposal
        project = await _project(session, project_id)
        file = await asyncio.to_thread(_checked_file, Path(project.path), dto.unique_id, dto.file)
    return await _start(
        session, project_id, dto.unique_id, dto.conversation_id,
        kind=UNIT_TEST_KIND,
        title=f"Unit test for {name}" + (f" ({focus})" if focus else ""),
        action=f"Add a unit test to {name}" + (f" for {focus}" if focus else ""),
        options={"focus": dto.focus, "mask": dto.mask, "file": file},
    )


def _model(project_path: Path, unique_id: str) -> tuple[dict, dict]:
    try:
        manifest = load_manifest_dict(project_path)
        return manifest, check_model(manifest, unique_id)
    except (DocumentationError, UnitTestError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _checked_file(project_path: Path, unique_id: str, file: str) -> str:
    _, node = _model(project_path, unique_id)
    try:
        return resolve_file(project_path, file, node["original_file_path"])
    except UnitTestError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{project_id}/unit-tests/file-options", response_model=FileOptionsDto)
async def file_options_route(
    project_id: int, unique_id: str, session: AsyncSession = Depends(get_session)
) -> FileOptionsDto:
    """Where a new unit test for this model can be written (Pro, with generation)."""
    await require_unit_tests(session)
    project = await _project(session, project_id)

    def build() -> FileOptionsDto:
        manifest, node = _model(Path(project.path), unique_id)
        try:
            return FileOptionsDto(**file_options(Path(project.path), manifest, node))
        except UnitTestError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    return await asyncio.to_thread(build)


def _focus_inputs(manifest: dict, unique_id: str) -> list[dict]:
    nodes = {**(manifest.get("nodes") or {}), **(manifest.get("sources") or {})}
    return [
        {"key": i["key"], "relation": i["relation"],
         "columns": list(((nodes.get(i["unique_id"]) or {}).get("columns") or {}).keys())}
        for i in model_inputs(manifest, unique_id)
    ]


@router.get("/{project_id}/unit-tests/focus-options", response_model=FocusOptionsDto)
async def focus_options(
    project_id: int, unique_id: str, session: AsyncSession = Depends(get_session)
) -> FocusOptionsDto:
    """The model's CTEs and CASE columns, from its compiled SQL: the manifest's, else the
    file dbt last compiled to target/compiled/, else a `dbt compile` of just this model."""
    await require_unit_tests(session)
    project = await _project(session, project_id)
    project_path = Path(project.path)
    manifest, node = await asyncio.to_thread(_model, project_path, unique_id)
    sql = node.get("compiled_code") or node.get("compiled_sql")
    if not sql:
        sql = await asyncio.to_thread(compiled_on_disk, project_path, node)
    if not sql:
        incremental = (node.get("config") or {}).get("materialized") == "incremental"
        try:
            env = await load_project_env(project_id)
            sql = await compile_model(project_id, project_path, node["name"], env, incremental)
        except UnitTestError as exc:
            log.info("unit_test_focus_compile_failed", project_id=project_id, unique_id=unique_id, error=str(exc))
            return FocusOptionsDto(options=[], compiled=False)
    adapter = (manifest.get("metadata") or {}).get("adapter_type")
    options = await asyncio.to_thread(pro.focus_options, sql, adapter, _focus_inputs(manifest, unique_id))
    return FocusOptionsDto(options=[FocusOptionDto(**o) for o in options], compiled=True)


@router.post("/{project_id}/unit-tests/{unique_id:path}/rebaseline", response_model=AiProposalDto)
async def rebaseline(
    project_id: int, unique_id: str, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    """A proposal replacing the test's `expect.rows` with what its last run produced."""
    project = await _project(session, project_id)
    manifest = await asyncio.to_thread(load_manifest, Path(project.path) / "target" / "manifest.json")
    unit = next((u for u in manifest.unit_tests if u.unique_id == unique_id), None) if manifest else None
    if unit is None:
        raise HTTPException(status_code=404, detail="unit test not found — parse the project")
    status = (await session.execute(
        select(ModelStatus).where(ModelStatus.project_id == project_id, ModelStatus.unique_id == unique_id)
    )).scalar_one_or_none()
    diff = parse_unit_test_diff(status.message) if status and status.status in ("fail", "error") else None
    if diff is None:
        raise HTTPException(status_code=409, detail="the last run of this unit test has no actual-vs-expected diff")
    try:
        built = await asyncio.to_thread(build_rebaseline, Path(project.path), unit, diff)
    except RebaselineError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    change = built.change
    proposal = AiProposal(
        project_id=project_id, kind=REBASELINE_KIND, unique_id=unique_id,
        title=f"Accept actual rows for {unit.name}", result_json=json.dumps(built.summary), status="ready",
    )
    session.add(proposal)
    await session.flush()
    session.add(AiProposalFile(
        proposal_id=proposal.id, path=change.path, op="modify",
        original_text=change.original, proposed_text=change.proposed,
    ))
    await session.commit()
    await session.refresh(proposal, attribute_names=["files"])
    await _publish(proposal)
    log.info("unit_test_rebaseline_proposed", project_id=project_id, unique_id=unique_id)
    return proposal_dto(proposal)
