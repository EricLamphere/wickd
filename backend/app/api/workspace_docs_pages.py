"""Shared docs folders (WICKD_SHARED_DOCS_PATHS) for the home page's combined docs Pages tab.

GET /api/workspace/docs-pages                              → {folders: [{id, name, path, pages}]}
GET /api/workspace/docs-pages/{folder_id}/content?path=     → one page (same shape as a project's)
GET /api/workspace/docs-pages/{folder_id}/asset?path=       → an image from the folder

A folder belongs to no project, so docs blocks in its pages aren't matched to nodes.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.docs_pages import _SVG_HEADERS, PageContentDto, PageDto, SegmentDto, _http
from app.db.engine import get_session
from app.docs_pages import blocks, service, shared
from app.docs_pages.service import DocsPagesError
from app.logging_setup import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/api/workspace/docs-pages", tags=["workspace-docs"])


class SharedFolderDto(BaseModel):
    id: int
    name: str
    path: str
    pages: list[PageDto]


class SharedFoldersDto(BaseModel):
    folders: list[SharedFolderDto]


def _list(raw: str) -> list[SharedFolderDto]:
    return [
        SharedFolderDto(
            id=folder.id,
            name=folder.name,
            path=str(folder.path),
            pages=[PageDto(path=p.path, title=p.title, folder=p.folder) for p in service.list_pages(folder.path)],
        )
        for folder in shared.shared_folders(raw)
    ]


@router.get("", response_model=SharedFoldersDto)
async def list_shared_folders(session: AsyncSession = Depends(get_session)) -> SharedFoldersDto:
    raw = await shared.load_setting(session)
    return SharedFoldersDto(folders=await asyncio.to_thread(_list, raw))


async def _folder(session: AsyncSession, folder_id: int) -> shared.SharedFolder:
    raw = await shared.load_setting(session)
    try:
        return await asyncio.to_thread(shared.find_folder, raw, folder_id)
    except DocsPagesError as exc:
        raise _http(exc) from exc


def _read_page(docs_dir: Path, rel: str) -> PageContentDto:
    path = service.safe_join(docs_dir, rel)
    text = service.read_page_text(path)
    return PageContentDto(
        path=path.relative_to(docs_dir).as_posix(),
        title=service.page_title(text, path.stem),
        text=text,
        segments=[SegmentDto(**p) for p in blocks.segments(text)],
        mtime=datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat(),
        project_path=None,
    )


@router.get("/{folder_id}/content", response_model=PageContentDto)
async def get_shared_page(
    folder_id: int, path: str = Query(..., max_length=1024), session: AsyncSession = Depends(get_session)
) -> PageContentDto:
    folder = await _folder(session, folder_id)
    try:
        return await asyncio.to_thread(_read_page, folder.path, path)
    except DocsPagesError as exc:
        raise _http(exc) from exc
    except OSError as exc:
        log.warning("shared_docs_page_read_failed", folder=str(folder.path), path=path, error=str(exc))
        raise HTTPException(status_code=500, detail={"error": "read_failed", "message": "could not read the page"}) from exc


@router.get("/{folder_id}/asset")
async def get_shared_asset(
    folder_id: int, path: str = Query(..., max_length=1024), session: AsyncSession = Depends(get_session)
) -> FileResponse:
    folder = await _folder(session, folder_id)
    try:
        target = service.safe_join(folder.path, path)
        content_type = service.image_type(target)
    except DocsPagesError as exc:
        raise _http(exc) from exc
    if not target.is_file():
        raise _http(DocsPagesError("not_found", "image not found"))
    headers = _SVG_HEADERS if content_type == "image/svg+xml" else None
    return FileResponse(target, media_type=content_type, headers=headers)
