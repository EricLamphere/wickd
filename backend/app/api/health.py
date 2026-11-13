from fastapi import APIRouter

from app.config import settings

router = APIRouter()


@router.get("/api/health")
async def health() -> dict[str, str]:
    # `instance` identifies this backend to the desktop shell that spawned it
    # (WICKD_INSTANCE_TOKEN); empty when run from source.
    return {"status": "ok", "instance": settings.instance_token}
