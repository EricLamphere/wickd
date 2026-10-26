import asyncio
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.catalog import DEFAULT_MODEL_ID, find_model
from app.ai.config import AI_ENDPOINT_MODEL_KEY, AI_ENDPOINT_URL_KEY, AI_MODEL_KEY
from app.api.init import _get_global_requirements_path, global_setup_running, init_pipeline_running
from app.config import settings
from app.db.engine import get_session
from app.db.models import AppSetting
from app.dbt import venv
from app.dbt.core_version import DBT_CORE_VERSION_KEY, is_valid_version
from app.dbt.python_env import PYTHON_PATH_KEY
from app.dbt.runner import runner
from app.logging_setup import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/api/settings", tags=["settings"])

# "true" once the first-run setup wizard has been completed (see api/setup.py).
SETUP_COMPLETED_KEY = "setup_completed"


class SettingsUpdateDto(BaseModel):
    dbt_projects_path: str | None = None
    log_level: str | None = None
    global_requirements_path: str | None = None
    theme: str | None = None
    python_path: str | None = None
    ai_model: str | None = None
    ai_endpoint_url: str | None = None
    ai_endpoint_model: str | None = None
    # "" clears it (global setup installs the latest dbt-core)
    dbt_core_version: str | None = None


class SettingsDto(BaseModel):
    dbt_projects_path: str | None
    log_level: str | None
    global_requirements_path: str | None
    theme: str | None
    python_path: str | None
    # False only when WICKD_DBT_VENV_DIR points at the venv the backend itself
    # runs from — rebuilding that would take the server down with it.
    python_path_editable: bool
    # Local AI (wickd Pro): bundled model id, or an OpenAI-compatible endpoint that replaces it
    ai_model: str
    ai_endpoint_url: str | None
    ai_endpoint_model: str | None
    # dbt-core global setup installs when no global requirements file is set; null = latest
    dbt_core_version: str | None
    configured: bool
    setup_completed: bool


async def _get_override(session: AsyncSession, key: str) -> str | None:
    row = await session.get(AppSetting, key)
    return row.value if row is not None else None


async def _delete_setting(session: AsyncSession, key: str) -> None:
    row = await session.get(AppSetting, key)
    if row is not None:
        await session.delete(row)


async def _upsert(session: AsyncSession, key: str, value: str) -> None:
    row = await session.get(AppSetting, key)
    if row is None:
        session.add(AppSetting(key=key, value=value))
    else:
        row.value = value


@router.get("", response_model=SettingsDto)
async def get_settings(session: AsyncSession = Depends(get_session)) -> SettingsDto:
    projects_path_override = await _get_override(session, "dbt_projects_path")
    if projects_path_override is not None:
        dbt_projects_path = projects_path_override
        configured = True
    elif settings.dbt_projects_path is not None:
        dbt_projects_path = str(settings.dbt_projects_path)
        configured = True
    else:
        dbt_projects_path = None
        configured = False

    log_level_override = await _get_override(session, "log_level")
    log_level = log_level_override if log_level_override is not None else settings.log_level

    global_requirements_path = await _get_override(session, "global_requirements_path")
    theme = await _get_override(session, "theme")
    python_path = await _get_override(session, PYTHON_PATH_KEY)
    setup_completed = await _get_override(session, SETUP_COMPLETED_KEY) == "true"
    ai_model = await _get_override(session, AI_MODEL_KEY)

    return SettingsDto(
        dbt_projects_path=dbt_projects_path,
        configured=configured,
        log_level=log_level,
        global_requirements_path=global_requirements_path,
        theme=theme,
        python_path=python_path or None,
        python_path_editable=not venv.is_own_venv(),
        ai_model=ai_model if find_model(ai_model) else DEFAULT_MODEL_ID,
        ai_endpoint_url=await _get_override(session, AI_ENDPOINT_URL_KEY) or None,
        ai_endpoint_model=await _get_override(session, AI_ENDPOINT_MODEL_KEY) or None,
        dbt_core_version=await _get_override(session, DBT_CORE_VERSION_KEY) or None,
        setup_completed=setup_completed,
    )


def _python_env_busy_reason() -> str | None:
    """Why the dbt venv can't be rebuilt right now, if anything is using it."""
    if runner.is_busy():
        return "a dbt command is running"
    if global_setup_running():
        return "global setup is running"
    if init_pipeline_running():
        return "a project init pipeline is running"
    return None


async def change_python_path(session: AsyncSession, raw: str) -> None:
    """Validate the interpreter, rebuild the dbt venv from it, then save.

    Empty input re-runs auto-detection. The setting is only saved once the new
    venv exists, so a failed rebuild leaves the previous value in place.
    """
    if venv.is_own_venv():
        raise HTTPException(
            status_code=400,
            detail="WICKD_DBT_VENV_DIR points at the venv wickd itself runs from, "
            "which can't be rebuilt — point it at a separate directory to switch Python.",
        )
    loop = asyncio.get_running_loop()
    try:
        if raw.strip():
            python = venv.validate_python(raw)
        else:
            python = await loop.run_in_executor(None, venv.find_system_python)
    except (venv.InvalidPythonError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    venv_exists = (settings.dbt_venv_dir / "bin" / "python3").exists()
    if not (venv_exists and venv.same_interpreter(venv.venv_built_from(), python)):
        busy = _python_env_busy_reason()
        if busy:
            raise HTTPException(
                status_code=409,
                detail=f"Can't switch Python while {busy} — try again once it finishes.",
            )
        try:
            await loop.run_in_executor(None, venv.rebuild_venv, python)
        except RuntimeError as exc:
            log.error("python_path_rebuild_failed", python=python, error=str(exc))
            raise HTTPException(status_code=500, detail=str(exc))
        log.info("python_path_changed", python=python)

    await _upsert(session, PYTHON_PATH_KEY, python)
    venv.set_configured_python(python)


@router.put("", response_model=SettingsDto)
async def put_settings(
    dto: SettingsUpdateDto,
    session: AsyncSession = Depends(get_session),
) -> SettingsDto:
    # The requirements file in effect after this update: it decides dbt-core when set
    requirements_after = (
        dto.global_requirements_path.strip() if dto.global_requirements_path is not None
        else await _get_global_requirements_path(session) or ""
    )
    if dto.dbt_projects_path is not None:
        await _upsert(session, "dbt_projects_path", dto.dbt_projects_path.strip())
    if dto.log_level is not None:
        await _upsert(session, "log_level", dto.log_level)
    if dto.global_requirements_path is not None:
        await _upsert(session, "global_requirements_path", dto.global_requirements_path.strip())
        if requirements_after:
            # The file decides dbt-core now; a leftover version would show in settings
            # and come back into force if the file setting were cleared later
            await _delete_setting(session, DBT_CORE_VERSION_KEY)
    if dto.theme is not None:
        await _upsert(session, "theme", dto.theme)
    if dto.python_path is not None:
        await change_python_path(session, dto.python_path)
    if dto.ai_model is not None:
        if find_model(dto.ai_model.strip()) is None:
            raise HTTPException(status_code=400, detail=f"unknown AI model {dto.ai_model!r}")
        await _upsert(session, AI_MODEL_KEY, dto.ai_model.strip())
    if dto.ai_endpoint_url is not None:
        await _upsert(session, AI_ENDPOINT_URL_KEY, _validate_endpoint(dto.ai_endpoint_url))
    if dto.ai_endpoint_model is not None:
        await _upsert(session, AI_ENDPOINT_MODEL_KEY, dto.ai_endpoint_model.strip())
    if dto.dbt_core_version is not None:
        version = dto.dbt_core_version.strip()
        if version and not is_valid_version(version):
            raise HTTPException(status_code=400, detail=f"'{version}' isn't a dbt-core release number (e.g. 1.10.13)")
        if version and requirements_after:
            raise HTTPException(
                status_code=400,
                detail="A global requirements file is set, so it decides the dbt-core version — "
                "pin dbt-core in that file instead.",
            )
        await _upsert(session, DBT_CORE_VERSION_KEY, version)
    await session.commit()
    return await get_settings(session)


def _validate_endpoint(raw: str) -> str:
    """Empty clears it (back to the bundled model); otherwise an http(s) URL."""
    url = raw.strip()
    if url and urlparse(url).scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="AI endpoint must be an http:// or https:// URL")
    return url


class PythonInterpreterDto(BaseModel):
    path: str
    version: str


@router.get("/python-interpreters", response_model=list[PythonInterpreterDto])
async def list_python_interpreters(
    session: AsyncSession = Depends(get_session),
) -> list[PythonInterpreterDto]:
    """Python 3.11+ interpreters on this machine, for the WICKD_PYTHON_PATH picker."""
    current = await _get_override(session, PYTHON_PATH_KEY)
    found = await asyncio.get_running_loop().run_in_executor(None, venv.list_pythons, current)
    return [PythonInterpreterDto(path=p.path, version=p.version) for p in found]


class RequirementsFileDto(BaseModel):
    content: str


@router.get("/requirements-file", response_model=RequirementsFileDto)
async def get_requirements_file(
    session: AsyncSession = Depends(get_session),
) -> RequirementsFileDto:
    global_req_path = await _get_override(session, "global_requirements_path")
    if not global_req_path:
        raise HTTPException(
            status_code=400,
            detail="WICKD_GLOBAL_REQUIREMENTS_PATH variable has not been set",
        )
    p = Path(global_req_path)
    if not p.exists():
        raise HTTPException(
            status_code=404,
            detail=f"File not found at the path specified in the WICKD_GLOBAL_REQUIREMENTS_PATH variable: {global_req_path}",
        )
    return RequirementsFileDto(content=p.read_text())


@router.put("/requirements-file", response_model=RequirementsFileDto)
async def put_requirements_file(
    dto: RequirementsFileDto,
    session: AsyncSession = Depends(get_session),
) -> RequirementsFileDto:
    global_req_path = await _get_override(session, "global_requirements_path")
    if not global_req_path:
        raise HTTPException(
            status_code=400,
            detail="WICKD_GLOBAL_REQUIREMENTS_PATH variable has not been set",
        )
    p = Path(global_req_path)
    p.write_text(dto.content)
    return RequirementsFileDto(content=dto.content)
