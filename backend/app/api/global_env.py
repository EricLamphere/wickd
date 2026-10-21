"""Global (default) environment variables — applied to every project and to global setup.

Precedence is defined in app/envvars.py: active profile vars override these,
and project env vars override both.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_session
from app.db.models import GlobalEnvVar
from app.envvars import is_valid_env_key

router = APIRouter(prefix="/api/global-env", tags=["global-env"])


class GlobalEnvVarDto(BaseModel):
    key: str
    value: str


class UpsertGlobalEnvVarDto(BaseModel):
    value: str


async def _find(session: AsyncSession, key: str) -> GlobalEnvVar | None:
    result = await session.execute(select(GlobalEnvVar).where(GlobalEnvVar.key == key))
    return result.scalar_one_or_none()


@router.get("", response_model=list[GlobalEnvVarDto])
async def list_global_env_vars(session: AsyncSession = Depends(get_session)) -> list[GlobalEnvVarDto]:
    result = await session.execute(select(GlobalEnvVar).order_by(GlobalEnvVar.key))
    return [GlobalEnvVarDto(key=r.key, value=r.value) for r in result.scalars().all()]


@router.put("/{key}", response_model=GlobalEnvVarDto)
async def put_global_env_var(
    key: str,
    dto: UpsertGlobalEnvVarDto,
    session: AsyncSession = Depends(get_session),
) -> GlobalEnvVarDto:
    if not is_valid_env_key(key):
        raise HTTPException(
            status_code=422,
            detail=f"'{key}' isn't a valid variable name (letters, digits and _; can't start with a digit)",
        )
    row = await _find(session, key)
    if row is None:
        row = GlobalEnvVar(key=key, value=dto.value)
        session.add(row)
    else:
        row.value = dto.value
    await session.commit()
    return GlobalEnvVarDto(key=row.key, value=row.value)


@router.delete("/{key}", status_code=204)
async def delete_global_env_var(key: str, session: AsyncSession = Depends(get_session)) -> None:
    row = await _find(session, key)
    if row is not None:
        await session.delete(row)
        await session.commit()


async def replace_global_env_vars(session: AsyncSession, env_vars: list[GlobalEnvVarDto]) -> None:
    """Swap the whole set (used by the setup wizard). Caller validates and commits."""
    existing = await session.execute(select(GlobalEnvVar))
    for row in existing.scalars().all():
        await session.delete(row)
    await session.flush()
    session.add_all(GlobalEnvVar(key=v.key, value=v.value) for v in env_vars)
