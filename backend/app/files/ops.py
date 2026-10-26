"""Pure filesystem operations behind the Files page explorer (move, copy, upload).

Every function takes already-resolved absolute paths inside the project root;
the API layer does the root-escape checks. Multi-path operations validate
everything before touching the disk, so a conflict never leaves a half-done move.
"""
import shutil
from dataclasses import dataclass
from pathlib import Path

# Bytes sniffed to decide whether an unknown extension is text
_SNIFF_BYTES = 8192
MAX_TEXT_BYTES = 5 * 1024 * 1024


class FileOpError(Exception):
    """A request that can't be carried out as asked (bad target, would overwrite)."""


class FileConflictError(FileOpError):
    def __init__(self, names: list[str]) -> None:
        self.names = names
        super().__init__(f"already exists: {', '.join(names)}")


@dataclass(frozen=True)
class Moved:
    src: Path
    dst: Path


def _is_within(path: Path, ancestor: Path) -> bool:
    return path == ancestor or ancestor in path.parents


def _drop_nested(paths: list[Path]) -> list[Path]:
    """Moving a folder moves what's inside it — drop paths under another selected path."""
    unique = list(dict.fromkeys(paths))
    return [p for p in unique if not any(other != p and _is_within(p, other) for other in unique)]


def plan_move(srcs: list[Path], dest_dir: Path) -> list[Moved]:
    """Where each path lands when moved into dest_dir; raises before anything moves."""
    if not dest_dir.is_dir():
        raise FileOpError("destination is not a folder")
    plan: list[Moved] = []
    for src in _drop_nested(srcs):
        if not src.exists():
            raise FileOpError(f"'{src.name}' no longer exists")
        if src.is_dir() and _is_within(dest_dir, src):
            raise FileOpError(f"can't move '{src.name}' into itself")
        if src.parent == dest_dir:
            continue  # already there
        plan.append(Moved(src, dest_dir / src.name))
    targets = [m.dst.name for m in plan]
    if len(set(targets)) != len(targets):
        raise FileOpError("two selected items have the same name")
    conflicts = [m.dst.name for m in plan if m.dst.exists()]
    if conflicts:
        raise FileConflictError(conflicts)
    return plan


def move_paths(srcs: list[Path], dest_dir: Path) -> list[Moved]:
    plan = plan_move(srcs, dest_dir)
    for m in plan:
        shutil.move(str(m.src), str(m.dst))
    return plan


def copy_name(name: str, taken: set[str], is_dir: bool) -> str:
    """VS Code's duplicate naming: `orders.sql` → `orders copy.sql` → `orders copy 2.sql`."""
    if name not in taken:
        return name
    stem, suffix = (name, "") if is_dir else _split_ext(name)
    candidate = f"{stem} copy{suffix}"
    n = 2
    while candidate in taken:
        candidate = f"{stem} copy {n}{suffix}"
        n += 1
    return candidate


def _split_ext(name: str) -> tuple[str, str]:
    dot = name.rfind(".")
    if dot <= 0:  # no extension, or a dotfile like .gitignore
        return name, ""
    return name[:dot], name[dot:]


def copy_paths(srcs: list[Path], dest_dir: Path) -> list[Moved]:
    """Copy into dest_dir, never overwriting: clashing names get a ` copy` suffix."""
    if not dest_dir.is_dir():
        raise FileOpError("destination is not a folder")
    sources = _drop_nested(srcs)
    for src in sources:
        if not src.exists():
            raise FileOpError(f"'{src.name}' no longer exists")
        if src.is_dir() and _is_within(dest_dir, src):
            raise FileOpError(f"can't copy '{src.name}' into itself")
    taken = {p.name for p in dest_dir.iterdir()}
    done: list[Moved] = []
    for src in sources:
        dst = dest_dir / copy_name(src.name, taken, src.is_dir())
        taken.add(dst.name)
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        done.append(Moved(src, dst))
    return done


def upload_target(dest_dir: Path, relative_name: str) -> Path:
    """Where an uploaded file goes; `relative_name` may carry folders (a dropped folder)."""
    parts = [p for p in relative_name.replace("\\", "/").split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        raise FileOpError(f"invalid file name '{relative_name}'")
    return dest_dir.joinpath(*parts)


def is_text_file(path: Path, text_extensions: set[str]) -> bool:
    """Known text extensions, or small files without NUL bytes (Makefile, .sqlfluff, …)."""
    if path.suffix.lower() in text_extensions:
        return True
    try:
        if path.stat().st_size > MAX_TEXT_BYTES:
            return False
        with path.open("rb") as f:
            chunk = f.read(_SNIFF_BYTES)
    except OSError:
        return False
    if b"\x00" in chunk:
        return False
    try:
        chunk.decode("utf-8")
    except UnicodeDecodeError as e:
        # A multi-byte character cut off at the sniff boundary is still text
        return e.start >= len(chunk) - 3
    return True
