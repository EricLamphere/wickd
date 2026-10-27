from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import pro
from app.licensing.gating import require_pro
from app.refactor import pro as refactor_pro

REFACTOR_KIND = "refactor"
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
