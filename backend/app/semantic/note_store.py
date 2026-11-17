"""Metric notes on disk (plan 30): `<NOTES_PATH>/<slug>.md`, images in `<NOTES_IMG_PATH>`.

Both folders are project settings (ProjectEnvVars), default `wickd/notes` and `wickd/img`,
and always inside the project. A file that doesn't parse is listed with its error, like a
dashboard. Writes go through a temp file + rename. Images are named `<slug>-<n>.<ext>` and
referenced from a note relative to the notes folder (`../img/outage-1.png`).
"""

import os
from dataclasses import dataclass
from pathlib import Path

from app.semantic import notes
from app.semantic.notes import Note, NoteError

SETTING_KEY = "NOTES_PATH"
IMG_SETTING_KEY = "NOTES_IMG_PATH"
DEFAULT_DIR = "wickd/notes"
DEFAULT_IMG_DIR = "wickd/img"
SUFFIX = ".md"
MAX_FILE_BYTES = 1024 * 1024
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_NOTES = 2000

# Images a note may show. SVG is served (inert) but never uploaded: it can carry script.
IMAGE_TYPES: dict[str, str] = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml",
}


@dataclass(frozen=True)
class Folders:
    notes: Path
    images: Path
    project: Path


@dataclass(frozen=True)
class NoteEntry:
    """One file in the notes folder: the note, or why it couldn't be read."""

    slug: str
    path: str  # relative to the project root (posix)
    note: Note | None
    error: str | None
    mtime: float


def _inside(project_path: Path, setting: str | None, default: str, key: str) -> Path:
    root = project_path.resolve()
    rel = (setting or "").strip() or default
    path = (root / rel).resolve()
    if not path.is_relative_to(root) or path == root:
        raise NoteError("bad_path", f"{key} must be a folder inside the project ({rel})", key)
    return path


def folders(project_path: Path, notes_setting: str | None, img_setting: str | None) -> Folders:
    return Folders(
        notes=_inside(project_path, notes_setting, DEFAULT_DIR, SETTING_KEY),
        images=_inside(project_path, img_setting, DEFAULT_IMG_DIR, IMG_SETTING_KEY),
        project=project_path.resolve(),
    )


def relative(f: Folders, path: Path) -> str:
    return path.relative_to(f.project).as_posix()


def _entry(f: Folders, path: Path) -> NoteEntry:
    note: Note | None = None
    error: str | None = None
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            raise NoteError("too_large", "the file is too large to be a note")
        note = notes.parse(path.read_text(encoding="utf-8"))
    except NoteError as exc:
        error = exc.message
    except (OSError, UnicodeDecodeError) as exc:
        error = f"couldn't read the file: {exc}"
    mtime = path.stat().st_mtime if path.exists() else 0.0
    return NoteEntry(slug=path.stem, path=relative(f, path), note=note, error=error, mtime=mtime)


def _note_files(f: Folders) -> list[Path]:
    if not f.notes.is_dir():
        return []
    files = (p for p in f.notes.iterdir() if p.is_file() and p.suffix == SUFFIX and notes.is_slug(p.stem))
    return sorted(files, key=lambda p: p.stem)[:MAX_NOTES]


def list_notes(f: Folders) -> list[NoteEntry]:
    return [_entry(f, p) for p in _note_files(f)]


def file_for(f: Folders, slug: str) -> Path:
    return f.notes / f"{notes.check_slug(slug)}{SUFFIX}"


def read(f: Folders, slug: str) -> NoteEntry:
    path = file_for(f, slug)
    if not path.is_file():
        raise NoteError("not_found", f"there's no note `{slug}`")
    return _entry(f, path)


def _write_atomic(path: Path, data: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.wickd-tmp")
    try:
        if isinstance(data, bytes):
            tmp.write_bytes(data)
        else:
            tmp.write_text(data, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def unique_slug(f: Folders, title: str) -> str:
    taken = {p.stem for p in f.notes.glob(f"*{SUFFIX}")} if f.notes.is_dir() else set()
    return notes.unique_slug(notes.slugify(title), taken)


def write(f: Folders, slug: str, note: Note, *, create: bool = False) -> NoteEntry:
    path = file_for(f, slug)
    if create and path.exists():
        raise NoteError("exists", f"a note named `{slug}` already exists")
    if not create and not path.is_file():
        raise NoteError("not_found", f"there's no note `{slug}`")
    _write_atomic(path, notes.render(note))
    return _entry(f, path)


# ── images ───────────────────────────────────────────────────────────────────


def resolve_ref(f: Folders, ref: str) -> Path | None:
    """A body's image reference (relative to the notes folder) as a file inside the image or notes
    folder, or None when it points anywhere else."""
    cleaned = (ref or "").split("#")[0].split("?")[0].replace("\\", "/").strip()
    if not cleaned or cleaned.startswith("/") or "\x00" in cleaned:
        return None
    target = (f.notes / cleaned).resolve()
    if not (target.is_relative_to(f.images) or target.is_relative_to(f.notes)) or target in (f.images, f.notes):
        return None
    return target


def asset(f: Folders, ref: str) -> tuple[Path, str]:
    """The image file a note shows, and its content type. Refuses anything outside the folders."""
    target = resolve_ref(f, ref)
    if target is None:
        raise NoteError("bad_path", "images must be in the notes or note images folder")
    content_type = IMAGE_TYPES.get(target.suffix.lower())
    if content_type is None:
        raise NoteError("not_image", "only images can be served")
    if not target.is_file():
        raise NoteError("not_found", "image not found")
    return target, content_type


def sniff_image(data: bytes) -> str | None:
    """The extension for PNG / JPEG / GIF / WebP bytes, else None (the upload's name isn't trusted)."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


def save_image(f: Folders, name: str, data: bytes) -> str:
    """Store an uploaded image as `<slug>-<n>.<ext>`; returns its path relative to the notes folder."""
    if len(data) > MAX_IMAGE_BYTES:
        raise NoteError("too_large", f"images may be at most {MAX_IMAGE_BYTES // (1024 * 1024)} MB")
    ext = sniff_image(data)
    if ext is None:
        raise NoteError("not_image", "only PNG, JPEG, GIF and WebP images can be added")
    base = notes.slugify(name)
    n = 1
    while any((f.images / f"{base}-{n}{e}").exists() for e in (".png", ".jpg", ".gif", ".webp")):
        n += 1
    path = f.images / f"{base}-{n}{ext}"
    _write_atomic(path, data)
    return Path(os.path.relpath(path, f.notes)).as_posix()


def _referenced(f: Folders, entry: NoteEntry) -> set[Path]:
    if entry.note is None:
        return set()
    return {p for p in (resolve_ref(f, r) for r in notes.image_refs(entry.note.body)) if p is not None}


def images_only_in(f: Folders, slug: str) -> list[Path]:
    """Images the note references that no other note does (what deleting it may remove)."""
    entries = list_notes(f)
    mine = next((e for e in entries if e.slug == slug), None)
    if mine is None:
        return []
    others: set[Path] = set()
    for e in entries:
        if e.slug != slug:
            others |= _referenced(f, e)
    return sorted(p for p in _referenced(f, mine) - others if p.is_relative_to(f.images) and p.is_file())


def delete(f: Folders, slug: str, *, remove_images: bool = False) -> list[str]:
    """Delete the note (and, if asked, the images only it uses); returns the removed images."""
    path = file_for(f, slug)
    if not path.is_file():
        raise NoteError("not_found", f"there's no note `{slug}`")
    orphans = images_only_in(f, slug) if remove_images else []
    path.unlink()
    for image in orphans:
        image.unlink(missing_ok=True)
    return [relative(f, p) for p in orphans]
