"""Where an export lands on disk: validated directory + filename → absolute path. Pure (only
stats the filesystem), so the API layer just maps ExportPathError to a 400."""

from pathlib import Path
from typing import Literal

ExportFormat = Literal["html", "svg", "png"]

MAX_FILENAME_LENGTH = 255
_FORBIDDEN_FILENAME_CHARS = ("/", "\\", "\0")


class ExportPathError(ValueError):
    def __init__(self, field: Literal["directory", "filename"], message: str) -> None:
        super().__init__(message)
        self.field = field
        self.message = message


def default_export_dir() -> Path:
    """~/Downloads when it exists, else the home directory."""
    home = Path.home()
    downloads = home / "Downloads"
    return downloads if downloads.is_dir() else home


def _clean_filename(filename: str, fmt: ExportFormat) -> str:
    name = filename.strip()
    if not name or name in (".", ".."):
        raise ExportPathError("filename", "Enter a file name.")
    if any(ch in name for ch in _FORBIDDEN_FILENAME_CHARS):
        raise ExportPathError("filename", "The file name can't contain slashes.")
    suffix = f".{fmt}"
    if not name.lower().endswith(suffix):
        name = f"{name}{suffix}"
    if len(name) > MAX_FILENAME_LENGTH:
        raise ExportPathError("filename", "The file name is too long.")
    return name


def _clean_directory(directory: str) -> Path:
    raw = directory.strip()
    if not raw:
        raise ExportPathError("directory", "Choose a folder to save to.")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ExportPathError("directory", "The folder must be an absolute path.")
    path = path.resolve()
    if not path.exists():
        raise ExportPathError("directory", f"Folder not found: {path}")
    if not path.is_dir():
        raise ExportPathError("directory", f"Not a folder: {path}")
    return path


def resolve_export_path(directory: str, filename: str, fmt: ExportFormat) -> Path:
    """The file to write. Adds the format's extension when the name lacks it."""
    return _clean_directory(directory) / _clean_filename(filename, fmt)
