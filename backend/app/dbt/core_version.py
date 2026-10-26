"""Which dbt-core global setup installs: stable versions from PyPI for the
setup wizard's picker, and reading/pinning dbt-core in a requirements file.

The pure helpers are unit-tested in test_core_version.py; only
fetch_dbt_core_versions() touches the network.
"""
import re
import time

import httpx
from packaging.requirements import InvalidRequirement, Requirement
from packaging.version import InvalidVersion, Version

from app.logging_setup import get_logger

log = get_logger(__name__)

# app_settings key: the dbt-core version global setup installs when no global
# requirements file is set ("" / missing = latest)
DBT_CORE_VERSION_KEY = "dbt_core_version"

PYPI_URL = "https://pypi.org/pypi/dbt-core/json"
_CACHE_SECONDS = 3600
_TIMEOUT_SECONDS = 8.0
# dbt-core before 1.0 predates today's project format; not worth offering
_OLDEST_OFFERED = Version("1.0.0")

# A requirement line's project name (PEP 508), before any extras/specifier/marker
_REQ_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")

_cache: tuple[float, list[str]] | None = None


class VersionLookupError(Exception):
    """PyPI couldn't be reached or answered with something unusable."""


def is_valid_version(raw: str) -> bool:
    """An exact, final release number like 1.10.13."""
    try:
        v = Version(raw)
    except InvalidVersion:
        return False
    return not (v.is_prerelease or v.is_devrelease) and str(v) == raw


def install_spec(version: str) -> str:
    """The pip requirement for a chosen version ("" = latest)."""
    return f"dbt-core=={version}" if version else "dbt-core"


def stable_versions(pypi_json: dict) -> list[str]:
    """Final releases (no pre-releases, nothing fully yanked) newest first."""
    out: list[Version] = []
    for raw, files in (pypi_json.get("releases") or {}).items():
        try:
            v = Version(raw)
        except InvalidVersion:
            continue
        if v.is_prerelease or v.is_devrelease or v < _OLDEST_OFFERED:
            continue
        if not files or all(f.get("yanked") for f in files):
            continue
        out.append(v)
    return [str(v) for v in sorted(out, reverse=True)]


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def dbt_core_requirement(text: str) -> str | None:
    """The line that requires dbt-core (e.g. `dbt-core>=1.8`), or None if the
    file doesn't mention it. Comments and pip options (`-r`, `--index-url`) are skipped."""
    for line in text.splitlines():
        content = line.split(" #", 1)[0].split("\t#", 1)[0].strip()
        if not content or content.startswith(("#", "-")):
            continue
        m = _REQ_NAME.match(content)
        if m and _normalize(m.group(1)) == "dbt-core":
            return content
    return None


# `dbt --version`: dbt 1.x prints "Core:\n  - installed: 1.10.13" (older: "installed
# version: 1.0.0"); other builds print "dbt-core 1.10.13" / "dbt Core 1.10.13"
_INSTALLED_LINE = re.compile(r"installed(?: version)?:\s*v?(\d+\.\d+[\w.+-]*)", re.IGNORECASE)
_NAMED_VERSION = re.compile(r"dbt[- ](?:Core\s+|core\s+)?v?(\d+\.\d+[\w.+-]*)", re.IGNORECASE)


def parse_dbt_version(output: str) -> str | None:
    """dbt-core's installed version from `dbt --version` output, or None."""
    m = _INSTALLED_LINE.search(output) or _NAMED_VERSION.search(output)
    return m.group(1) if m else None


def requirement_satisfied(requirement: str, installed: str) -> bool | None:
    """Whether the installed dbt-core meets a requirement line (`dbt-core==1.10.13`,
    `dbt-core>=1.8`); None when the line sets no version (plain `dbt-core`) or
    either side can't be parsed — nothing to compare."""
    try:
        req = Requirement(requirement)
        version = Version(installed)
    except (InvalidRequirement, InvalidVersion):
        return None
    if not req.specifier:
        return None
    return req.specifier.contains(version, prereleases=True)


def append_pin(text: str, version: str) -> str:
    """The file's text with a `dbt-core==X` line added at the end."""
    prefix = text if not text or text.endswith("\n") else f"{text}\n"
    return f"{prefix}{install_spec(version)}\n"


async def fetch_dbt_core_versions() -> list[str]:
    """Stable dbt-core versions from PyPI, newest first; cached for an hour."""
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[0] < _CACHE_SECONDS:
        return _cache[1]
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.get(PYPI_URL)
            resp.raise_for_status()
            versions = stable_versions(resp.json())
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("dbt_core_versions_fetch_failed", error=str(exc))
        raise VersionLookupError(f"Couldn't reach PyPI to list dbt-core versions ({exc}).") from exc
    if not versions:
        raise VersionLookupError("PyPI returned no dbt-core releases.")
    _cache = (now, versions)
    return versions
