from collections.abc import Callable

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.licensing import entitlements

_DEFAULT_UNAVAILABLE = "This feature requires the wickd Pro package, which isn't installed in this build."


async def require_pro(
    session: AsyncSession,
    *,
    available: Callable[[], bool] | None = None,
    unavailable_detail: str = _DEFAULT_UNAVAILABLE,
) -> None:
    """403 `{"error": "pro_feature_required", "reason": …}` without a Pro entitlement;
    503 when `available()` says this build lacks the Pro code the route needs.

    Gate every route that returns Pro-derived results, not just the one that
    starts the work — stored results otherwise stay readable after a
    subscription lapses.
    """
    entitlement = await entitlements.check_entitlement(session)
    if not entitlement.entitled:
        raise HTTPException(
            status_code=403,
            detail={"error": "pro_feature_required", "reason": entitlement.reason},
        )
    if available is not None and not available():
        raise HTTPException(status_code=503, detail=unavailable_detail)
