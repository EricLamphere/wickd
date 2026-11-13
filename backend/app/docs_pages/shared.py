"""Shared docs folders: Markdown folders outside any dbt project, shown in combined docs.

WICKD_SHARED_DOCS_PATHS (app setting `shared_docs_paths`) is a comma-separated list of
folders, e.g. a team's central `dbt/docs` next to `dbt/projects/`. Their pages join the
home page's combined docs Pages tab. A folder is addressed by its position in the list.
Path helpers plus `load_setting()`.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import AppSetting
from app.docs_pages.service import DocsPagesError

SETTING_KEY = "shared_docs_paths"
ENV_NAME = "WICKD_SHARED_DOCS_PATHS"
MAX_FOLDERS = 20


@dataclass(frozen=True)
class SharedFolder:
    id: int  # position in the setting
    name: str  # short label: "<parent>/<folder>"
    path: Path  # resolved


def split_paths(raw: str | None) -> list[str]:
    """The setting's entries, trimmed, blanks dropped."""
    return [part.strip() for part in (raw or "").split(",") if part.strip()]


def _resolve(entry: str) -> Path:
    return Path(entry).expanduser().resolve()


def folder_label(path: Path) -> str:
    return f"{path.parent.name}/{path.name}" if path.parent.name else path.name or str(path)


def normalize_setting(raw: str) -> str:
    """Validate a new value; returns it re-joined with ", ". Raises DocsPagesError."""
    entries = split_paths(raw)
    if len(entries) > MAX_FOLDERS:
        raise DocsPagesError("too_many", f"{ENV_NAME} takes at most {MAX_FOLDERS} folders")
    for entry in entries:
        if not Path(entry).expanduser().is_absolute():
            raise DocsPagesError("bad_path", f"{ENV_NAME} folders must be absolute paths ({entry})")
        if not _resolve(entry).is_dir():
            raise DocsPagesError("not_found", f"{ENV_NAME} folder not found: {entry}")
    return ", ".join(entries)


def shared_folders(raw: str | None) -> list[SharedFolder]:
    """Every configured folder that exists now. Ids stay the setting positions, so a missing
    folder doesn't shift the ones after it."""
    folders: list[SharedFolder] = []
    for index, entry in enumerate(split_paths(raw)[:MAX_FOLDERS]):
        path = Path(entry).expanduser()
        if not path.is_absolute():
            continue
        resolved = path.resolve()
        if resolved.is_dir():
            folders.append(SharedFolder(index, folder_label(resolved), resolved))
    return folders


def find_folder(raw: str | None, folder_id: int) -> SharedFolder:
    for folder in shared_folders(raw):
        if folder.id == folder_id:
            return folder
    raise DocsPagesError("no_docs_dir", "shared docs folder not found")


async def load_setting(session: AsyncSession) -> str:
    """The saved setting, else the WICKD_SHARED_DOCS_PATHS env var ('' = none)."""
    row = await session.get(AppSetting, SETTING_KEY)
    if row is not None:
        return row.value
    return settings.shared_docs_paths or ""
