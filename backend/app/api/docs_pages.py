"""Markdown docs pages (plan 28): list, read, and serve images from a project's docs folder.

GET /api/projects/{id}/docs-pages                 → {dir, in_project, setting, pages}
GET /api/projects/{id}/docs-pages/content?path=    → one page, split into Markdown / docs block segments
GET /api/projects/{id}/docs-pages/asset?path=&root= → an image (root=docs: the docs folder, root=project: the project, for README images)
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_session
from app.db.models import Project, ProjectEnvVar
from app.docs_pages import blocks, service
from app.docs_pages.service import DocsPagesError
from app.git.repo import find_repo_root
from app.logging_setup import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["docs-pages"])

_ERROR_STATUS = {"not_found": 404, "no_docs_dir": 404}
# SVGs can carry script: serve them inert
_SVG_HEADERS = {"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "X-Content-Type-Options": "nosniff"}


class PageDto(BaseModel):
    path: str
    title: str
    folder: str


class PagesListDto(BaseModel):
    dir: str | None  # relative to the project root ('../docs' for the repo root's folder); null = none found
    in_project: bool  # the folder is inside the dbt project, so Files can open its pages
    setting: str  # DOCS_PATH as saved ('' = default)
    pages: list[PageDto]


class SegmentDto(BaseModel):
    kind: Literal["markdown", "docs_block"]
    text: str
    name: str | None = None  # docs block name
    used_by: list[str] = []  # unique_ids of the nodes using the block


class PageContentDto(BaseModel):
    path: str
    title: str
    text: str
    segments: list[SegmentDto]
    mtime: str
    project_path: str | None  # the page relative to the project root, when inside it (for Edit)


def _http(exc: DocsPagesError) -> HTTPException:
    return HTTPException(status_code=_ERROR_STATUS.get(exc.code, 400), detail={"error": exc.code, "message": exc.message})


async def _project(session: AsyncSession, project_id: int) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


async def _setting(session: AsyncSession, project_id: int) -> str:
    value = (await session.execute(
        select(ProjectEnvVar.value).where(ProjectEnvVar.project_id == project_id, ProjectEnvVar.key == service.SETTING_KEY)
    )).scalar_one_or_none()
    return value or ""


def _docs_dir(project_path: Path, setting: str) -> Path | None:
    return service.resolve_docs_dir(project_path, find_repo_root(project_path), setting)


async def _require_docs_dir(session: AsyncSession, project: Project) -> Path:
    try:
        docs_dir = await asyncio.to_thread(_docs_dir, Path(project.path), await _setting(session, project.id))
    except DocsPagesError as exc:
        raise _http(exc) from exc
    if docs_dir is None:
        raise _http(DocsPagesError("no_docs_dir", "this project has no docs folder"))
    return docs_dir


@router.get("/{project_id}/docs-pages", response_model=PagesListDto)
async def list_docs_pages(project_id: int, session: AsyncSession = Depends(get_session)) -> PagesListDto:
    project = await _project(session, project_id)
    project_path = Path(project.path)
    setting = await _setting(session, project_id)
    try:
        docs_dir = await asyncio.to_thread(_docs_dir, project_path, setting)
    except DocsPagesError as exc:
        raise _http(exc) from exc
    if docs_dir is None:
        return PagesListDto(dir=None, in_project=False, setting=setting, pages=[])
    pages = await asyncio.to_thread(service.list_pages, docs_dir)
    return PagesListDto(
        dir=service.relative_to_project(project_path, docs_dir),
        in_project=docs_dir.is_relative_to(project_path.resolve()),
        setting=setting,
        pages=[PageDto(path=p.path, title=p.title, folder=p.folder) for p in pages],
    )


def _manifest(project_path: Path) -> dict[str, Any]:
    try:
        return json.loads((project_path / "target" / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log.info("docs_pages_manifest_unavailable", error=str(exc))
        return {}


def _read_page(project_path: Path, docs_dir: Path, rel: str) -> PageContentDto:
    path = service.safe_join(docs_dir, rel)
    text = service.read_page_text(path)
    parts = blocks.segments(text)
    names = {p["name"] for p in parts if p["kind"] == "docs_block"}
    usage = blocks.docs_block_usage(_manifest(project_path), names) if names else {}
    root = project_path.resolve()
    return PageContentDto(
        path=path.relative_to(docs_dir.resolve()).as_posix(),
        title=service.page_title(text, path.stem),
        text=text,
        segments=[SegmentDto(**p, used_by=usage.get(p.get("name") or "", [])) for p in parts],
        mtime=datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat(),
        project_path=path.relative_to(root).as_posix() if path.is_relative_to(root) else None,
    )


@router.get("/{project_id}/docs-pages/content", response_model=PageContentDto)
async def get_docs_page(
    project_id: int, path: str = Query(..., max_length=1024), session: AsyncSession = Depends(get_session)
) -> PageContentDto:
    project = await _project(session, project_id)
    docs_dir = await _require_docs_dir(session, project)
    try:
        return await asyncio.to_thread(_read_page, Path(project.path), docs_dir, path)
    except DocsPagesError as exc:
        raise _http(exc) from exc
    except OSError as exc:
        log.warning("docs_page_read_failed", project_id=project_id, path=path, error=str(exc))
        raise HTTPException(status_code=500, detail={"error": "read_failed", "message": "could not read the page"}) from exc


@router.get("/{project_id}/docs-pages/asset")
async def get_docs_asset(
    project_id: int,
    path: str = Query(..., max_length=1024),
    root: Literal["docs", "project"] = "docs",
    session: AsyncSession = Depends(get_session),
) -> FileResponse:
    project = await _project(session, project_id)
    base = await _require_docs_dir(session, project) if root == "docs" else Path(project.path)
    try:
        target = service.safe_join(base, path)
        content_type = service.image_type(target)
    except DocsPagesError as exc:
        raise _http(exc) from exc
    if not target.is_file():
        raise _http(DocsPagesError("not_found", "image not found"))
    headers = _SVG_HEADERS if content_type == "image/svg+xml" else None
    return FileResponse(target, media_type=content_type, headers=headers)
