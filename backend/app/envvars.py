"""How the environment for dbt, init scripts and pip is assembled.

Layers, lowest to highest priority:
  1. wickd's own process environment
  2. global (default) env vars — Global Settings → Profiles
  3. the project's active profile
  4. the project's own env vars
"""
import re
from collections.abc import Mapping

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import GlobalEnvVar

_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def is_valid_env_key(key: str) -> bool:
    return bool(_ENV_KEY_RE.match(key))


def layer_env(
    *,
    base: Mapping[str, str],
    global_vars: Mapping[str, str],
    profile_vars: Mapping[str, str],
    project_vars: Mapping[str, str],
) -> dict[str, str]:
    """Merge the layers into a new dict; later layers win."""
    return {**base, **global_vars, **profile_vars, **project_vars}


async def load_global_env_vars(session: AsyncSession) -> dict[str, str]:
    result = await session.execute(select(GlobalEnvVar))
    return {row.key: row.value for row in result.scalars().all()}
