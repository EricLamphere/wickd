"""File explorer API — directory listing, file read/write, move/copy/upload within a project."""
import asyncio
import shutil
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_session
from app.db.models import Project
from app.files.ops import (
    FileConflictError,
    FileOpError,
    Moved,
    copy_paths,
    is_text_file,
    move_paths,
    upload_target,
)
from app.logging_setup import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["files"])

# File extensions that are safe to read/write as text
TEXT_EXTENSIONS = {
    ".sql", ".yml", ".yaml", ".md", ".txt", ".toml", ".ini",
    ".json", ".csv", ".py", ".sh", ".env", ".gitignore",
}

# Directories that should never appear in the tree
HIDDEN_DIRS = {"__pycache__", ".git", "node_modules", "dbt_packages", "logs", ".venv", "venv"}


class FileNode(BaseModel):
    name: str
    path: str        # relative to project root
    is_dir: bool
    children: list["FileNode"] | None = None  # None means not expanded


class FileContentDto(BaseModel):
    path: str
    content: str
    language: str    # sql | yaml | markdown | json | python | shell | text


class FileWriteDto(BaseModel):
    content: str


class RenameDto(BaseModel):
    new_name: str   # just the new filename, not a full path


class PathsToDirDto(BaseModel):
    paths: list[str]  # relative to project root
    dest_dir: str     # folder to move/copy into ("" = project root)


class PathDto(BaseModel):
    path: str


class MovedDto(BaseModel):
    src: str
    dst: str
    is_dir: bool


class NewFileDto(BaseModel):
    name: str       # filename (no path separators) — relative to dir_path
    dir_path: str   # directory to create the file in (relative to project root)
    is_dir: bool = False


def _rel(project_root: Path, p: Path) -> str:
    return str(p.relative_to(project_root))


def _safe_path(project: Project, rel_path: str) -> Path:
    """Resolve a relative path and ensure it stays within the project root."""
    root = Path(project.path).resolve()
    candidate = (root / rel_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="path escapes project root")
    return candidate


def _language(path: Path) -> str:
    suffix = path.suffix.lower()
    return {
        ".sql": "sql",
        ".yml": "yaml",
        ".yaml": "yaml",
        ".md": "markdown",
        ".json": "json",
        ".py": "python",
        ".sh": "shell",
        ".toml": "ini",
    }.get(suffix, "plaintext")


def _build_tree(root: Path, current: Path, depth: int = 0) -> list[FileNode]:
    if depth > 8:
        return []
    nodes: list[FileNode] = []
    try:
        entries = sorted(current.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    except PermissionError:
        return []
    for entry in entries:
        if entry.is_dir() and entry.name in HIDDEN_DIRS:
            continue
        rel = _rel(root, entry)
        if entry.is_dir():
            nodes.append(FileNode(name=entry.name, path=rel, is_dir=True, children=None))
        else:
            nodes.append(FileNode(name=entry.name, path=rel, is_dir=False))
    return nodes


@router.get("/{project_id}/files", response_model=list[FileNode])
async def list_files(
    project_id: int,
    path: str = "",
    session: AsyncSession = Depends(get_session),
) -> list[FileNode]:
    """List directory contents one level deep. `path` is relative to project root."""
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    root = Path(project.path).resolve()
    target = _safe_path(project, path) if path else root
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="not a directory")
    return _build_tree(root, target)


@router.get("/{project_id}/files/content", response_model=FileContentDto)
async def get_file(
    project_id: int,
    path: str,
    session: AsyncSession = Depends(get_session),
) -> FileContentDto:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    file_path = _safe_path(project, path)
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    if not is_text_file(file_path, TEXT_EXTENSIONS):
        raise HTTPException(status_code=400, detail="binary file")
    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return FileContentDto(path=path, content=content, language=_language(file_path))


@router.put("/{project_id}/files/content", response_model=FileContentDto)
async def put_file(
    project_id: int,
    path: str,
    dto: FileWriteDto,
    session: AsyncSession = Depends(get_session),
) -> FileContentDto:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    file_path = _safe_path(project, path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="file not found")
    if not is_text_file(file_path, TEXT_EXTENSIONS):
        raise HTTPException(status_code=400, detail="binary file")
    file_path.write_text(dto.content, encoding="utf-8")
    return FileContentDto(path=path, content=dto.content, language=_language(file_path))


@router.post("/{project_id}/files/new", response_model=FileNode, status_code=201)
async def new_file(
    project_id: int,
    dto: NewFileDto,
    session: AsyncSession = Depends(get_session),
) -> FileNode:
    """Create a new file or directory."""
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    if "/" in dto.name or "\\" in dto.name:
        raise HTTPException(status_code=422, detail="name must not contain path separators")
    root = Path(project.path).resolve()
    dir_path = _safe_path(project, dto.dir_path) if dto.dir_path else root
    if not dir_path.is_dir():
        raise HTTPException(status_code=400, detail="parent directory not found")
    target = (dir_path / dto.name).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="path escapes project root")
    if target.exists():
        raise HTTPException(status_code=409, detail=f"'{dto.name}' already exists")
    if dto.is_dir:
        target.mkdir(parents=False, exist_ok=False)
    else:
        target.touch()
    rel = _rel(root, target)
    return FileNode(name=target.name, path=rel, is_dir=dto.is_dir)


@router.post("/{project_id}/files/rename", response_model=FileNode)
async def rename_file(
    project_id: int,
    path: str,
    dto: RenameDto,
    session: AsyncSession = Depends(get_session),
) -> FileNode:
    """Rename a file or directory (stays in the same parent directory)."""
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    if "/" in dto.new_name or "\\" in dto.new_name:
        raise HTTPException(status_code=422, detail="new_name must not contain path separators")
    root = Path(project.path).resolve()
    src = _safe_path(project, path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="path not found")
    dst = (src.parent / dto.new_name).resolve()
    try:
        dst.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="path escapes project root")
    if dst.exists():
        raise HTTPException(status_code=409, detail=f"'{dto.new_name}' already exists")
    src.rename(dst)
    rel = _rel(root, dst)
    return FileNode(name=dst.name, path=rel, is_dir=dst.is_dir())


@router.delete("/{project_id}/files", status_code=204)
async def delete_file(
    project_id: int,
    path: str,
    session: AsyncSession = Depends(get_session),
) -> None:
    """Delete a file or directory (directories deleted recursively)."""
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    target = _safe_path(project, path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="path not found")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()


async def _project_or_404(session: AsyncSession, project_id: int) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _dest_dir(project: Project, dest_dir: str) -> Path:
    return _safe_path(project, dest_dir) if dest_dir else Path(project.path).resolve()


def _moved_dtos(project: Project, done: list[Moved]) -> list[MovedDto]:
    root = Path(project.path).resolve()
    return [MovedDto(src=_rel(root, m.src), dst=_rel(root, m.dst), is_dir=m.dst.is_dir()) for m in done]


def _file_op_http_error(e: FileOpError) -> HTTPException:
    if isinstance(e, FileConflictError):
        return HTTPException(status_code=409, detail=str(e))
    return HTTPException(status_code=400, detail=str(e))


@router.post("/{project_id}/files/move", response_model=list[MovedDto])
async def move_files(
    project_id: int,
    dto: PathsToDirDto,
    session: AsyncSession = Depends(get_session),
) -> list[MovedDto]:
    """Move files/folders into another folder (drag and drop, cut + paste). All or nothing on conflicts."""
    project = await _project_or_404(session, project_id)
    srcs = [_safe_path(project, p) for p in dto.paths]
    if Path(project.path).resolve() in srcs:
        raise HTTPException(status_code=400, detail="can't move the project root")
    try:
        done = move_paths(srcs, _dest_dir(project, dto.dest_dir))
    except FileOpError as e:
        raise _file_op_http_error(e)
    except OSError as e:
        log.error("files_move_failed", project_id=project_id, error=str(e))
        raise HTTPException(status_code=500, detail=str(e))
    return _moved_dtos(project, done)


@router.post("/{project_id}/files/copy", response_model=list[MovedDto])
async def copy_files(
    project_id: int,
    dto: PathsToDirDto,
    session: AsyncSession = Depends(get_session),
) -> list[MovedDto]:
    """Copy files/folders into a folder (copy + paste, duplicate); clashing names get ` copy`."""
    project = await _project_or_404(session, project_id)
    srcs = [_safe_path(project, p) for p in dto.paths]
    try:
        done = copy_paths(srcs, _dest_dir(project, dto.dest_dir))
    except FileOpError as e:
        raise _file_op_http_error(e)
    except OSError as e:
        log.error("files_copy_failed", project_id=project_id, error=str(e))
        raise HTTPException(status_code=500, detail=str(e))
    return _moved_dtos(project, done)


@router.post("/{project_id}/files/upload", response_model=list[FileNode], status_code=201)
async def upload_files(
    project_id: int,
    dest_dir: str = Form(""),
    overwrite: bool = Form(False),
    files: list[UploadFile] = File(...),
    session: AsyncSession = Depends(get_session),
) -> list[FileNode]:
    """Files dropped in from the OS. A file's name may include folders (a dropped folder)."""
    project = await _project_or_404(session, project_id)
    root = Path(project.path).resolve()
    dest = _dest_dir(project, dest_dir)
    if not dest.is_dir():
        raise HTTPException(status_code=400, detail="destination is not a folder")
    try:
        targets = [upload_target(dest, f.filename or "") for f in files]
    except FileOpError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if any(not t.resolve().is_relative_to(root) for t in targets):
        raise HTTPException(status_code=400, detail="path escapes project root")
    if not overwrite:
        conflicts = [_rel(root, t) for t in targets if t.exists()]
        if conflicts:
            raise HTTPException(status_code=409, detail=f"already exists: {', '.join(conflicts)}")
    written: list[FileNode] = []
    for upload, target in zip(files, targets, strict=True):
        if target.is_dir():
            raise HTTPException(status_code=409, detail=f"'{_rel(root, target)}' is a folder")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(await upload.read())
        written.append(FileNode(name=target.name, path=_rel(root, target), is_dir=False))
    return written


def _reveal_command(path: Path) -> list[str]:
    if sys.platform == "darwin":
        return ["open", "-R", str(path)]
    if sys.platform.startswith("win"):
        return ["explorer", f"/select,{path}"]
    return ["xdg-open", str(path if path.is_dir() else path.parent)]


@router.post("/{project_id}/files/reveal", status_code=204)
async def reveal_file(
    project_id: int,
    dto: PathDto,
    session: AsyncSession = Depends(get_session),
) -> None:
    """Show a file in Finder / Explorer / the desktop file manager."""
    project = await _project_or_404(session, project_id)
    target = _safe_path(project, dto.path) if dto.path else Path(project.path).resolve()
    if not target.exists():
        raise HTTPException(status_code=404, detail="path not found")
    try:
        proc = await asyncio.create_subprocess_exec(*_reveal_command(target))
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"couldn't open the file manager: {e}")
    await proc.wait()


# ── Filesystem browser (not project-scoped) ─────────────────────────────────

fs_router = APIRouter(prefix="/api/filesystem", tags=["filesystem"])


def _browse_dir(abs_path: Path) -> list[FileNode]:
    """List one level of abs_path, returning dirs and .sh files only."""
    nodes: list[FileNode] = []
    try:
        entries = sorted(abs_path.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    except PermissionError:
        return []
    for entry in entries:
        if entry.is_dir() and entry.name in HIDDEN_DIRS:
            continue
        if entry.is_dir():
            nodes.append(FileNode(name=entry.name, path=str(entry), is_dir=True))
        elif entry.suffix.lower() == ".sh":
            nodes.append(FileNode(name=entry.name, path=str(entry), is_dir=False))
    return nodes


@fs_router.get("/browse", response_model=list[FileNode])
async def browse_filesystem(path: str = "") -> list[FileNode]:
    """Browse the local filesystem one level at a time. Returns dirs and .sh files.
    `path` must be an absolute path; defaults to the user's home directory."""
    if not path:
        target = Path.home()
    else:
        target = Path(path)
        if not target.is_absolute():
            raise HTTPException(status_code=400, detail="path must be absolute")
    target = target.resolve()
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="not a directory")
    return _browse_dir(target)
