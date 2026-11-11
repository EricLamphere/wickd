"""Finding and reading a project's Markdown docs pages. Pure filesystem helpers, no DB.

The folder is DOCS_PATH (relative to the dbt project root). Unset, it is the project's
`docs/`, else the git repo root's `docs/` (monorepos keep docs beside the dbt project).
Every path a request names is resolved through `safe_join`, which refuses anything that
lands outside the folder (`..`, absolute paths, symlinks pointing out).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from app.docs_pages.blocks import classify

SETTING_KEY = "DOCS_PATH"
DEFAULT_DIR = "docs"
PAGE_SUFFIXES = frozenset({".md", ".markdown"})
IMAGE_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}
MAX_PAGE_BYTES = 1024 * 1024
MAX_PAGES = 2000
_SKIPPED_DIRS = frozenset({"node_modules", "dbt_packages", "__pycache__", "site-packages", "venv", "target", "logs"})
_HEADING = re.compile(r"^#\s+(.+?)\s*#*\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")


class DocsPagesError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class PageInfo:
    path: str  # relative to the docs folder, posix
    title: str
    folder: str  # parent folder relative to the docs folder ('' at the top)


def resolve_docs_dir(project_path: Path, repo_root: Path | None, setting: str | None) -> Path | None:
    """The docs folder, or None when there isn't one. A set DOCS_PATH must stay inside the repo."""
    root = project_path.resolve()
    boundary = (repo_root or project_path).resolve()
    rel = (setting or "").strip()
    if rel:
        path = (root / rel).resolve()
        if not path.is_relative_to(boundary):
            raise DocsPagesError("bad_path", f"{SETTING_KEY} must be inside the project or its git repo ({rel})")
        return path if path.is_dir() else None
    candidates = [root / DEFAULT_DIR]
    if repo_root is not None:
        candidates.append(boundary / DEFAULT_DIR)
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved.is_dir() and resolved.is_relative_to(boundary):
            return resolved
    return None


def safe_join(base: Path, rel: str) -> Path:
    """`base / rel`, refusing paths that escape `base` (including through symlinks)."""
    cleaned = (rel or "").replace("\\", "/").strip()
    if not cleaned or cleaned.startswith("/") or "\x00" in cleaned:
        raise DocsPagesError("bad_path", "path must be relative to the docs folder")
    root = base.resolve()
    target = (root / cleaned).resolve()
    if not target.is_relative_to(root) or target == root:
        raise DocsPagesError("bad_path", "path is outside the docs folder")
    return target


def page_title(text: str, fallback: str) -> str:
    """The first top-level `# ` heading outside code fences, else the fallback."""
    in_fence = False
    for line in text.splitlines():
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = _HEADING.match(line)
        if match:
            return match.group(1).strip()
    return fallback


def _is_hidden(name: str) -> bool:
    return name.startswith((".", "_"))


def read_page_text(path: Path) -> str:
    if path.suffix.lower() not in PAGE_SUFFIXES:
        raise DocsPagesError("not_page", "only Markdown files are pages")
    if not path.is_file():
        raise DocsPagesError("not_found", "page not found")
    if path.stat().st_size > MAX_PAGE_BYTES:
        raise DocsPagesError("too_large", "page is larger than 1 MB")
    return path.read_text(encoding="utf-8", errors="replace")


def list_pages(docs_dir: Path) -> list[PageInfo]:
    """Markdown pages under the folder, sorted by path. Files holding only docs blocks are left out."""
    root = docs_dir.resolve()
    pages: list[PageInfo] = []
    for current, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not _is_hidden(d) and d not in _SKIPPED_DIRS)
        for name in sorted(files):
            path = Path(current) / name
            if _is_hidden(name) or path.suffix.lower() not in PAGE_SUFFIXES:
                continue
            if not path.resolve().is_relative_to(root):
                continue  # symlink out of the folder
            try:
                text = read_page_text(path)
            except (DocsPagesError, OSError):
                continue
            if classify(text) == "blocks_only":
                continue
            rel = path.relative_to(root)
            parent = rel.parent.as_posix()
            pages.append(PageInfo(rel.as_posix(), page_title(text, path.stem), "" if parent == "." else parent))
            if len(pages) >= MAX_PAGES:
                return pages
    return pages


def image_type(path: Path) -> str:
    content_type = IMAGE_TYPES.get(path.suffix.lower())
    if content_type is None:
        raise DocsPagesError("not_image", "only images can be served")
    return content_type


def relative_to_project(project_path: Path, path: Path) -> str:
    """A posix path relative to the project root ('../docs' for a repo-root folder)."""
    return Path(os.path.relpath(path, project_path.resolve())).as_posix()
