"""Ask mode: chat about a project, answered from its manifest (wickd Pro).

Replies stream back on the POST itself as text/event-stream (`delta`, then
`done` or `error`) rather than over the project bus: token-by-token events
would flood every other subscriber's queue for no benefit.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from starlette.responses import StreamingResponse

from app.ai import pro
from app.ai.client import LlmError, stream_chat
from app.ai.config import load_ai_config
from app.ai.documentation import DocumentationError, load_manifest_dict
from app.ai.gating import require_ai
from app.ai.provider import resolve_provider
from app.ai.run_context import failing_rows, node_run_info
from app.ai.runtime import RuntimeUnavailable, llama_server
from app.api.ai_dtos import AiMessageDto, iso, message_dto
from app.api.init import load_project_env
from app.db.engine import get_session
from app.db.models import AiConversation, AiMessage, AiProposal, Project
from app.logging_setup import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["ai"])

TITLE_CHARS = 80
MAX_REPLY_TOKENS = 2048

Question = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]


class AiConversationDto(BaseModel):
    id: int
    title: str
    updated_at: str


class AiConversationDetailDto(AiConversationDto):
    messages: list[AiMessageDto]


class AskDto(BaseModel):
    content: Question
    unique_id: str | None = Field(default=None, max_length=512)
    # explain_failure: diagnose the node's latest failed run/tests (needs unique_id)
    mode: Literal["ask", "explain_failure"] = "ask"


def _conversation_dto(c: AiConversation) -> AiConversationDto:
    return AiConversationDto(id=c.id, title=c.title, updated_at=iso(c.updated_at))


def chat_history(conversation: AiConversation) -> list[dict]:
    """The dialogue so far, for the model. Quick-action entries aren't dialogue; a query
    is, as the SQL Wicky wrote, so follow-up questions can build on it."""
    history = []
    for m in conversation.messages:
        if m.role in ("user", "assistant"):
            history.append({"role": m.role, "content": m.content})
        elif m.role == "query":
            sql = (json.loads(m.payload_json or "{}") or {}).get("sql", "")
            history.append({"role": "assistant", "content": f"{m.content}\n```sql\n{sql}\n```"})
    return history


async def _project(session: AsyncSession, project_id: int) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


async def _conversation(session: AsyncSession, project_id: int, cid: int) -> AiConversation:
    result = await session.execute(
        select(AiConversation)
        .where(AiConversation.id == cid, AiConversation.project_id == project_id)
        .options(
            selectinload(AiConversation.messages)
            .selectinload(AiMessage.proposal)
            .selectinload(AiProposal.files)
        )
    )
    conversation = result.scalar_one_or_none()
    if conversation is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return conversation


@router.get("/{project_id}/ai/conversations", response_model=list[AiConversationDto])
async def list_conversations(
    project_id: int, session: AsyncSession = Depends(get_session)
) -> list[AiConversationDto]:
    await require_ai(session)
    result = await session.execute(
        select(AiConversation)
        .where(AiConversation.project_id == project_id)
        .order_by(AiConversation.updated_at.desc(), AiConversation.id.desc())
    )
    return [_conversation_dto(c) for c in result.scalars().all()]


@router.post("/{project_id}/ai/conversations", response_model=AiConversationDetailDto, status_code=201)
async def create_conversation(
    project_id: int, session: AsyncSession = Depends(get_session)
) -> AiConversationDetailDto:
    await require_ai(session)
    await _project(session, project_id)
    conversation = AiConversation(project_id=project_id, title="")
    session.add(conversation)
    await session.commit()
    await session.refresh(conversation)
    return AiConversationDetailDto(**_conversation_dto(conversation).model_dump(), messages=[])


@router.get("/{project_id}/ai/conversations/{cid}", response_model=AiConversationDetailDto)
async def get_conversation(
    project_id: int, cid: int, session: AsyncSession = Depends(get_session)
) -> AiConversationDetailDto:
    await require_ai(session)
    c = await _conversation(session, project_id, cid)
    return AiConversationDetailDto(
        **_conversation_dto(c).model_dump(), messages=[message_dto(m) for m in c.messages]
    )


@router.delete("/{project_id}/ai/conversations/{cid}", status_code=204)
async def delete_conversation(
    project_id: int, cid: int, session: AsyncSession = Depends(get_session)
) -> None:
    c = await _conversation(session, project_id, cid)
    await session.delete(c)
    await session.commit()


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/{project_id}/ai/conversations/{cid}/messages")
async def ask(
    project_id: int, cid: int, dto: AskDto, session: AsyncSession = Depends(get_session)
) -> StreamingResponse:
    await require_ai(session)
    project = await _project(session, project_id)
    conversation = await _conversation(session, project_id, cid)
    history = chat_history(conversation)

    try:
        manifest = await asyncio.to_thread(load_manifest_dict, Path(project.path))
    except DocumentationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    messages = await _build_messages(session, project, manifest, dto, history)

    session.add(AiMessage(
        conversation_id=cid, role="user", content=dto.content, unique_id=dto.unique_id
    ))
    if not conversation.title:
        conversation.title = dto.content[:TITLE_CHARS]
    conversation.updated_at = datetime.now(UTC)
    await session.commit()
    config = await load_ai_config(session)

    return StreamingResponse(
        _answer(cid, messages, config, dto.unique_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _build_messages(
    session: AsyncSession, project: Project, manifest: dict, dto: AskDto, history: list[dict]
) -> list[dict]:
    if dto.unique_id is None:
        if dto.mode == "explain_failure":
            raise HTTPException(status_code=422, detail="select a model or test to explain")
        return pro.ask_messages(manifest, None, history, dto.content)
    run_info = await node_run_info(session, project.id, manifest, dto.unique_id)
    if dto.mode == "ask":
        return pro.ask_messages(manifest, dto.unique_id, history, dto.content, run_info)
    env = await load_project_env(project.id)
    rows = await failing_rows(project.id, Path(project.path), env, run_info)
    return pro.explain_failure_messages(
        manifest, dto.unique_id, {**run_info, "failing_rows": rows}, history, dto.content
    )


async def _answer(cid: int, messages: list[dict], config, unique_id: str | None) -> AsyncIterator[str]:
    parts: list[str] = []
    error: str | None = None
    try:
        provider = await resolve_provider(config)
        async for text in stream_chat(provider, messages, max_tokens=MAX_REPLY_TOKENS):
            parts.append(text)
            llama_server.touch()
            yield _sse("delta", {"text": text})
    except (RuntimeUnavailable, LlmError) as exc:
        error = str(exc)
        log.warning("ai_ask_failed", conversation_id=cid, error=error)
    finally:
        # Saved even when the client stops reading mid-answer, so history matches what was shown.
        message_id = await _save_reply(cid, "".join(parts), unique_id)
    if error is not None:
        yield _sse("error", {"message": error})
    else:
        yield _sse("done", {"message_id": message_id})


async def _save_reply(cid: int, content: str, unique_id: str | None) -> int | None:
    if not content.strip():
        return None
    from app.db import engine as db_engine  # patched in tests, like other background writers

    async with db_engine.SessionLocal() as session:
        message = AiMessage(
            conversation_id=cid, role="assistant", content=content, unique_id=unique_id
        )
        session.add(message)
        await session.commit()
        return message.id
