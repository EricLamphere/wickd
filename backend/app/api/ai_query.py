"""Query data (wickd Pro): the model writes one read-only SELECT, the user runs it, then
(optionally) the model answers from the results. Two fixed steps — never a loop.

1. POST .../conversations/{cid}/query — the question + a `query` message holding the SQL
   (status `proposed`, or `invalid` when it fails app/ai/sql_guard.py; editable either way).
2. POST .../messages/{mid}/run — the user's (possibly edited) SQL is re-validated, then run
   with `dbt show --inline` behind the project's dbt lock: `waiting` while another dbt
   command holds it, `running`, then `done` / `error`. Each change → `ai_query_updated`.
3. POST .../messages/{mid}/answer — streams an answer from the result rows (they're sent
   to the model, which matters when a remote endpoint is configured).
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import StreamingResponse

from app.ai import pro
from app.ai.client import LlmError, stream_chat
from app.ai.config import load_ai_config
from app.ai.documentation import DocumentationError, load_manifest_dict
from app.ai.gating import require_ai
from app.ai.provider import resolve_provider
from app.ai.runtime import RuntimeUnavailable, llama_server
from app.ai.sql_guard import QueryRejected, dialect_for, for_dbt_show, validate_select
from app.api.ai_chat import Question, _answer, _conversation, _project, chat_history
from app.api.ai_dtos import AiMessageDto, message_dto
from app.api.init import load_project_env
from app.db.engine import get_session
from app.db.models import AiMessage
from app.dbt.runner import RunRequest, runner
from app.dbt.show_parser import parse_show_json
from app.events.bus import Event, bus
from app.logging_setup import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["ai"])

ROW_LIMIT = 100
QUERY_TIMEOUT_S = 120
LOCK_WAIT_S = 10 * 60
LOCK_POLL_S = 0.5
TITLE_CHARS = 80
SQL = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20_000)]


class QueryQuestionDto(BaseModel):
    content: Question
    unique_id: str | None = Field(default=None, max_length=512)


class RunQueryDto(BaseModel):
    sql: SQL


def _payload(message: AiMessage) -> dict:
    try:
        return json.loads(message.payload_json or "{}")
    except ValueError:
        return {}


def _dialect(project_path: Path) -> str | None:
    try:
        manifest = load_manifest_dict(project_path)
    except DocumentationError:
        return None
    return dialect_for((manifest.get("metadata") or {}).get("adapter_type"))


async def _query_message(session: AsyncSession, project_id: int, mid: int) -> AiMessage:
    message = await session.get(AiMessage, mid)
    if message is None or message.role != "query":
        raise HTTPException(status_code=404, detail="query not found")
    await _conversation(session, project_id, message.conversation_id)  # scopes it to the project
    return message


async def _publish(project_id: int, message_id: int, status: str) -> None:
    await bus.publish(Event(
        topic=f"project:{project_id}",
        type="ai_query_updated",
        data={"message_id": message_id, "status": status},
    ))


# ── 1. write the SQL ─────────────────────────────────────────────────────────


async def _write_sql(config, messages: list[dict], schema: dict, max_tokens: int | None) -> str:
    provider = await resolve_provider(config)
    parts: list[str] = []
    async for delta in stream_chat(provider, messages, max_tokens=max_tokens, schema=schema):
        parts.append(delta)
        llama_server.touch()
    return "".join(parts)


@router.post("/{project_id}/ai/conversations/{cid}/query", response_model=list[AiMessageDto])
async def write_query(
    project_id: int, cid: int, dto: QueryQuestionDto, session: AsyncSession = Depends(get_session)
) -> list[AiMessageDto]:
    await require_ai(session)
    project = await _project(session, project_id)
    conversation = await _conversation(session, project_id, cid)
    try:
        manifest = await asyncio.to_thread(load_manifest_dict, Path(project.path))
    except DocumentationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    prompt = pro.query_prompt(manifest, dto.unique_id, chat_history(conversation), dto.content)
    config = await load_ai_config(session)
    try:
        raw = await _write_sql(config, prompt["messages"], prompt["schema"], prompt.get("max_tokens"))
        written = pro.parse_query(raw)
    except (RuntimeUnavailable, LlmError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"the model didn't return a usable query: {exc}") from exc

    payload = {"question": dto.content, **written, "status": "proposed", "error": None}
    try:
        adapter = (manifest.get("metadata") or {}).get("adapter_type")
        payload["sql"] = validate_select(written["sql"], dialect_for(adapter))
    except QueryRejected as exc:
        payload.update(status="invalid", error=str(exc))

    question = AiMessage(conversation_id=cid, role="user", content=dto.content, unique_id=dto.unique_id)
    query = AiMessage(
        conversation_id=cid,
        role="query",
        content=written["explanation"],
        unique_id=dto.unique_id,
        payload_json=json.dumps(payload),
    )
    session.add_all([question, query])
    if not conversation.title:
        conversation.title = dto.content[:TITLE_CHARS]
    conversation.updated_at = datetime.now(UTC)
    await session.commit()
    return [message_dto(question), message_dto(query)]


# ── 2. run it ────────────────────────────────────────────────────────────────


@router.post("/{project_id}/ai/messages/{mid}/run", response_model=AiMessageDto, status_code=202)
async def run_query(
    project_id: int, mid: int, dto: RunQueryDto, session: AsyncSession = Depends(get_session)
) -> AiMessageDto:
    await require_ai(session)
    project = await _project(session, project_id)
    message = await _query_message(session, project_id, mid)
    payload = _payload(message)
    if payload.get("status") in ("waiting", "running"):
        raise HTTPException(status_code=409, detail="this query is already running")
    dialect = await asyncio.to_thread(_dialect, Path(project.path))
    try:
        sql = validate_select(dto.sql, dialect)
        runnable = for_dbt_show(sql, dialect)
    except QueryRejected as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    status = "waiting" if runner.is_project_busy(project_id) else "running"
    payload.update(sql=sql, status=status, error=None, columns=None, rows=None, truncated=False)
    message.payload_json = json.dumps(payload)
    await session.commit()
    asyncio.create_task(_execute(project_id, Path(project.path), mid, runnable))
    await _publish(project_id, mid, status)
    return message_dto(message)


async def _update(project_id: int, mid: int, **changes) -> None:
    from app.db import engine as db_engine  # patched in tests, like other background writers

    async with db_engine.SessionLocal() as session:
        message = await session.get(AiMessage, mid)
        if message is None:
            return
        message.payload_json = json.dumps({**_payload(message), **changes})
        await session.commit()
    await _publish(project_id, mid, changes.get("status", ""))


async def _wait_for_lock(project_id: int) -> bool:
    """Wait (bounded) for another dbt command on this project to finish."""
    waited = 0.0
    while runner.is_project_busy(project_id):
        if waited >= LOCK_WAIT_S:
            return False
        await asyncio.sleep(LOCK_POLL_S)
        waited += LOCK_POLL_S
    return True


async def _execute(project_id: int, project_path: Path, mid: int, sql: str) -> None:
    try:
        if runner.is_project_busy(project_id):
            if not await _wait_for_lock(project_id):
                await _update(project_id, mid, status="error", error="dbt stayed busy — try again later")
                return
            await _update(project_id, mid, status="running")
        env = await load_project_env(project_id)
        target = env.get("DBT_TARGET")
        req = RunRequest(
            project_id=project_id,
            project_path=project_path,
            command="show",
            extra=("--inline", sql, "--limit", str(ROW_LIMIT + 1), "--output", "json")
            + (("--target", target) if target else ()),
            env=env,
        )
        async with asyncio.timeout(QUERY_TIMEOUT_S):
            code, stdout, stderr = await runner.run(req)
    except TimeoutError:
        await _update(project_id, mid, status="error", error=f"the query took longer than {QUERY_TIMEOUT_S}s")
        return
    except Exception as exc:  # never leave the query stuck in running
        log.exception("ai_query_crashed", message_id=mid)
        await _update(project_id, mid, status="error", error=f"unexpected error: {exc}")
        return

    out = stdout.decode(errors="replace")
    columns, rows = parse_show_json(out)
    if code != 0 or not columns:
        # dbt prints errors to stdout; keep the end, where the actual error is
        detail = (stderr.decode(errors="replace").strip() or out)[-1500:].strip()
        await _update(project_id, mid, status="error", error=detail or "dbt show failed")
        return
    await _update(
        project_id, mid,
        status="done", columns=columns, rows=rows[:ROW_LIMIT], truncated=len(rows) > ROW_LIMIT,
    )


# ── 3. answer from the results ───────────────────────────────────────────────


@router.post("/{project_id}/ai/messages/{mid}/answer")
async def answer_from_results(
    project_id: int, mid: int, session: AsyncSession = Depends(get_session)
) -> StreamingResponse:
    await require_ai(session)
    message = await _query_message(session, project_id, mid)
    payload = _payload(message)
    if payload.get("status") != "done":
        raise HTTPException(status_code=409, detail="run the query first")
    messages = pro.answer_messages(
        payload.get("question") or "",
        payload["sql"],
        payload.get("columns") or [],
        payload.get("rows") or [],
        bool(payload.get("truncated")),
    )
    config = await load_ai_config(session)
    return StreamingResponse(
        _answer(message.conversation_id, messages, config, message.unique_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

