"""Response models shared by the AI chat and proposal routes."""

import json
from datetime import UTC, datetime

from pydantic import BaseModel

from app.db.models import AiMessage, AiProposal


def iso(dt: datetime | None) -> str:
    if dt is None:
        return ""
    return (dt if dt.tzinfo else dt.replace(tzinfo=UTC)).isoformat()


class AiProposalFileDto(BaseModel):
    id: int
    path: str
    original_text: str | None
    proposed_text: str
    status: str  # pending | accepted | rejected | undone
    op: str = "modify"  # modify | create | delete | rename
    new_path: str | None = None  # rename target


class AiProposalResultDto(BaseModel):
    # document
    description: str | None = None
    columns: dict[str, str] = {}
    # tests: [{key, column, test, reason, values?, to?, field?, failures}]
    tests: list[dict] = []
    # propagate (lineage propagation, several files): [{key, field: description | tags,
    # unique_id, column, file, name, value? (description), source?, kind?, path?,
    # tags?, via_kind?}], plus conflicts / nodes skipped because their YAML couldn't be edited
    items: list[dict] = []
    conflicts: list[dict] = []
    skipped: list[dict] = []
    # item keys included in the proposed file (tests: "t0"…, document: "description" /
    # "col:<name>"); None = all of them
    selected: list[str] | None = None
    # items the user has already accepted in review (they stay until the file is applied)
    accepted: list[str] = []
    # refactor: what the engine did ({op, unique_id, old?, new, downstream?, files, …}), edits it
    # left for the user ([{path, line, text, reason}]), notes, and the `dbt parse` run after
    # applying ({status: running | ok | error, output?})
    summary: dict = {}
    manual: list[dict] = []
    notes: list[str] = []
    verify: dict | None = None


class AiProposalDto(BaseModel):
    id: int
    kind: str
    unique_id: str | None
    title: str
    status: str
    error_message: str | None
    created_at: str
    result: AiProposalResultDto
    files: list[AiProposalFileDto]


class AiMessageDto(BaseModel):
    id: int
    role: str  # user | assistant | action | query | refactor
    content: str
    unique_id: str | None
    created_at: str
    proposal: AiProposalDto | None = None  # set for role "action"
    # role "query": {question, sql, explanation, status, error?, columns?, rows?, truncated?}
    # role "refactor": {request, operation | None, description, reason?, status:
    #   proposed | none | confirmed | cancelled, proposal_id?}
    payload: dict | None = None


def _result(raw: str | None) -> AiProposalResultDto:
    try:
        return AiProposalResultDto(**json.loads(raw or "{}"))
    except (ValueError, TypeError):
        return AiProposalResultDto()


def proposal_dto(p: AiProposal) -> AiProposalDto:
    return AiProposalDto(
        id=p.id,
        kind=p.kind,
        unique_id=p.unique_id,
        title=p.title,
        status=p.status,
        error_message=p.error_message,
        created_at=iso(p.created_at),
        result=_result(p.result_json),
        files=[
            AiProposalFileDto(
                id=f.id,
                path=f.path,
                original_text=f.original_text,
                proposed_text=f.proposed_text,
                status=f.status,
                op=f.op or "modify",
                new_path=f.new_path,
            )
            for f in p.files
        ],
    )


def message_dto(m: AiMessage) -> AiMessageDto:
    return AiMessageDto(
        id=m.id,
        role=m.role,
        content=m.content,
        unique_id=m.unique_id,
        created_at=iso(m.created_at),
        proposal=proposal_dto(m.proposal) if m.proposal is not None else None,
        payload=_payload(m.payload_json),
    )


def _payload(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None
