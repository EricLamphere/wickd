from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import pro
from app.licensing import entitlements


async def require_ai(session: AsyncSession) -> None:
    """403 without a Pro entitlement; 503 when this build lacks the Pro package."""
    entitlement = await entitlements.check_entitlement(session)
    if not entitlement.entitled:
        raise HTTPException(
            status_code=403,
            detail={"error": "pro_feature_required", "reason": entitlement.reason},
        )
    if not pro.is_available():
        raise HTTPException(
            status_code=503,
            detail="AI features require the wickd Pro package, which isn't installed in this build.",
        )
