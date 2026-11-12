"""The dbt projects path setting: one folder, or several separated by commas.

Every folder is scanned for projects as if they all sat in one folder; the
first one is where new projects are created.
"""

from pathlib import Path

SEPARATOR = ","


def parse_workspaces(raw: str | Path | None) -> list[Path]:
    """Split a projects path setting into folders: trimmed, ``~`` expanded,
    blanks and duplicates dropped, and a folder inside another listed folder
    dropped too, so no project is discovered twice. Order is kept."""
    if raw is None:
        return []
    unique: list[Path] = []
    for part in str(raw).split(SEPARATOR):
        text = part.strip()
        if not text:
            continue
        path = Path(text).expanduser()
        if path not in unique:
            unique.append(path)
    return [p for p in unique if not any(p != other and p.is_relative_to(other) for other in unique)]
