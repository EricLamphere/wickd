from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import pro
from app.licensing.gating import require_pro
from app.refactor import pro as refactor_pro

REFACTOR_KIND = "refactor"
# semantic_status() reason codes that mean MetricFlow can't run here at all
BLOCKING_SEMANTIC_REASONS = frozenset({"off", "too_old", "latest_spec_needs_1_12", "no_cli_release", "unknown_version"})
# proposals made by Base features (no AI, no Pro engine): reviewing them is free
BASE_KINDS = frozenset({"document_stub"})


async def require_ai(session: AsyncSession) -> None:
    """403 without a Pro entitlement; 503 when this build lacks the Pro package."""
    await require_pro(
        session,
        available=pro.is_available,
        unavailable_detail="AI features require the wickd Pro package, which isn't installed in this build.",
    )


async def require_refactor(session: AsyncSession) -> None:
    """Refactors are Pro but don't need the local model (direct menus work without AI)."""
    await require_pro(session, available=refactor_pro.is_available, unavailable_detail=refactor_pro.UNAVAILABLE)


async def require_proposal_access(session: AsyncSession, kind: str) -> None:
    """Reviewing a proposal needs what made it: nothing for Base kinds, the refactor
    engine, or the AI features."""
    if kind in BASE_KINDS:
        return
    if kind == REFACTOR_KIND:
        await require_refactor(session)
    else:
        await require_ai(session)


async def require_semantic_draft(session: AsyncSession, project_id: int) -> None:
    """Pro + the semantic drafting package, and MetricFlow able to query this project
    (409 {error, message, status} otherwise, so the UI can open the compat dialog)."""
    from app.db.models import Project
    from app.semantic import pro as semantic_pro
    from app.semantic.status import semantic_status

    await require_ai(session)
    await require_pro(session, available=semantic_pro.is_available, unavailable_detail=semantic_pro.UNAVAILABLE)
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    status = await semantic_status(session, project)
    # No semantic YAML yet is exactly when a draft helps; an adapter MetricFlow can't
    # render SQL for still validates (without smoke queries). Off / incompatible can't run.
    if status.mode == "off" or (status.reason_code or "") in BLOCKING_SEMANTIC_REASONS:
        raise HTTPException(status_code=409, detail={
            "error": status.reason_code or "unavailable",
            "message": status.reason or "MetricFlow isn't available",
            "status": status.to_dict(),
        })
