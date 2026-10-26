from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import pro
from app.licensing.gating import require_pro


async def require_ai(session: AsyncSession) -> None:
    """403 without a Pro entitlement; 503 when this build lacks the Pro package."""
    await require_pro(
        session,
        available=pro.is_available,
        unavailable_detail="AI features require the wickd Pro package, which isn't installed in this build.",
    )
