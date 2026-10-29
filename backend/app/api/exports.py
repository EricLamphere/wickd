"""DAG and dashboard exports. The frontend renders the file (it owns the layout and the on-screen
filter); this writes it into the folder the user picked, so the desktop app — whose webview has
no download manager — can save anywhere, defaulting to ~/Downloads."""

import asyncio
import base64
import binascii
import os
import sys
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_session
from app.db.models import Project
from app.exports.paths import ExportFormat, ExportPathError, default_export_dir, resolve_export_path
from app.logging_setup import get_logger

router = APIRouter(prefix="/api/projects", tags=["exports"])
global_router = APIRouter(prefix="/api/exports", tags=["exports"])
log = get_logger(__name__)

# A base64 PNG of a very large DAG stays well under this; it only guards against runaway bodies.
MAX_CONTENT_CHARS = 200 * 1024 * 1024


class DagExportRequestDto(BaseModel):
    directory: str = Field(max_length=4096)
    filename: str = Field(max_length=1024)
    format: ExportFormat
    content: str = Field(max_length=MAX_CONTENT_CHARS)
    encoding: Literal["utf8", "base64"] = "utf8"
    overwrite: bool = False


class ExportResultDto(BaseModel):
    path: str
    bytes: int


class DefaultDirDto(BaseModel):
    path: str


class RevealRequestDto(BaseModel):
    path: str = Field(max_length=4096)


def _bad_request(field: str, message: str) -> HTTPException:
    return HTTPException(status_code=400, detail={"field": field, "message": message})


def _decode(body: DagExportRequestDto) -> bytes:
    if body.encoding == "utf8":
        return body.content.encode("utf-8")
    try:
        return base64.b64decode(body.content, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise _bad_request("content", "The export data is corrupt.") from exc


def _write_atomic(target: Path, data: bytes) -> None:
    tmp = target.with_name(f".{target.name}.wickd-tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)


async def _export(project_id: int, body: DagExportRequestDto, session: AsyncSession, kind: str) -> ExportResultDto:
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")

    try:
        target = resolve_export_path(body.directory, body.filename, body.format)
    except ExportPathError as exc:
        raise _bad_request(exc.field, exc.message) from exc
    if target.exists() and not body.overwrite:
        raise HTTPException(
            status_code=409,
            detail={"field": "filename", "message": f"{target.name} already exists."},
        )

    data = _decode(body)
    try:
        await asyncio.to_thread(_write_atomic, target, data)
    except OSError as exc:
        log.warning("export_write_failed", kind=kind, path=str(target), error=str(exc))
        raise _bad_request("directory", f"Couldn't write {target.name}: {exc.strerror}") from exc

    log.info(f"{kind}_exported", project_id=project_id, path=str(target), format=body.format)
    return ExportResultDto(path=str(target), bytes=len(data))


@router.post("/{project_id}/exports/dag", response_model=ExportResultDto, status_code=201)
async def export_dag(
    project_id: int,
    body: DagExportRequestDto,
    session: AsyncSession = Depends(get_session),
) -> ExportResultDto:
    return await _export(project_id, body, session, "dag")


@router.post("/{project_id}/exports/dashboard", response_model=ExportResultDto, status_code=201)
async def export_dashboard(
    project_id: int,
    body: DagExportRequestDto,
    session: AsyncSession = Depends(get_session),
) -> ExportResultDto:
    """A metric dashboard rendered by the frontend (self-contained HTML, or PNG)."""
    return await _export(project_id, body, session, "dashboard")


@global_router.get("/default-dir", response_model=DefaultDirDto)
async def get_default_dir() -> DefaultDirDto:
    return DefaultDirDto(path=str(default_export_dir()))


def _reveal_command(path: Path) -> list[str]:
    if sys.platform == "darwin":
        return ["open", "-R", str(path)]
    if sys.platform == "win32":
        return ["explorer", f"/select,{path}"]
    return ["xdg-open", str(path.parent)]


@global_router.post("/reveal", status_code=204)
async def reveal_export(body: RevealRequestDto) -> None:
    """Show an exported file in Finder (or the platform's file manager)."""
    path = Path(body.path).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    try:
        proc = await asyncio.create_subprocess_exec(
            *_reveal_command(path),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
    except OSError as exc:
        log.warning("reveal_failed", path=str(path), error=str(exc))
        raise HTTPException(status_code=500, detail="couldn't open the file manager") from exc
