"""Accept or reject a whole proposal as one unit, and undo an applied one.

Accept all checks every pending file against disk before writing any of them (409
listing every conflict otherwise); if a write still fails part-way, the files
already written are restored. Files whose items were all rejected in review are
rejected rather than written. Reject all leaves every pending file alone. Undo restores each applied file only while it still
holds exactly what was applied (409 listing the files that changed otherwise).
"""

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import file_ops
from app.ai.gating import REFACTOR_KIND, require_proposal_access
from app.ai.selection import item_keys
from app.api import ai_proposals
from app.api.ai_dtos import AiProposalDto, proposal_dto
from app.api.ai_proposals import _compile_selector, _load, _publish, finish_if_decided
from app.db.engine import get_session
from app.db.models import AiProposal, AiProposalFile, Project
from app.logging_setup import get_logger
from app.refactor.verify import start_verify

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["ai"])


def _conflicts(root: Path, files: list[AiProposalFile], check) -> list[str]:
    conflicts = []
    for f in files:
        try:
            check(root, file_ops.FileOp.of(f))
        except file_ops.FileOpError as exc:
            conflicts.append(str(exc))
    return conflicts


def _apply_all(root: Path, files: list[AiProposalFile]) -> dict[int, str | None]:
    """Write every file; on failure, put back the ones already written and re-raise."""
    applied: dict[int, str | None] = {}
    done: list[file_ops.FileOp] = []
    try:
        for f in files:
            op = file_ops.FileOp.of(f)
            applied[f.id] = file_ops.apply(root, op)
            done.append(replace(op, applied=applied[f.id]))
    except (OSError, file_ops.FileOpError):
        for op in reversed(done):
            try:
                file_ops.undo(root, op)
            except OSError:
                log.exception("ai_proposal_rollback_failed", path=op.path)
        raise
    return applied


def _undo_all(root: Path, files: list[AiProposalFile]) -> None:
    for f in files:
        file_ops.undo(root, file_ops.FileOp.of(f))


async def _project_root(session: AsyncSession, project_id: int) -> Path:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return Path(project.path)


@router.post("/{project_id}/ai/proposals/{proposal_id}/accept", response_model=AiProposalDto)
async def accept_all(
    project_id: int, proposal_id: int, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    """Accept every pending file at once — all of them are written, or none."""
    proposal = await _load(session, project_id, proposal_id)
    await require_proposal_access(session, proposal.kind)
    pending = [f for f in proposal.files if f.status == "pending"]
    if proposal.status != "ready" or not pending:
        raise HTTPException(status_code=409, detail="this change was already handled")
    emptied = _nothing_selected(proposal, pending)
    for f in emptied:
        f.status = "rejected"
    pending = [f for f in pending if f not in emptied]
    root = await _project_root(session, project_id)
    conflicts = await asyncio.to_thread(_conflicts, root, pending, file_ops.check_apply)
    if conflicts:
        raise HTTPException(status_code=409, detail={"error": "conflict", "files": conflicts})
    try:
        applied = await asyncio.to_thread(_apply_all, root, pending)
    except (OSError, file_ops.FileOpError) as exc:
        raise HTTPException(status_code=500, detail=f"could not apply the changes: {exc}") from exc
    for f in pending:
        f.applied_text = applied[f.id]
        f.status = "accepted"
    finish_if_decided(proposal)
    await session.commit()
    log.info("ai_proposal_applied", proposal_id=proposal_id, files=len(pending))
    await _publish(proposal)
    if proposal.kind == REFACTOR_KIND and proposal.status == "applied":
        start_verify(proposal.id, project_id, root)
    elif names := _applied_nodes(proposal, pending):
        # refresh the manifest so docs / side pane pick it up (as accepting one file does)
        asyncio.create_task(ai_proposals._compile_model(project_id, str(root), " ".join(names)))
    return proposal_dto(proposal)


def _applied_nodes(proposal: AiProposal, applied: list[AiProposalFile]) -> list[str]:
    result = json.loads(proposal.result_json or "{}")
    names: set[str] = set()
    for f in applied:
        names.update((_compile_selector(proposal, result, f.path) or "").split())
    return sorted(names)


def _nothing_selected(proposal: AiProposal, pending: list[AiProposalFile]) -> list[AiProposalFile]:
    """Files whose items were all rejected in review (proposals made of separate items)."""
    result = json.loads(proposal.result_json or "{}")
    selected = result.get("selected")
    if selected is None:
        return []
    chosen = set(selected)
    multi = len(proposal.files) > 1
    return [
        f for f in pending
        if not chosen.intersection(item_keys(proposal.kind, result, f.path if multi else None))
    ]


@router.post("/{project_id}/ai/proposals/{proposal_id}/reject", response_model=AiProposalDto)
async def reject_all(
    project_id: int, proposal_id: int, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    """Reject every pending file; nothing is written."""
    proposal = await _load(session, project_id, proposal_id)
    await require_proposal_access(session, proposal.kind)
    pending = [f for f in proposal.files if f.status == "pending"]
    if proposal.status != "ready" or not pending:
        raise HTTPException(status_code=409, detail="this change was already handled")
    for f in pending:
        f.status = "rejected"
    finish_if_decided(proposal)
    await session.commit()
    log.info("ai_proposal_rejected", proposal_id=proposal_id, files=len(pending))
    await _publish(proposal)
    return proposal_dto(proposal)


@router.post("/{project_id}/ai/proposals/{proposal_id}/undo", response_model=AiProposalDto)
async def undo_proposal(
    project_id: int, proposal_id: int, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    """Restore every file an applied proposal changed, if none was edited since."""
    proposal = await _load(session, project_id, proposal_id)
    await require_proposal_access(session, proposal.kind)
    applied = [f for f in proposal.files if f.status == "accepted"]
    if proposal.status != "applied" or not applied:
        raise HTTPException(status_code=409, detail="there's nothing applied to undo")
    root = await _project_root(session, project_id)
    conflicts = await asyncio.to_thread(_conflicts, root, applied, file_ops.check_undo)
    if conflicts:
        raise HTTPException(status_code=409, detail={"error": "changed_since_applied", "files": conflicts})
    try:
        await asyncio.to_thread(_undo_all, root, applied)
    except (OSError, file_ops.FileOpError) as exc:
        raise HTTPException(status_code=500, detail=f"could not undo: {exc}") from exc
    for f in applied:
        f.status = "undone"
    proposal.status = "undone"
    proposal.updated_at = datetime.now(UTC)
    await session.commit()
    log.info("ai_proposal_undone", proposal_id=proposal_id, files=len(applied))
    await _publish(proposal)
    return proposal_dto(proposal)
