"""Whether MetricFlow is on for a project: its own `metricflow_mode`, else the global default.

Global `metricflow_mode` (app_settings, WICKD_METRICFLOW_MODE): auto (default) | off.
Project `projects.metricflow_mode`: '' (use the global default) | auto | off. The version
dialog's "Continue without MetricFlow" sets the project to off.
"""

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import AppSetting

GLOBAL_KEY = "metricflow_mode"
MODES = ("auto", "off")
PROJECT_MODES = ("", *MODES)
DEFAULT_MODE = "auto"


@dataclass(frozen=True)
class EffectiveMode:
    mode: str  # auto | off
    source: str  # project | global


def normalize_global(raw: str | None) -> str:
    value = (raw or "").strip().lower()
    return value if value in MODES else DEFAULT_MODE


def resolve(project_mode: str | None, global_mode: str | None) -> EffectiveMode:
    own = (project_mode or "").strip().lower()
    if own in MODES:
        return EffectiveMode(own, "project")
    return EffectiveMode(normalize_global(global_mode), "global")


async def global_mode(session: AsyncSession) -> str:
    row = await session.get(AppSetting, GLOBAL_KEY)
    return normalize_global(row.value if row is not None else settings.metricflow_mode)
