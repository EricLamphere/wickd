"""Test-run an init script from the script editor before saving it.

The editor's current text runs exactly like a real custom step would — same
layered env (process → global → active profile → project vars), same
`bash -euo pipefail`, same working directory — but nothing is persisted:
step status is untouched and captured vars are reported, not saved.
"""
import asyncio
import os
import signal
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.init import _capture_script_exports, _init_lock_for, project_env
from app.db.engine import get_session
from app.db.models import InitStep, Project
from app.dbt.init_scripts import INIT_DIR_NAME
from app.logging_setup import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["init"])

TEST_TIMEOUT_S = 300
MAX_LOG_LINES = 500
MAX_SCRIPT_CHARS = 1_000_000


class ScriptTestRequest(BaseModel):
    content: str = Field(max_length=MAX_SCRIPT_CHARS)
    captured_vars: list[str] = Field(default_factory=list)
    # Bare name of the step being edited (None for a new script): its
    # script's folder is the working directory, as in a real run.
    step_name: str | None = None


class ScriptTestResult(BaseModel):
    ok: bool
    return_code: int
    timed_out: bool
    duration_ms: int
    log: str
    captured: dict[str, str]
    missing: list[str]


async def _script_cwd(session: AsyncSession, project: Project, step_name: str | None) -> Path:
    if step_name:
        result = await session.execute(
            select(InitStep).where(
                InitStep.project_id == project.id, InitStep.name == f"custom: {step_name}"
            )
        )
        step = result.scalar_one_or_none()
        if step is not None and step.script_path:
            parent = Path(step.script_path).parent
            if parent.is_dir():
                return parent
    init_dir = Path(project.path) / (project.init_script_path or INIT_DIR_NAME)
    return init_dir if init_dir.is_dir() else Path(project.path)


async def _run_script(script: Path, cwd: Path, env: dict[str, str]) -> tuple[int, list[str], bool]:
    """Run the script, merging stderr into stdout. Returns (return_code, lines, timed_out)."""
    proc = await asyncio.create_subprocess_exec(
        "bash", "-euo", "pipefail", str(script),
        cwd=str(cwd),
        env={**env, "PYTHONUNBUFFERED": "1"},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        # Own process group, so a timeout kills anything the script spawned too.
        start_new_session=True,
    )
    assert proc.stdout is not None
    # Read output as it arrives (not via communicate()) so whatever the script
    # printed before a timeout is still shown.
    chunks: list[bytes] = []

    async def _drain() -> None:
        while chunk := await proc.stdout.read(4096):
            chunks.append(chunk)

    reader = asyncio.create_task(_drain())
    timed_out = False
    try:
        await asyncio.wait_for(proc.wait(), TEST_TIMEOUT_S)
    except TimeoutError:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await proc.wait()
    await reader
    lines = b"".join(chunks).decode(errors="replace").splitlines()
    return_code = proc.returncode if proc.returncode is not None else -1
    return return_code, lines, timed_out


@router.post("/{project_id}/init/test-script", response_model=ScriptTestResult)
async def test_script(
    project_id: int, dto: ScriptTestRequest, session: AsyncSession = Depends(get_session)
) -> ScriptTestResult:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    if _init_lock_for(project_id).locked():
        raise HTTPException(status_code=409, detail="init pipeline already running")

    cwd = await _script_cwd(session, project, dto.step_name)
    env = await project_env(session, project_id, base=os.environ)
    wanted = [v.strip() for v in dto.captured_vars if v.strip()]

    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="wickd-script-test-") as tmp:
        script = Path(tmp) / "script.sh"
        script.write_text(dto.content)
        log.info("init_script_test", project_id=project_id, cwd=str(cwd))
        return_code, lines, timed_out = await _run_script(script, cwd, env)

        captured: dict[str, str] = {}
        missing: list[str] = []
        if return_code == 0 and wanted:
            exports = await _capture_script_exports(str(script), str(cwd), env)
            captured = {k: exports[k] for k in wanted if k in exports}
            missing = [k for k in wanted if k not in exports]

    if timed_out:
        lines.append(f"[wickd] test stopped after {TEST_TIMEOUT_S}s")
    return ScriptTestResult(
        ok=return_code == 0 and not timed_out,
        return_code=return_code,
        timed_out=timed_out,
        duration_ms=int((time.monotonic() - started) * 1000),
        log="\n".join(lines[-MAX_LOG_LINES:]),
        captured=captured,
        missing=missing,
    )
