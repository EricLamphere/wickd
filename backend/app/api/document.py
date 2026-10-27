"""Documentation generator: add stub `- name:` entries for a node and its columns
to the schema YAML next to it (creating the file/entry if needed).

POST .../document/propose builds the change as a proposal of kind `document_stub`
for the review window (side pane "Generate docs YAML", Schema Drift's "Document N
warehouse-only columns"); nothing is written until it's accepted, which compiles the
node. It's a Base feature: reviewing it needs no Pro license.
"""

import asyncio
import json
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.ai_dtos import AiProposalDto, proposal_dto
from app.api.ai_proposals import _publish
from app.api.init import load_project_env
from app.db.engine import get_session
from app.db.models import AiProposal, AiProposalFile, Project
from app.dbt.manifest import load_manifest
from app.dbt.probe import probe_warehouse_columns
from app.dbt.schema_yaml import (
    RESOURCE_KEYS,
    DocumentTarget,
    SchemaYamlError,
    plan_document_node,
)
from app.logging_setup import get_logger

router = APIRouter(prefix="/api/projects", tags=["document"])
log = get_logger(__name__)

MAX_COLUMNS = 2000
ColumnName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]
STUB_KIND = "document_stub"


class DocumentRequestDto(BaseModel):
    # None → read the node's actual columns from the warehouse
    columns: list[ColumnName] | None = Field(default=None, max_length=MAX_COLUMNS)


async def _target(
    session: AsyncSession, project_id: int, unique_id: str, dto: DocumentRequestDto
) -> tuple[Project, DocumentTarget, list[str]]:
    """The project, the node to document and its columns (from the warehouse unless given)."""
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    project_path = Path(project.path)

    manifest = await asyncio.to_thread(load_manifest, project_path / "target" / "manifest.json")
    if manifest is None:
        raise HTTPException(status_code=422, detail="manifest not found — run dbt compile first")
    node = next((n for n in manifest.nodes if n.unique_id == unique_id), None)
    if node is None:
        raise HTTPException(status_code=404, detail="node not found")
    if node.resource_type not in RESOURCE_KEYS or not node.original_file_path:
        raise HTTPException(
            status_code=422, detail=f"documenting a {node.resource_type} is not supported"
        )

    columns = dto.columns
    if columns is None:
        env = await load_project_env(project_id)
        probe = await probe_warehouse_columns(
            project_id, project_path, node.name, env, env.get("DBT_TARGET")
        )
        if probe.error is not None:
            raise HTTPException(
                status_code=422, detail=f"could not read columns from the warehouse: {probe.error}"
            )
        columns = list(probe.columns)

    target = DocumentTarget(
        name=node.name,
        resource_type=node.resource_type,
        original_file_path=node.original_file_path,
        patch_path=node.patch_path,
    )
    return project, target, columns


@router.post("/{project_id}/models/{unique_id:path}/document/propose", response_model=AiProposalDto)
async def propose_document(
    project_id: int,
    unique_id: str,
    dto: DocumentRequestDto,
    session: AsyncSession = Depends(get_session),
) -> AiProposalDto:
    """The stub entries as a proposal to review (status `empty` when nothing is missing)."""
    project, target, columns = await _target(session, project_id, unique_id, dto)
    try:
        plan = await asyncio.to_thread(plan_document_node, Path(project.path), target, columns)
    except SchemaYamlError as exc:
        log.warning("document_failed", project_id=project_id, unique_id=unique_id, error=str(exc))
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    result = plan.result
    summary = {
        "path": result.path, "created_file": result.created_file,
        "added_entry": result.added_entry, "added_columns": list(result.added_columns),
    }
    proposal = AiProposal(
        project_id=project_id, kind=STUB_KIND, unique_id=unique_id,
        title=f"Docs YAML for {target.name}", result_json=json.dumps({"summary": summary}),
        status="ready" if plan.changed else "empty",
        error_message=None if plan.changed else f"{target.name} and all its columns are already in {result.path}.",
    )
    session.add(proposal)
    await session.flush()
    if plan.changed:
        session.add(AiProposalFile(
            proposal_id=proposal.id, path=result.path, op="create" if plan.original is None else "modify",
            original_text=plan.original, proposed_text=plan.text,
        ))
    await session.commit()
    await session.refresh(proposal, attribute_names=["files"])
    await _publish(proposal)
    return proposal_dto(proposal)
