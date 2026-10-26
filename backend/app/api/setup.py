"""First-run setup wizard: collect the global settings in one validated step.

The frontend shows the wizard until `setup_completed` is set. Installing dbt
afterwards is left to the normal global setup endpoint, which the wizard
triggers (and streams) as its final step.
"""
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.global_env import GlobalEnvVarDto, replace_global_env_vars
from app.api.settings import (
    SETUP_COMPLETED_KEY,
    SettingsDto,
    _upsert,
    change_python_path,
    get_settings,
)
from app.config import settings
from app.db.engine import get_session
from app.db.models import AppSetting
from app.dbt import venv
from app.dbt.core_version import (
    DBT_CORE_VERSION_KEY,
    VersionLookupError,
    append_pin,
    dbt_core_requirement,
    fetch_dbt_core_versions,
    install_spec,
    is_valid_version,
)
from app.envvars import is_valid_env_key
from app.logging_setup import get_logger
from app.projects.service import rescan_projects

log = get_logger(__name__)

router = APIRouter(prefix="/api/setup", tags=["setup"])



class SetupDto(BaseModel):
    dbt_projects_path: str
    create_projects_dir: bool = False
    # Empty → auto-detect (the same search used before this setting existed).
    python_path: str = ""
    # Empty → global setup installs the latest dbt-core instead of a file.
    global_requirements_path: str = ""
    # Create a missing requirements file (seeded with the chosen dbt-core).
    create_requirements_file: bool = False
    # dbt-core to install, e.g. "1.10.13"; "" = latest. Written into a new
    # requirements file, appended to an existing one that doesn't mention
    # dbt-core, or saved as the dbt_core_version setting when there's no file.
    dbt_core_version: str = ""
    theme: Literal["dark", "light"] = "dark"
    # Global env vars, replacing the current set. None → leave them as they are.
    global_env_vars: list[GlobalEnvVarDto] | None = None


def _field_error(field: str, code: str, message: str) -> HTTPException:
    """400 naming the offending field, so the wizard can show it on that step."""
    return HTTPException(status_code=400, detail={"field": field, "code": code, "message": message})


def _resolve_projects_dir(raw: str, create: bool) -> Path:
    if not raw.strip():
        raise _field_error("dbt_projects_path", "required", "Choose a folder for your dbt projects.")
    path = Path(raw.strip()).expanduser()
    if not path.is_absolute():
        raise _field_error("dbt_projects_path", "invalid", "Use a full path, e.g. ~/dbt-projects.")
    if path.exists() and not path.is_dir():
        raise _field_error("dbt_projects_path", "invalid", f"{path} is a file, not a folder.")
    if not path.exists():
        if not create:
            raise _field_error("dbt_projects_path", "not_found", f"{path} doesn't exist yet.")
        try:
            path.mkdir(parents=True)
        except OSError as exc:
            raise _field_error("dbt_projects_path", "invalid", f"Couldn't create {path}: {exc}")
        log.info("setup_projects_dir_created", path=str(path))
    return path


def _resolve_requirements(raw: str, create: bool) -> tuple[Path | None, bool]:
    """Return (path, needs_creating). Nothing is written here, so a later
    validation failure doesn't leave a stray file behind."""
    if not raw.strip():
        return None, False
    path = Path(raw.strip()).expanduser()
    if not path.is_absolute():
        raise _field_error("global_requirements_path", "invalid", "Use a full path, e.g. ~/dbt-projects/requirements.txt.")
    if path.is_dir():
        raise _field_error("global_requirements_path", "invalid", f"{path} is a folder, not a file.")
    if path.is_file():
        return path, False
    if not create:
        raise _field_error("global_requirements_path", "not_found", f"No file at {path}.")
    return path, True


def _validate_dbt_core_version(raw: str) -> str:
    version = raw.strip()
    if version and not is_valid_version(version):
        raise _field_error("dbt_core_version", "invalid", f"'{version}' isn't a dbt-core release number.")
    return version


def _create_requirements_file(path: Path, dbt_core_version: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{install_spec(dbt_core_version)}\n")
    except OSError as exc:
        raise _field_error("global_requirements_path", "invalid", f"Couldn't create {path}: {exc}")
    log.info("setup_requirements_file_created", path=str(path), dbt_core=dbt_core_version or "latest")


def _pin_dbt_core_if_missing(path: Path, dbt_core_version: str) -> None:
    """Add the chosen dbt-core to an existing file that doesn't list it; leave
    any dbt-core the user already has alone."""
    if not dbt_core_version:
        return
    try:
        text = path.read_text(encoding="utf-8")
        if dbt_core_requirement(text) is not None:
            return
        path.write_text(append_pin(text, dbt_core_version), encoding="utf-8")
    except OSError as exc:
        raise _field_error("global_requirements_path", "invalid", f"Couldn't update {path}: {exc}")
    log.info("setup_requirements_pinned", path=str(path), dbt_core=dbt_core_version)


def _normalize_env_vars(env_vars: list[GlobalEnvVarDto]) -> list[GlobalEnvVarDto]:
    """Trim keys, drop fully blank rows, and reject bad or duplicate names."""
    rows = [
        GlobalEnvVarDto(key=v.key.strip(), value=v.value)
        for v in env_vars
        if v.key.strip() or v.value
    ]
    seen: set[str] = set()
    for row in rows:
        if not is_valid_env_key(row.key):
            name = f"'{row.key}'" if row.key else "A variable with a value but no name"
            raise _field_error(
                "global_env_vars", "invalid",
                f"{name} isn't a valid variable name (letters, digits and _; can't start with a digit).",
            )
        if row.key in seen:
            raise _field_error("global_env_vars", "invalid", f"{row.key} is listed more than once.")
        seen.add(row.key)
    return rows


async def _delete_setting(session: AsyncSession, key: str) -> None:
    row = await session.get(AppSetting, key)
    if row is not None:
        await session.delete(row)


@router.post("/complete", response_model=SettingsDto)
async def complete_setup(dto: SetupDto, session: AsyncSession = Depends(get_session)) -> SettingsDto:
    """Validate and save every wizard setting, then mark setup complete.

    Paths are checked before anything is written; the Python switch (which may
    rebuild the dbt venv) runs last among the checks, and nothing is committed
    unless every step succeeds.
    """
    projects_dir = _resolve_projects_dir(dto.dbt_projects_path, dto.create_projects_dir)
    requirements, create_requirements = _resolve_requirements(
        dto.global_requirements_path, dto.create_requirements_file
    )
    dbt_core_version = _validate_dbt_core_version(dto.dbt_core_version)
    env_vars = _normalize_env_vars(dto.global_env_vars) if dto.global_env_vars is not None else None

    if not venv.is_own_venv():
        try:
            await change_python_path(session, dto.python_path)
        except HTTPException as exc:
            raise _field_error("python_path", "invalid", str(exc.detail)) from exc

    if requirements is not None and create_requirements:
        _create_requirements_file(requirements, dbt_core_version)
    elif requirements is not None:
        _pin_dbt_core_if_missing(requirements, dbt_core_version)

    await _upsert(session, "dbt_projects_path", str(projects_dir))
    if requirements is None:
        await _delete_setting(session, "global_requirements_path")
        # No file: global setup installs this version (missing = latest)
        if dbt_core_version:
            await _upsert(session, DBT_CORE_VERSION_KEY, dbt_core_version)
        else:
            await _delete_setting(session, DBT_CORE_VERSION_KEY)
    else:
        await _upsert(session, "global_requirements_path", str(requirements))
        # The file decides what's installed; a leftover version would only mislead
        await _delete_setting(session, DBT_CORE_VERSION_KEY)
    await _upsert(session, "theme", dto.theme)
    if env_vars is not None:
        await replace_global_env_vars(session, env_vars)
    await _upsert(session, SETUP_COMPLETED_KEY, "true")
    await session.commit()
    log.info("setup_completed", projects_dir=str(projects_dir), requirements=str(requirements))

    await rescan_projects(session)
    return await get_settings(session)


class DbtCoreVersionsDto(BaseModel):
    versions: list[str]  # newest first
    latest: str


@router.get("/dbt-core-versions", response_model=DbtCoreVersionsDto)
async def dbt_core_versions() -> DbtCoreVersionsDto:
    """Stable dbt-core releases from PyPI for the wizard's version picker (502 if unreachable)."""
    try:
        versions = await fetch_dbt_core_versions()
    except VersionLookupError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return DbtCoreVersionsDto(versions=versions, latest=versions[0])


class RequirementsFileDto(BaseModel):
    exists: bool
    # The line requiring dbt-core (e.g. "dbt-core>=1.8"); null if the file doesn't mention it
    dbt_core_line: str | None


@router.get("/requirements-file", response_model=RequirementsFileDto)
async def requirements_file(path: str) -> RequirementsFileDto:
    """Whether a requirements file exists and already pins dbt-core, so the wizard
    knows whether to offer the version picker. Read-only."""
    target = Path(path.strip()).expanduser()
    if not path.strip() or not target.is_absolute() or not target.is_file():
        return RequirementsFileDto(exists=False, dbt_core_line=None)
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return RequirementsFileDto(exists=True, dbt_core_line=None)
    return RequirementsFileDto(exists=True, dbt_core_line=dbt_core_requirement(text))


async def seed_setup_completed(session: AsyncSession) -> None:
    """Skip the wizard for installs that predate it: if a projects folder is
    already configured (DB or env), mark setup complete. Runs at startup."""
    if await session.get(AppSetting, SETUP_COMPLETED_KEY) is not None:
        return
    row = await session.get(AppSetting, "dbt_projects_path")
    already_configured = (row is not None and bool(row.value)) or settings.dbt_projects_path is not None
    if already_configured:
        session.add(AppSetting(key=SETUP_COMPLETED_KEY, value="true"))
        await session.commit()
        log.info("setup_completed_seeded")
