"""Lineage propagation (wickd Pro): inherited descriptions and tag flow.

Both read the latest column lineage snapshot, which must record transform
kinds (lineage_version 3) — otherwise 409 `{"error": "lineage_not_ready",
"reason": missing | running | outdated | error}` and the UI offers a refresh.

Writing is never direct: the POST routes build an `ai_proposals` row of kind
"propagate" (one file per schema YAML touched) in the background and announce
it with `ai_proposal_updated`, so it's reviewed in the same modal as Wicky's
proposals, item by item.
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.documentation import load_manifest_dict
from app.ai.errors import ProposalError
from app.api.ai_dtos import AiProposalDto, proposal_dto
from app.api.ai_proposals import _publish
from app.db.engine import get_session
from app.db.models import AiProposal, AiProposalFile, ColumnLineageSnapshot, Project, ProjectEnvVar
from app.licensing.gating import require_pro
from app.logging_setup import get_logger
from app.propagation import inputs, pro
from app.propagation import proposals as builder

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["propagation"])

KINDS_LINEAGE_VERSION = 3
PASS_THROUGH = ("identity", "rename")


async def _require(session: AsyncSession) -> None:
    await require_pro(
        session,
        available=pro.is_available,
        unavailable_detail="Lineage propagation requires the wickd Pro package, which isn't installed in this build.",
    )


async def _project(session: AsyncSession, project_id: int) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


async def _lineage(session: AsyncSession, project_id: int) -> dict:
    result = await session.execute(
        select(ColumnLineageSnapshot)
        .where(ColumnLineageSnapshot.project_id == project_id)
        .order_by(ColumnLineageSnapshot.id.desc())
        .limit(1)
    )
    snap = result.scalar_one_or_none()
    reason = None
    if snap is None:
        reason = "missing"
    elif snap.status == "running":
        reason = "running"
    elif snap.status != "done":
        reason = "error"
    elif (snap.lineage_version or 1) < KINDS_LINEAGE_VERSION:
        reason = "outdated"
    if reason is not None:
        raise HTTPException(status_code=409, detail={"error": "lineage_not_ready", "reason": reason})
    try:
        return json.loads(snap.results_json or "{}")
    except json.JSONDecodeError:
        return {}


async def _configured_tags(session: AsyncSession, project_id: int) -> list[str]:
    result = await session.execute(
        select(ProjectEnvVar.value).where(
            ProjectEnvVar.project_id == project_id, ProjectEnvVar.key == inputs.TAGS_SETTING
        )
    )
    return inputs.parse_tags(result.scalar_one_or_none())


def _manifest(project: Project) -> dict:
    try:
        return load_manifest_dict(Path(project.path))
    except ProposalError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _allowed_kinds(include_casts: bool) -> tuple[str, ...]:
    return (*PASS_THROUGH, "cast") if include_casts else PASS_THROUGH


def _fills(lineage: dict, manifest: dict, unique_ids: list[str] | None, include_casts: bool) -> dict:
    writable = inputs.writable_nodes(manifest)
    scope = [u for u in unique_ids if u in writable] if unique_ids else list(writable)
    return pro.inherit_descriptions(
        lineage, inputs.column_docs(manifest), allowed_kinds=_allowed_kinds(include_casts), unique_ids=scope
    )


# ── Descriptions ─────────────────────────────────────────────────────────────


class DescriptionPreviewDto(BaseModel):
    fillable: int
    conflicts: int
    by_node: dict[str, int]  # unique_id → fillable columns


@router.get("/{project_id}/propagate/descriptions", response_model=DescriptionPreviewDto)
async def preview_descriptions(
    project_id: int,
    unique_id: str | None = None,
    include_casts: bool = True,
    session: AsyncSession = Depends(get_session),
) -> DescriptionPreviewDto:
    """How many empty descriptions lineage could fill (for button counts)."""
    await _require(session)
    project = await _project(session, project_id)
    lineage = await _lineage(session, project_id)
    manifest = await asyncio.to_thread(_manifest, project)
    scope = [unique_id] if unique_id else None
    result = await asyncio.to_thread(_fills, lineage, manifest, scope, include_casts)
    by_node: dict[str, int] = {}
    for fill in result["fills"]:
        by_node[fill["unique_id"]] = by_node.get(fill["unique_id"], 0) + 1
    return DescriptionPreviewDto(
        fillable=len(result["fills"]), conflicts=len(result["conflicts"]), by_node=by_node
    )


class PropagateDescriptionsDto(BaseModel):
    unique_ids: list[str] | None = Field(default=None, max_length=5000)  # None = whole project
    include_casts: bool = True


@router.post("/{project_id}/propagate/descriptions", response_model=AiProposalDto, status_code=202)
async def propagate_descriptions(
    project_id: int, dto: PropagateDescriptionsDto, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    await _require(session)
    project = await _project(session, project_id)
    lineage = await _lineage(session, project_id)
    single = dto.unique_ids[0] if dto.unique_ids and len(dto.unique_ids) == 1 else None
    title = f"Inherited descriptions for {single.split('.')[-1]}" if single else "Inherited descriptions"
    options = {"unique_ids": dto.unique_ids, "include_casts": dto.include_casts}
    return await _start(session, project, single, title, "descriptions", lineage, options)


# ── Tags ─────────────────────────────────────────────────────────────────────


class TagFlowColumnDto(BaseModel):
    unique_id: str
    name: str
    resource_type: str
    column: str
    declared: bool
    via_kind: str | None
    path: list[dict]


class TagFlowExposureDto(BaseModel):
    unique_id: str
    name: str
    via: list[str]


class TagFlowDto(BaseModel):
    tag: str
    tags: list[str]  # the project's propagating tags (PROPAGATE_TAGS)
    columns: list[TagFlowColumnDto]
    exposures: list[TagFlowExposureDto]


def _tag_flow(lineage: dict, manifest: dict, tag: str) -> dict:
    return pro.tag_flow(lineage, inputs.declared_tags(manifest), [tag], inputs.exposures(manifest))


@router.get("/{project_id}/lineage/tag-flow", response_model=TagFlowDto)
async def tag_flow(
    project_id: int, tag: str | None = None, session: AsyncSession = Depends(get_session)
) -> TagFlowDto:
    """Every column and exposure that carries data from columns tagged `tag`."""
    await _require(session)
    project = await _project(session, project_id)
    tags = await _configured_tags(session, project_id)
    chosen = (tag or tags[0]).strip().lower()
    if not chosen:
        raise HTTPException(status_code=422, detail="tag is required")
    lineage = await _lineage(session, project_id)
    manifest = await asyncio.to_thread(_manifest, project)
    flow = await asyncio.to_thread(_tag_flow, lineage, manifest, chosen)
    nodes = {**(manifest.get("nodes") or {}), **(manifest.get("sources") or {})}
    return TagFlowDto(
        tag=chosen,
        tags=tags,
        columns=[
            TagFlowColumnDto(
                unique_id=c["unique_id"],
                name=(nodes.get(c["unique_id"]) or {}).get("name") or c["unique_id"].split(".")[-1],
                resource_type=(nodes.get(c["unique_id"]) or {}).get("resource_type") or "",
                column=c["column"],
                declared=c["declared"],
                via_kind=c["via_kind"],
                path=c["path"],
            )
            for c in flow["columns"]
        ],
        exposures=[TagFlowExposureDto(unique_id=e["unique_id"], name=e["name"], via=e["via"]) for e in flow["exposures"]],
    )


class PropagateTagsDto(BaseModel):
    tag: str | None = Field(default=None, max_length=255)  # None = every propagating tag


@router.post("/{project_id}/propagate/tags", response_model=AiProposalDto, status_code=202)
async def propagate_tags(
    project_id: int, dto: PropagateTagsDto, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    await _require(session)
    project = await _project(session, project_id)
    lineage = await _lineage(session, project_id)
    tags = [dto.tag.strip().lower()] if dto.tag and dto.tag.strip() else await _configured_tags(session, project_id)
    title = f"Inherited `{tags[0]}` tags" if len(tags) == 1 else "Inherited tags"
    return await _start(session, project, None, title, "tags", lineage, {"tags": tags})


# ── Building the proposal ────────────────────────────────────────────────────


async def _start(
    session: AsyncSession,
    project: Project,
    unique_id: str | None,
    title: str,
    work: str,
    lineage: dict,
    options: dict,
) -> AiProposalDto:
    busy = await session.execute(
        select(AiProposal.id).where(
            AiProposal.project_id == project.id,
            AiProposal.kind == builder.KIND,
            AiProposal.title == title,
            AiProposal.status == "generating",
        )
    )
    if busy.first() is not None:
        raise HTTPException(status_code=409, detail="already working on this")
    proposal = AiProposal(
        project_id=project.id, kind=builder.KIND, unique_id=unique_id, title=title, status="generating"
    )
    session.add(proposal)
    await session.commit()
    await session.refresh(proposal, attribute_names=["files"])
    asyncio.create_task(_build(proposal.id, Path(project.path), work, lineage, options))
    await _publish(proposal)
    return proposal_dto(proposal)


def _compute(project_path: Path, work: str, lineage: dict, options: dict) -> tuple[builder.PropagationChanges, dict]:
    manifest = load_manifest_dict(project_path)
    writable = inputs.writable_nodes(manifest)
    if work == "descriptions":
        result = _fills(lineage, manifest, options.get("unique_ids"), options.get("include_casts", True))
        raw = builder.RawDescriptions(project_path, manifest)
        items = builder.description_items(result["fills"], raw)
        extra = {"conflicts": result["conflicts"]}
    else:
        inherited = pro.inherit_tags(lineage, inputs.declared_tags(manifest), options["tags"])
        items = builder.tag_items(inherited)
        extra = {}
    return builder.build_changes(project_path, writable, items), extra


async def _build(proposal_id: int, project_path: Path, work: str, lineage: dict, options: dict) -> None:
    from app.db import engine as db_engine  # patched in tests, like other background writers

    built: builder.PropagationChanges | None = None
    extra: dict = {}
    error: str | None = None
    try:
        built, extra = await asyncio.to_thread(_compute, project_path, work, lineage, options)
    except ProposalError as exc:
        error = str(exc)
    except Exception as exc:  # never leave a proposal stuck in `generating`
        log.exception("propagate_proposal_crashed", proposal_id=proposal_id)
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
            proposal.error_message = (
                "Nothing to fill in — no empty description has a documented pass-through upstream column."
                if work == "descriptions"
                else "Nothing to add — every column carrying tagged data already declares the tag."
            )
        else:
            proposal.status = "error"
            proposal.error_message = error
        proposal.result_json = json.dumps({
            "items": list(built.items) if built else [],
            "skipped": list(built.skipped) if built else [],
            **extra,
        })
        proposal.updated_at = datetime.now(UTC)
        await session.commit()
        await _publish(proposal)
