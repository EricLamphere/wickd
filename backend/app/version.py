"""wickd's own version, for GET /api/app/info (plan 32).

The release skill bumps `backend/pyproject.toml` with every release. From source that
file is read directly (an editable install's metadata keeps the version it was installed
with); the packaged app has no pyproject.toml, so it reads the package metadata that
packaging/wickd.spec bundles with `copy_metadata`.
"""

import tomllib
from functools import cache
from importlib import metadata
from pathlib import Path

PACKAGE = "wickd-backend"
_PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def _from_pyproject(path: Path) -> str:
    try:
        return str(tomllib.loads(path.read_text())["project"]["version"])
    except (OSError, KeyError, tomllib.TOMLDecodeError):
        return ""


def _from_metadata() -> str:
    try:
        return metadata.version(PACKAGE)
    except metadata.PackageNotFoundError:
        return ""


@cache
def app_version() -> str:
    """The running wickd version, or "" when neither source can be read."""
    return _from_pyproject(_PYPROJECT) or _from_metadata()
