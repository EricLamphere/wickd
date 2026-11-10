"""Schedule helpers shared by metric monitors and scheduled runs (not Pro-gated)."""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException

from app.scheduling import cron
from app.scheduling.rules import upcoming

router = APIRouter(prefix="/api", tags=["scheduling"])

MAX_EXPR_LEN = 200


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).isoformat()


def schedule_error(exc: cron.CronError, field: str = "cron") -> HTTPException:
    return HTTPException(400, {"field": field, "code": "invalid_schedule", "message": f"Invalid schedule: {exc}"})


@router.get("/schedule-preview")
async def schedule_preview(expr: str) -> dict:
    """A cron expression checked as you type: {expr (as stored), next: [the next 3 times]}."""
    try:
        normalized = cron.normalize(expr[:MAX_EXPR_LEN])
    except cron.CronError as exc:
        raise schedule_error(exc) from exc
    return {"expr": normalized, "next": [iso(t) for t in upcoming(normalized, datetime.now(UTC))]}
