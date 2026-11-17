"""Metric notes (Base; plan 30): Markdown files under NOTES_PATH, images under NOTES_IMG_PATH.

GET    /api/projects/{id}/metric-notes                  → {folder, img_folder, notes}
POST   /api/projects/{id}/metric-notes                  → create (201)
GET    /api/projects/{id}/metric-notes/{slug}           → one note
PUT    /api/projects/{id}/metric-notes/{slug}           → save (409 when the file changed since base_modified_at)
DELETE /api/projects/{id}/metric-notes/{slug}?remove_images= → 204
GET    /api/projects/{id}/metric-notes/{slug}/orphan-images → images only this note uses
POST   /api/projects/{id}/metric-notes/images           → upload (multipart `file`, `name`) → {path}
GET    /api/projects/{id}/metric-notes/asset?path=      → an image a note shows (path relative to the notes folder)

The format is app/semantic/notes.py, the files app/semantic/note_store.py. A metric or dimension
the semantic manifest doesn't know is a warning, not an error: notes outlive renames.
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_session
from app.db.models import Project, ProjectEnvVar
from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.semantic import note_store, notes, service
from app.semantic.note_store import Folders, NoteEntry
from app.semantic.notes import Note, NoteError

router = APIRouter(prefix="/api/projects", tags=["metric-notes"])
log = get_logger(__name__)

_ERROR_STATUS = {"not_found": 404, "exists": 409, "conflict": 409, "too_large": 413}
_SVG_HEADERS = {"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "X-Content-Type-Options": "nosniff"}
EVENT = "metric_notes_changed"


class NoteInDto(BaseModel):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    start: str
    end: str
    metrics: list[str] = Field(default_factory=list, max_length=notes.MAX_METRICS)
    dimension: str | None = None
    value: str | None = None
    body: Annotated[str, StringConstraints(max_length=notes.MAX_BODY_CHARS)] = ""


class SaveDto(NoteInDto):
    # the file's modified_at when the editor loaded it; a newer file on disk is a 409
    base_modified_at: str | None = None


def _http(exc: NoteError) -> HTTPException:
    detail: dict[str, Any] = {"error": exc.code, "message": exc.message}
    if exc.field:
        detail["field"] = exc.field
    return HTTPException(status_code=_ERROR_STATUS.get(exc.code, 400), detail=detail)


async def _setting(session: AsyncSession, project_id: int, key: str) -> str | None:
    return (await session.execute(
        select(ProjectEnvVar.value).where(ProjectEnvVar.project_id == project_id, ProjectEnvVar.key == key)
    )).scalar_one_or_none()


async def _context(session: AsyncSession, project_id: int) -> tuple[Project, Folders]:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    try:
        f = note_store.folders(
            Path(project.path),
            await _setting(session, project_id, note_store.SETTING_KEY),
            await _setting(session, project_id, note_store.IMG_SETTING_KEY),
        )
    except NoteError as exc:
        raise _http(exc) from exc
    return project, f


def _modified(entry: NoteEntry) -> str | None:
    return datetime.fromtimestamp(entry.mtime, UTC).isoformat() if entry.mtime else None


def semantic_names(project_path: Path) -> tuple[set[str], set[str]] | None:
    """(metric names, dimension names incl. `entity__dim`) from semantic_manifest.json, or None."""
    try:
        data = json.loads((service.target_dir(project_path) / "semantic_manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    metrics = {m.get("name") for m in data.get("metrics") or [] if isinstance(m, dict) and m.get("name")}
    dims: set[str] = set()
    for model in data.get("semantic_models") or []:
        if not isinstance(model, dict):
            continue
        entities = [e.get("name") for e in model.get("entities") or [] if isinstance(e, dict) and e.get("name")]
        for d in model.get("dimensions") or []:
            name = d.get("name") if isinstance(d, dict) else None
            if name:
                dims |= {name, *(f"{e}__{name}" for e in entities)}
        dims |= set(entities)
    return metrics, dims


def _warnings(note: Note | None, names: tuple[set[str], set[str]] | None) -> list[str]:
    if note is None or names is None:
        return []
    metrics, dims = names
    out = [f"`{m}` isn't a metric in the semantic layer (renamed or removed?)" for m in note.meta.metrics if m not in metrics]
    dim = note.meta.dimension
    if dim and not any(notes.same_dimension(dim, d) for d in dims):
        out.append(f"`{dim}` isn't a dimension in the semantic layer")
    return out


def _dto(entry: NoteEntry, names: tuple[set[str], set[str]] | None) -> dict:
    n = entry.note
    meta = n.meta if n else None
    return {
        "slug": entry.slug, "path": entry.path,
        "title": meta.title if meta else entry.slug,
        "start": meta.start if meta else None, "end": meta.end if meta else None,
        "metrics": list(meta.metrics) if meta else [],
        "dimension": meta.dimension if meta else None, "value": meta.value if meta else None,
        "created": meta.created if meta else None,
        "body": n.body if n else "",
        "error": entry.error, "warnings": _warnings(n, names), "modified_at": _modified(entry),
    }


def _note(dto: NoteInDto, existing: Note | None = None) -> Note:
    """The note to write: the dto's fields over the existing file's unknown keys."""
    extra = dict(existing.meta.model_extra or {}) if existing else {}
    created = existing.meta.created if existing and existing.meta.created else (
        datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"))
    data = {**extra, "title": dto.title, "start": dto.start, "end": dto.end, "metrics": dto.metrics,
            "dimension": dto.dimension or None, "value": dto.value if dto.dimension else None, "created": created}
    return Note(meta=notes.validate_meta(data), body=dto.body)


async def publish_changed(project_id: int, slug: str | None) -> None:
    await bus.publish(Event(topic=f"project:{project_id}", type=EVENT, data={"slug": slug}))


# ── notes ────────────────────────────────────────────────────────────────────


@router.get("/{project_id}/metric-notes")
async def list_metric_notes(project_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    project, f = await _context(session, project_id)
    entries = await asyncio.to_thread(note_store.list_notes, f)
    names = await asyncio.to_thread(semantic_names, Path(project.path))
    return {
        "folder": note_store.relative(f, f.notes), "img_folder": note_store.relative(f, f.images),
        "notes": [_dto(e, names) for e in entries],
    }


@router.post("/{project_id}/metric-notes", status_code=201)
async def create_metric_note(project_id: int, dto: NoteInDto, session: AsyncSession = Depends(get_session)) -> dict:
    project, f = await _context(session, project_id)
    try:
        note = _note(dto)
        slug = note_store.unique_slug(f, dto.title)
        entry = await asyncio.to_thread(note_store.write, f, slug, note, create=True)
    except NoteError as exc:
        raise _http(exc) from exc
    log.info("metric_note_created", project_id=project_id, slug=slug)
    await publish_changed(project_id, slug)
    return _dto(entry, semantic_names(Path(project.path)))


@router.get("/{project_id}/metric-notes/asset")
async def get_metric_note_asset(
    project_id: int, path: str = Query(..., max_length=1024), session: AsyncSession = Depends(get_session)
) -> FileResponse:
    _, f = await _context(session, project_id)
    try:
        target, content_type = note_store.asset(f, path)
    except NoteError as exc:
        raise _http(exc) from exc
    headers = _SVG_HEADERS if content_type == "image/svg+xml" else None
    return FileResponse(target, media_type=content_type, headers=headers)


@router.post("/{project_id}/metric-notes/images", status_code=201)
async def upload_metric_note_image(
    project_id: int,
    name: str = Form("note", max_length=200),
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
) -> dict:
    _, f = await _context(session, project_id)
    data = await file.read(note_store.MAX_IMAGE_BYTES + 1)
    try:
        rel = await asyncio.to_thread(note_store.save_image, f, name, data)
    except NoteError as exc:
        raise _http(exc) from exc
    except OSError as exc:
        log.warning("metric_note_image_failed", project_id=project_id, error=str(exc))
        raise HTTPException(status_code=500, detail={"error": "write_failed", "message": "couldn't save the image"}) from exc
    log.info("metric_note_image_saved", project_id=project_id, path=rel)
    return {"path": rel}


@router.get("/{project_id}/metric-notes/{slug}")
async def get_metric_note(project_id: int, slug: str, session: AsyncSession = Depends(get_session)) -> dict:
    project, f = await _context(session, project_id)
    try:
        entry = await asyncio.to_thread(note_store.read, f, slug)
    except NoteError as exc:
        raise _http(exc) from exc
    return _dto(entry, semantic_names(Path(project.path)))


@router.put("/{project_id}/metric-notes/{slug}")
async def save_metric_note(project_id: int, slug: str, dto: SaveDto, session: AsyncSession = Depends(get_session)) -> dict:
    project, f = await _context(session, project_id)
    try:
        current = await asyncio.to_thread(note_store.read, f, slug)
        if dto.base_modified_at and _modified(current) and _modified(current) != dto.base_modified_at:
            raise NoteError("conflict", f"{current.path} changed on disk since you opened it — reload to see the new version")
        entry = await asyncio.to_thread(note_store.write, f, slug, _note(dto, current.note))
    except NoteError as exc:
        raise _http(exc) from exc
    await publish_changed(project_id, slug)
    return _dto(entry, semantic_names(Path(project.path)))


@router.get("/{project_id}/metric-notes/{slug}/orphan-images")
async def get_orphan_images(project_id: int, slug: str, session: AsyncSession = Depends(get_session)) -> dict:
    _, f = await _context(session, project_id)
    try:
        notes.check_slug(slug)
    except NoteError as exc:
        raise _http(exc) from exc
    images = await asyncio.to_thread(note_store.images_only_in, f, slug)
    return {"images": [note_store.relative(f, p) for p in images]}


@router.delete("/{project_id}/metric-notes/{slug}", status_code=204)
async def delete_metric_note(
    project_id: int, slug: str, remove_images: bool = False, session: AsyncSession = Depends(get_session)
) -> Response:
    _, f = await _context(session, project_id)
    try:
        removed = await asyncio.to_thread(note_store.delete, f, slug, remove_images=remove_images)
    except NoteError as exc:
        raise _http(exc) from exc
    log.info("metric_note_deleted", project_id=project_id, slug=slug, images=len(removed))
    await publish_changed(project_id, slug)
    return Response(status_code=204)
