"""Home page Wicky (wickd Pro): read-only questions across projects.

Answers come from each project's search index (names, descriptions, columns, lineage), so
asking never runs dbt or touches a warehouse. Scope is the combined docs selection, else
every active project. Replies stream on the POST, like project chats (api/ai_chat.py).
"""

import asyncio
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, StringConstraints
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from starlette.responses import StreamingResponse

from app.ai import pro
from app.ai.config import load_ai_config
from app.ai.gating import require_ai
from app.api.ai_chat import TITLE_CHARS, stream_reply
from app.api.ai_dtos import iso
from app.api.workspace_docs import scope_projects
from app.db.engine import get_session
from app.db.models import Project, WorkspaceConversation, WorkspaceMessage
from app.projects.search import manifest_index

router = APIRouter(prefix="/api/workspace/ai", tags=["workspace-ai"])

Question = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]


class WorkspaceConversationDto(BaseModel):
    id: int
    title: str
    updated_at: str


class WorkspaceMessageDto(BaseModel):
    id: int
    role: str
    content: str


class WorkspaceConversationDetailDto(WorkspaceConversationDto):
    messages: list[WorkspaceMessageDto]


class WorkspaceAskDto(BaseModel):
    content: Question


def _conversation_dto(c: WorkspaceConversation) -> WorkspaceConversationDto:
    return WorkspaceConversationDto(id=c.id, title=c.title, updated_at=iso(c.updated_at))


async def _conversation(session: AsyncSession, cid: int) -> WorkspaceConversation:
    result = await session.execute(
        select(WorkspaceConversation)
        .where(WorkspaceConversation.id == cid)
        .options(selectinload(WorkspaceConversation.messages))
    )
    conversation = result.scalar_one_or_none()
    if conversation is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return conversation


@router.get("/conversations", response_model=list[WorkspaceConversationDto])
async def list_conversations(session: AsyncSession = Depends(get_session)) -> list[WorkspaceConversationDto]:
    await require_ai(session)
    result = await session.execute(
        select(WorkspaceConversation)
        .order_by(WorkspaceConversation.updated_at.desc(), WorkspaceConversation.id.desc())
    )
    return [_conversation_dto(c) for c in result.scalars().all()]


@router.post("/conversations", response_model=WorkspaceConversationDetailDto, status_code=201)
async def create_conversation(session: AsyncSession = Depends(get_session)) -> WorkspaceConversationDetailDto:
    await require_ai(session)
    conversation = WorkspaceConversation(title="")
    session.add(conversation)
    await session.commit()
    await session.refresh(conversation)
    return WorkspaceConversationDetailDto(**_conversation_dto(conversation).model_dump(), messages=[])


@router.get("/conversations/{cid}", response_model=WorkspaceConversationDetailDto)
async def get_conversation(cid: int, session: AsyncSession = Depends(get_session)) -> WorkspaceConversationDetailDto:
    await require_ai(session)
    c = await _conversation(session, cid)
    return WorkspaceConversationDetailDto(
        **_conversation_dto(c).model_dump(),
        messages=[WorkspaceMessageDto(id=m.id, role=m.role, content=m.content) for m in c.messages],
    )


@router.delete("/conversations/{cid}", status_code=204)
async def delete_conversation(cid: int, session: AsyncSession = Depends(get_session)) -> None:
    await require_ai(session)
    await session.delete(await _conversation(session, cid))
    await session.commit()


async def _index_projects(projects: list[Project]) -> tuple[list[dict], list[str]]:
    """Plain dicts for wickd_pro, and the names of projects without a manifest."""
    indexes = await asyncio.gather(
        *(asyncio.to_thread(manifest_index, Path(p.path)) for p in projects)
    )
    indexed = [
        {"name": project.name, "nodes": [{**asdict(n), "columns": list(n.columns), "depends_on": list(n.depends_on)} for n in index]}
        for project, index in zip(projects, indexes)
        if index is not None
    ]
    not_compiled = [project.name for project, index in zip(projects, indexes) if index is None]
    return indexed, not_compiled


async def _save_reply(cid: int, content: str) -> int | None:
    if not content.strip():
        return None
    from app.db import engine as db_engine  # patched in tests, like other background writers

    async with db_engine.SessionLocal() as session:
        message = WorkspaceMessage(conversation_id=cid, role="assistant", content=content)
        session.add(message)
        await session.commit()
        return message.id


@router.post("/conversations/{cid}/messages")
async def ask(cid: int, dto: WorkspaceAskDto, session: AsyncSession = Depends(get_session)) -> StreamingResponse:
    await require_ai(session)
    conversation = await _conversation(session, cid)
    if not pro.supports_workspace_ask():
        raise HTTPException(
            status_code=503,
            detail="Asking across projects needs a newer wickd Pro package. Update wickd to use it.",
        )
    indexed, not_compiled = await _index_projects(await scope_projects(session))
    if not indexed:
        raise HTTPException(
            status_code=422,
            detail="None of these projects have been compiled yet. Open one and run dbt compile first.",
        )
    history = [{"role": m.role, "content": m.content} for m in conversation.messages]
    messages = pro.workspace_ask_messages(indexed, not_compiled, history, dto.content)

    session.add(WorkspaceMessage(conversation_id=cid, role="user", content=dto.content))
    if not conversation.title:
        conversation.title = dto.content[:TITLE_CHARS]
    conversation.updated_at = datetime.now(UTC)
    await session.commit()
    config = await load_ai_config(session)

    return StreamingResponse(
        stream_reply(messages, config, lambda content: _save_reply(cid, content), cid),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
