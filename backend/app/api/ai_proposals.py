"""AI-generated file changes the user reviews and accepts or rejects per file (wickd Pro).

Generation runs in the background (a local model can take a minute); the
proposal row is created up front with status `generating` and every status
change is announced with an `ai_proposal_updated` project event. While it
runs, `ai_proposal_progress` events carry the phase and the model's answer so
far (throttled), so Wicky can show the descriptions as they're written.

Accepting a file re-reads it first: if it changed since the proposal was
made (the user edited it, or switched branches), the accept is refused with
409 rather than overwriting their work.
"""

import asyncio
import json
import time
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.ai.client import LlmError
from app.ai.config import load_ai_config
from app.ai.documentation import generate_documentation
from app.ai.errors import NothingToPropose, ProposalError
from app.ai.gating import require_ai
from app.ai.pro import AiUnavailable
from app.ai.runtime import RuntimeUnavailable
from app.ai.selection import SelectionError, rebuild
from app.ai.test_generation import generate_tests
from app.api.ai_dtos import AiProposalDto, proposal_dto
from app.api.init import load_project_env
from app.api.models import _compile_model
from app.db.engine import get_session
from app.db.models import AiConversation, AiMessage, AiProposal, AiProposalFile, Project
from app.dbt.schema_yaml import SchemaYamlError
from app.events.bus import Event, bus
from app.logging_setup import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["ai"])

# `empty` = nothing needed changing (shown as a note, not a failure)
ACTIVE_STATUSES = ("generating", "ready", "error", "empty")
PROGRESS_INTERVAL_S = 0.25


class DocumentWithAiDto(BaseModel):
    unique_id: str = Field(min_length=1, max_length=512)
    overwrite: bool = False  # replace descriptions that already exist
    # chat to record the action in, so it stays in that conversation's history
    conversation_id: int | None = None


async def _publish(proposal: AiProposal) -> None:
    await bus.publish(Event(
        topic=f"project:{proposal.project_id}",
        type="ai_proposal_updated",
        data={"proposal_id": proposal.id, "status": proposal.status, "unique_id": proposal.unique_id},
    ))


async def _load(session: AsyncSession, project_id: int, proposal_id: int) -> AiProposal:
    result = await session.execute(
        select(AiProposal)
        .where(AiProposal.id == proposal_id, AiProposal.project_id == project_id)
        .options(selectinload(AiProposal.files))
    )
    proposal = result.scalar_one_or_none()
    if proposal is None:
        raise HTTPException(status_code=404, detail="proposal not found")
    return proposal


class SelectionDto(BaseModel):
    keys: list[str] = Field(max_length=500)  # items kept in the file (i.e. not rejected)
    accepted: list[str] = Field(default=[], max_length=500)  # of those, already accepted


class AddTestsDto(BaseModel):
    unique_id: str = Field(min_length=1, max_length=512)
    conversation_id: int | None = None


@router.post("/{project_id}/ai/document", response_model=AiProposalDto, status_code=202)
async def document_with_ai(
    project_id: int, dto: DocumentWithAiDto, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    name = dto.unique_id.split(".")[-1]
    return await _start(
        session, project_id, dto.unique_id, dto.conversation_id,
        kind="document",
        title=f"Documentation for {name}",
        action=f"Document {name}" + (" (rewrite all)" if dto.overwrite else ""),
        options={"overwrite": dto.overwrite},
    )


@router.post("/{project_id}/ai/tests", response_model=AiProposalDto, status_code=202)
async def add_tests_with_ai(
    project_id: int, dto: AddTestsDto, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    name = dto.unique_id.split(".")[-1]
    return await _start(
        session, project_id, dto.unique_id, dto.conversation_id,
        kind="tests", title=f"Tests for {name}", action=f"Add tests to {name}", options={},
    )


async def _start(
    session: AsyncSession,
    project_id: int,
    unique_id: str,
    conversation_id: int | None,
    *,
    kind: str,
    title: str,
    action: str,
    options: dict,
) -> AiProposalDto:
    """Create the proposal (+ the chat entry recording it) and generate in the background."""
    await require_ai(session)
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    busy = await session.execute(
        select(AiProposal.id).where(
            AiProposal.project_id == project_id,
            AiProposal.unique_id == unique_id,
            AiProposal.kind == kind,
            AiProposal.status == "generating",
        )
    )
    if busy.first() is not None:
        raise HTTPException(status_code=409, detail="already working on this for this node")

    conversation = None
    if conversation_id is not None:
        conversation = await session.get(AiConversation, conversation_id)
        if conversation is None or conversation.project_id != project_id:
            raise HTTPException(status_code=404, detail="conversation not found")

    proposal = AiProposal(
        project_id=project_id, kind=kind, unique_id=unique_id, title=title, status="generating"
    )
    session.add(proposal)
    await session.flush()
    if conversation is not None:
        session.add(AiMessage(
            conversation_id=conversation.id,
            role="action",
            content=action,
            unique_id=unique_id,
            proposal_id=proposal.id,
        ))
        if not conversation.title:
            conversation.title = action
        conversation.updated_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(proposal, attribute_names=["files"])
    asyncio.create_task(
        _generate(proposal.id, project_id, Path(project.path), unique_id, kind, options)
    )
    await _publish(proposal)
    return proposal_dto(proposal)


class _Progress:
    """Publishes `ai_proposal_progress`, at most every PROGRESS_INTERVAL_S for text updates."""

    def __init__(self, project_id: int, proposal_id: int, unique_id: str) -> None:
        self._topic = f"project:{project_id}"
        self._base = {"proposal_id": proposal_id, "unique_id": unique_id}
        self._phase = ""
        self._last = 0.0

    async def _send(self, text: str) -> None:
        self._last = time.monotonic()
        await bus.publish(Event(
            topic=self._topic,
            type="ai_proposal_progress",
            data={**self._base, "phase": self._phase, "text": text},
        ))

    async def phase(self, phase: str) -> None:
        self._phase = phase
        await self._send("")

    async def text(self, text: str) -> None:
        if time.monotonic() - self._last >= PROGRESS_INTERVAL_S:
            await self._send(text)


async def _generate(
    proposal_id: int, project_id: int, project_path: Path, unique_id: str, kind: str, options: dict
) -> None:
    from app.db import engine as db_engine  # patched in tests, like other background writers

    progress = _Progress(project_id, proposal_id, unique_id)
    status, summary = "error", None
    try:
        async with db_engine.SessionLocal() as session:
            config = await load_ai_config(session)
        env = await load_project_env(project_id)
        # looked up per call (not a module-level dict) so tests can patch either generator
        generator = {"document": generate_documentation, "tests": generate_tests}[kind]
        result = await generator(
            project_id=project_id,
            project_path=project_path,
            unique_id=unique_id,
            env=env,
            config=config,
            on_phase=progress.phase,
            on_text=progress.text,
            **options,
        )
        error, change, summary = None, result.change, result.summary
    except NothingToPropose as exc:
        status, error, change = "empty", str(exc), None
    except (ProposalError, SchemaYamlError, RuntimeUnavailable, LlmError, AiUnavailable) as exc:
        error, change = str(exc), None
    except Exception as exc:  # never leave a proposal stuck in `generating`
        log.exception("ai_proposal_crashed", proposal_id=proposal_id, kind=kind)
        error, change = f"unexpected error: {exc}", None

    async with db_engine.SessionLocal() as session:
        proposal = await session.get(AiProposal, proposal_id)
        if proposal is None or proposal.status != "generating":
            return  # dismissed while generating
        if change is not None:
            session.add(AiProposalFile(
                proposal_id=proposal_id,
                path=change.path,
                original_text=change.original,
                proposed_text=change.proposed,
            ))
            proposal.status = "ready"
            proposal.result_json = json.dumps(summary or {})
        else:
            proposal.status = status
            proposal.error_message = error
            if status == "error":
                log.warning("ai_proposal_failed", proposal_id=proposal_id, kind=kind, error=error)
        proposal.updated_at = datetime.now(UTC)
        await session.commit()
        await _publish(proposal)


@router.get("/{project_id}/ai/proposals", response_model=list[AiProposalDto])
async def list_proposals(
    project_id: int,
    unique_id: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[AiProposalDto]:
    """Proposals still needing attention (generating, ready for review, or failed)."""
    await require_ai(session)
    query = (
        select(AiProposal)
        .where(AiProposal.project_id == project_id, AiProposal.status.in_(ACTIVE_STATUSES))
        .options(selectinload(AiProposal.files))
        .order_by(AiProposal.id.desc())
    )
    if unique_id is not None:
        query = query.where(AiProposal.unique_id == unique_id)
    result = await session.execute(query)
    return [proposal_dto(p) for p in result.scalars().all()]


@router.get("/{project_id}/ai/proposals/{proposal_id}", response_model=AiProposalDto)
async def get_proposal(
    project_id: int, proposal_id: int, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    await require_ai(session)
    return proposal_dto(await _load(session, project_id, proposal_id))


@router.delete("/{project_id}/ai/proposals/{proposal_id}", status_code=204)
async def dismiss_proposal(
    project_id: int, proposal_id: int, session: AsyncSession = Depends(get_session)
) -> None:
    """Take it off the active list. The row stays, so chat history still shows what happened."""
    proposal = await _load(session, project_id, proposal_id)
    if proposal.status in ACTIVE_STATUSES:
        proposal.status = "dismissed"
        proposal.updated_at = datetime.now(UTC)
        await session.commit()
    await _publish(proposal)


def _project_file(project_path: Path, relative: str) -> Path:
    root = project_path.resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise HTTPException(status_code=400, detail="file is outside the project")
    return path


def _read_current(path: Path) -> str | None:
    if not path.exists():
        return None
    with path.open(encoding="utf-8", newline="") as f:
        return f.read()


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write(text)


@router.put("/{project_id}/ai/proposals/{proposal_id}/selection", response_model=AiProposalDto)
async def select_items(
    project_id: int, proposal_id: int, dto: SelectionDto, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    """Keep only some of a proposal's items: the file is rebuilt from its original text."""
    await require_ai(session)
    proposal = await _load(session, project_id, proposal_id)
    if proposal.status != "ready" or len(proposal.files) != 1 or proposal.files[0].status != "pending":
        raise HTTPException(status_code=409, detail="this change was already handled")
    file = proposal.files[0]
    result = json.loads(proposal.result_json or "{}")
    keys = list(dict.fromkeys(dto.keys))
    accepted = [k for k in dict.fromkeys(dto.accepted) if k in keys]
    try:
        text = await asyncio.to_thread(
            rebuild, proposal.kind, result, file.original_text, Path(file.path).name, keys
        )
    except (SelectionError, SchemaYamlError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    file.proposed_text = text
    proposal.result_json = json.dumps({**result, "selected": keys, "accepted": accepted})
    proposal.updated_at = datetime.now(UTC)
    await session.commit()
    return proposal_dto(proposal)


async def _decide(
    session: AsyncSession, project_id: int, proposal_id: int, file_id: int, accept: bool
) -> AiProposalDto:
    await require_ai(session)
    proposal = await _load(session, project_id, proposal_id)
    file = next((f for f in proposal.files if f.id == file_id), None)
    if file is None:
        raise HTTPException(status_code=404, detail="file not found in proposal")
    if proposal.status != "ready" or file.status != "pending":
        raise HTTPException(status_code=409, detail="this change was already handled")

    if accept and json.loads(proposal.result_json or "{}").get("selected") == []:
        raise HTTPException(status_code=409, detail="nothing is selected — reject it instead")
    if accept:
        project = await session.get(Project, project_id)
        assert project is not None
        path = _project_file(Path(project.path), file.path)
        current = await asyncio.to_thread(_read_current, path)
        if current != file.original_text:
            raise HTTPException(
                status_code=409,
                detail=f"{file.path} changed since this was generated — regenerate to review it again",
            )
        try:
            await asyncio.to_thread(_write, path, file.proposed_text)
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"could not write {file.path}: {exc}") from exc
        log.info("ai_proposal_file_accepted", proposal_id=proposal_id, path=file.path)

    file.status = "accepted" if accept else "rejected"
    if all(f.status != "pending" for f in proposal.files):
        any_accepted = any(f.status == "accepted" for f in proposal.files)
        proposal.status = "applied" if any_accepted else "rejected"
    proposal.updated_at = datetime.now(UTC)
    await session.commit()
    await _publish(proposal)

    if accept and proposal.unique_id:
        project = await session.get(Project, project_id)
        if project is not None:  # refresh the manifest so docs / side pane pick it up
            asyncio.create_task(
                _compile_model(project_id, project.path, proposal.unique_id.split(".")[-1])
            )
    return proposal_dto(proposal)


@router.post("/{project_id}/ai/proposals/{proposal_id}/files/{file_id}/accept", response_model=AiProposalDto)
async def accept_file(
    project_id: int, proposal_id: int, file_id: int, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    return await _decide(session, project_id, proposal_id, file_id, accept=True)


@router.post("/{project_id}/ai/proposals/{proposal_id}/files/{file_id}/reject", response_model=AiProposalDto)
async def reject_file(
    project_id: int, proposal_id: int, file_id: int, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    return await _decide(session, project_id, proposal_id, file_id, accept=False)
