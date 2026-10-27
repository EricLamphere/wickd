"""Refactors (wickd Pro): rename a model, rename a column, extract a CTE into a model.

- POST /refactor — the operation itself (from a menu, or a confirmed Wicky card).
  Gated by the Pro entitlement only: no local AI model needed. Builds an
  `ai_proposals` row of kind "refactor" in the background (one file per change,
  with create / rename ops), announced with `ai_proposal_updated`; edits the
  engine wouldn't make safely are in its result's `manual` list.
- POST /ai/conversations/{cid}/refactor — Wicky turns a request into one
  operation and records it as a `refactor` message (a confirm card); nothing is
  built until the user confirms it through POST /refactor with `message_id`.
- POST /ai/messages/{mid}/refactor/cancel — the user dismissed the card.
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import pro as ai_pro
from app.ai.client import LlmError
from app.ai.config import load_ai_config
from app.ai.documentation import DocumentationError, load_manifest_dict
from app.ai.gating import REFACTOR_KIND, require_ai, require_refactor
from app.ai.runtime import RuntimeUnavailable
from app.api.ai_chat import Question, _conversation, _project, chat_history
from app.api.ai_dtos import AiMessageDto, AiProposalDto, message_dto, proposal_dto
from app.api.ai_proposals import _publish
from app.api.ai_query import TITLE_CHARS, _write_sql
from app.db.engine import get_session
from app.db.models import (
    AiConversation,
    AiMessage,
    AiProposal,
    AiProposalFile,
    ColumnLineageSnapshot,
)
from app.logging_setup import get_logger
from app.refactor import inputs
from app.refactor.service import RefactorFailed, run

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["refactor"])

class RefactorDto(BaseModel):
    op: Literal["rename_model", "rename_column", "extract_cte"]
    unique_id: str = Field(min_length=1, max_length=512)
    new_name: str = Field(min_length=1, max_length=255)
    column: str | None = Field(default=None, max_length=255)  # rename_column
    cte: str | None = Field(default=None, max_length=255)  # extract_cte
    conversation_id: int | None = None  # record it in this chat's history
    message_id: int | None = None  # the Wicky confirm card this came from

    @model_validator(mode="after")
    def _needs(self) -> "RefactorDto":
        if self.op == "rename_column" and not (self.column or "").strip():
            raise ValueError("column is required to rename a column")
        if self.op == "extract_cte" and not (self.cte or "").strip():
            raise ValueError("cte is required to extract a CTE")
        return self

    def operation(self) -> dict:
        op = {"op": self.op, "unique_id": self.unique_id, "new_name": self.new_name.strip()}
        if self.op == "rename_column":
            op["column"] = (self.column or "").strip()
        if self.op == "extract_cte":
            op["cte"] = (self.cte or "").strip()
        return op


class RefactorRequestDto(BaseModel):
    content: Question
    unique_id: str | None = Field(default=None, max_length=512)


# ── Building the proposal ────────────────────────────────────────────────────


async def _lineage(session: AsyncSession, project_id: int) -> dict:
    """The latest finished column lineage scan, or {} (the engine is more cautious without it)."""
    result = await session.execute(
        select(ColumnLineageSnapshot)
        .where(ColumnLineageSnapshot.project_id == project_id, ColumnLineageSnapshot.status == "done")
        .order_by(ColumnLineageSnapshot.id.desc())
        .limit(1)
    )
    snap = result.scalar_one_or_none()
    if snap is None:
        return {}
    try:
        return {
            "results": json.loads(snap.results_json or "{}"),
            "row_dependencies": json.loads(snap.row_dependencies_json or "{}"),
        }
    except json.JSONDecodeError:
        return {}


async def _record_in_chat(
    session: AsyncSession, project_id: int, dto: RefactorDto, proposal: AiProposal, action: str
) -> None:
    if dto.conversation_id is None:
        return
    conversation = await session.get(AiConversation, dto.conversation_id)
    if conversation is None or conversation.project_id != project_id:
        raise HTTPException(status_code=404, detail="conversation not found")
    session.add(AiMessage(
        conversation_id=conversation.id, role="action", content=action,
        unique_id=dto.unique_id, proposal_id=proposal.id,
    ))
    if dto.message_id is not None:
        card = await session.get(AiMessage, dto.message_id)
        if card is not None and card.conversation_id == conversation.id and card.role == "refactor":
            payload = json.loads(card.payload_json or "{}")
            card.payload_json = json.dumps({**payload, "status": "confirmed", "proposal_id": proposal.id})
    if not conversation.title:
        conversation.title = action[:TITLE_CHARS]
    conversation.updated_at = datetime.now(UTC)


@router.post("/{project_id}/refactor", response_model=AiProposalDto, status_code=202)
async def start_refactor(
    project_id: int, dto: RefactorDto, session: AsyncSession = Depends(get_session)
) -> AiProposalDto:
    await require_refactor(session)
    project = await _project(session, project_id)
    busy = await session.execute(
        select(AiProposal.id).where(
            AiProposal.project_id == project_id,
            AiProposal.kind == REFACTOR_KIND,
            AiProposal.status == "generating",
        )
    )
    if busy.first() is not None:
        raise HTTPException(status_code=409, detail="a refactor is already being prepared")

    operation = dto.operation()
    title = inputs.describe({**operation, "model": dto.unique_id.split(".")[-1]})
    proposal = AiProposal(
        project_id=project_id, kind=REFACTOR_KIND, unique_id=dto.unique_id, title=title,
        status="generating", result_json=json.dumps({"summary": operation}),
    )
    session.add(proposal)
    await session.flush()
    await _record_in_chat(session, project_id, dto, proposal, title)
    await session.commit()
    await session.refresh(proposal, attribute_names=["files"])
    lineage = await _lineage(session, project_id) if dto.op == "rename_column" else {}
    asyncio.create_task(_build(proposal.id, Path(project.path), operation, lineage))
    await _publish(proposal)
    return proposal_dto(proposal)


async def _build(proposal_id: int, project_path: Path, operation: dict, lineage: dict) -> None:
    from app.db import engine as db_engine  # patched in tests, like other background writers

    result: dict | None = None
    error: str | None = None
    try:
        result = await asyncio.to_thread(run, project_path, operation, lineage)
    except RefactorFailed as exc:
        error = str(exc)
    except Exception as exc:  # never leave a proposal stuck in `generating`
        log.exception("refactor_crashed", proposal_id=proposal_id, op=operation["op"])
        error = f"unexpected error: {exc}"

    async with db_engine.SessionLocal() as session:
        proposal = await session.get(AiProposal, proposal_id)
        if proposal is None or proposal.status != "generating":
            return  # dismissed while building
        if result is not None and result["changes"]:
            for change in result["changes"]:
                session.add(AiProposalFile(
                    proposal_id=proposal_id, path=change["path"], op=change["op"],
                    new_path=change.get("new_path"), original_text=change["original"],
                    proposed_text=change["proposed"] or "",
                ))
            proposal.status = "ready"
        elif result is not None:
            proposal.status = "empty"
            proposal.error_message = "Nothing to change."
        else:
            proposal.status = "error"
            proposal.error_message = error
            log.info("refactor_refused", proposal_id=proposal_id, op=operation["op"], reason=error)
        if result is not None:
            proposal.result_json = json.dumps({
                "summary": {**operation, **result["summary"]},
                "manual": result["manual"],
                "notes": result["notes"],
            })
        proposal.updated_at = datetime.now(UTC)
        await session.commit()
        await _publish(proposal)


# ── Wicky: request → operation ───────────────────────────────────────────────


@router.post("/{project_id}/ai/conversations/{cid}/refactor", response_model=list[AiMessageDto])
async def parse_request(
    project_id: int, cid: int, dto: RefactorRequestDto, session: AsyncSession = Depends(get_session)
) -> list[AiMessageDto]:
    """The request + a `refactor` message holding the parsed operation for the user to confirm."""
    await require_ai(session)
    await require_refactor(session)
    project = await _project(session, project_id)
    conversation = await _conversation(session, project_id, cid)
    try:
        manifest = await asyncio.to_thread(load_manifest_dict, Path(project.path))
    except DocumentationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    prompt = ai_pro.refactor_prompt(manifest, dto.unique_id, chat_history(conversation), dto.content)
    config = await load_ai_config(session)
    try:
        raw = await _write_sql(config, prompt["messages"], prompt["schema"], prompt.get("max_tokens"))
        operation = ai_pro.parse_refactor_intent(raw, manifest, dto.unique_id)
    except (RuntimeUnavailable, LlmError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        operation = {"op": "none", "reason": f"I couldn't work out the refactor ({exc}). Try naming the model and the new name."}

    if operation["op"] == "none":
        payload = {"request": dto.content, "operation": None, "description": "", "reason": operation["reason"], "status": "none"}
        content = operation["reason"]
    else:
        description = inputs.describe(operation, manifest)
        payload = {"request": dto.content, "operation": operation, "description": description, "status": "proposed"}
        content = description
    request = AiMessage(conversation_id=cid, role="user", content=dto.content, unique_id=dto.unique_id)
    card = AiMessage(
        conversation_id=cid, role="refactor", content=content,
        unique_id=dto.unique_id, payload_json=json.dumps(payload),
    )
    session.add_all([request, card])
    if not conversation.title:
        conversation.title = dto.content[:TITLE_CHARS]
    conversation.updated_at = datetime.now(UTC)
    await session.commit()
    return [message_dto(request), message_dto(card)]


@router.post("/{project_id}/ai/messages/{mid}/refactor/cancel", response_model=AiMessageDto)
async def cancel_request(
    project_id: int, mid: int, session: AsyncSession = Depends(get_session)
) -> AiMessageDto:
    message = await session.get(AiMessage, mid)
    if message is None or message.role != "refactor":
        raise HTTPException(status_code=404, detail="refactor not found")
    await _conversation(session, project_id, message.conversation_id)  # scopes it to the project
    payload = json.loads(message.payload_json or "{}")
    if payload.get("status") == "proposed":
        message.payload_json = json.dumps({**payload, "status": "cancelled"})
        await session.commit()
    return message_dto(message)
