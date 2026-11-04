import asyncio
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.engine import get_session
from app.db.models import Project
from app.dbt.docs_data import DocsNotGenerated, DocsUnreadable, load_docs_data
from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.projects import docs_state

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["docs"])


class DocsStatusDto(BaseModel):
    generated_at: str | None


def _docs_dir(project_id: int) -> Path:
    return settings.data_dir / "docs" / str(project_id)


def _patch_index_html(content: str, project_id: int) -> str:
    """Inject a <base href> so Angular's pushState stays within the iframe."""
    base_href = f'<base href="/static/docs/{project_id}/">'
    if re.search(r'<base\b[^>]*>', content):
        return re.sub(r'<base\b[^>]*>', base_href, content, count=1)
    return content.replace('<head>', f'<head>{base_href}', 1)


@router.get("/{project_id}/docs/data")
async def get_docs_data(project_id: int) -> dict[str, Any]:
    """Return merged manifest + catalog as a clean JSON blob for native rendering."""
    try:
        return await asyncio.to_thread(load_docs_data, _docs_dir(project_id))
    except DocsNotGenerated as exc:
        raise HTTPException(status_code=404, detail="docs not generated yet") from exc
    except DocsUnreadable as exc:
        raise HTTPException(status_code=500, detail=f"failed to read manifest: {exc}") from exc


@router.get("/{project_id}/docs/view", response_class=HTMLResponse)
async def view_docs(project_id: int) -> HTMLResponse:
    """Serve the patched docs index.html so Angular routing stays in the iframe."""
    index = _docs_dir(project_id) / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="docs not generated yet")
    content = index.read_text(encoding="utf-8")
    return HTMLResponse(_patch_index_html(content, project_id))


@router.get("/{project_id}/docs/status", response_model=DocsStatusDto)
async def get_docs_status(project_id: int) -> DocsStatusDto:
    # catalog.json is the canonical output — present whether we used
    # `compile --write-catalog` (dbt >= 1.9) or `docs generate` (older).
    catalog = _docs_dir(project_id) / "catalog.json"
    if not catalog.exists():
        return DocsStatusDto(generated_at=None)
    mtime = catalog.stat().st_mtime
    generated_at = datetime.fromtimestamp(mtime, tz=UTC).isoformat()
    return DocsStatusDto(generated_at=generated_at)


@router.post("/{project_id}/docs/generate")
async def generate_docs(
    project_id: int,
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    asyncio.create_task(_generate_docs(project_id, project.path))
    return {"status": "started"}


async def _generate_docs(
    project_id: int, project_path: str, env: dict | None = None
) -> tuple[bool, list[str]]:
    """Generate one project's docs, reporting progress on the global stream (combined docs)."""
    await docs_state.mark(project_id, "generating")
    try:
        ok, lines = await _run_docs_generate(project_id, project_path, env)
    except Exception as exc:
        await docs_state.mark(project_id, "error", str(exc))
        raise
    await docs_state.mark(project_id, "done" if ok else "error", None if ok else docs_state.failure_summary(lines))
    return ok, lines


async def _run_docs_generate(
    project_id: int, project_path: str, env: dict | None
) -> tuple[bool, list[str]]:
    from app.api.init import load_project_env
    from app.dbt.venv import venv_dbt
    from app.logs.project_logger import append_project_log

    topic = f"project:{project_id}"
    if env is None:
        env = await load_project_env(project_id)
    await bus.publish(Event(topic=topic, type="docs_generating", data={}))

    dbt = str(venv_dbt())
    project = Path(project_path)
    # --profiles-dir must come AFTER the subcommand, not between `dbt` and `docs`/`compile`
    profiles_args = ["--profiles-dir", project_path] if (project / "profiles.yml").exists() else []

    async def _run_and_log(args: list[str]) -> tuple[bool, list[str]]:
        append_project_log(project_path, f">>> dbt {' '.join(args[1:])}", project_id)
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=project_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=env,
            )
        except Exception as exc:  # noqa: BLE001 — error is logged/reported below
            append_project_log(project_path, f"error: {exc}", project_id)
            return False, []
        lines: list[str] = []
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode(errors="replace").rstrip("\n")
            append_project_log(project_path, line, project_id)
            lines.append(line)
        rc = await proc.wait()
        status = "OK" if rc == 0 else f"FAILED (rc={rc})"
        append_project_log(project_path, f"<<< dbt {' '.join(args[1:])} {status}", project_id)
        combined = "\n".join(lines).lower()
        unrecognised = any(kw in combined for kw in ("unrecognized", "no such option", "invalid value"))
        return rc == 0 and not unrecognised, lines

    # dbt >= 1.9: compile --write-catalog [--profiles-dir ...]
    ok, output_lines = await _run_and_log([dbt, "compile", "--write-catalog"] + profiles_args)
    if not ok and any(kw in "\n".join(output_lines).lower() for kw in ("unrecognized", "no such option", "invalid value")):
        # Older dbt fallback: docs generate [--profiles-dir ...]
        ok, output_lines = await _run_and_log([dbt, "docs", "generate"] + profiles_args)

    log.info("docs_generate_result", ok=ok, last_lines=output_lines[-10:])

    if not ok:
        await bus.publish(Event(topic=topic, type="docs_generated", data={"ok": False}))
        return False, output_lines

    # Copy target artifacts to data_dir/docs/{project_id}/
    target_dir = Path(project_path) / "target"
    dest_dir = _docs_dir(project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    for filename in ("manifest.json", "catalog.json"):
        src = target_dir / filename
        if src.exists():
            shutil.copy2(src, dest_dir / filename)

    # index.html is produced by `docs generate` but not `compile --write-catalog`.
    # Copy and patch it when present (used by the iframe-based viewer).
    index_src = target_dir / "index.html"
    if index_src.exists():
        content = index_src.read_text(encoding="utf-8")
        (dest_dir / "index.html").write_text(
            _patch_index_html(content, project_id), encoding="utf-8"
        )

    generated_at = datetime.now(UTC).isoformat()
    await bus.publish(
        Event(topic=topic, type="docs_generated", data={"ok": True, "generated_at": generated_at})
    )
    return True, output_lines
