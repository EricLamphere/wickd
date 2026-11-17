"""dbt Hub client: the package index, each package's versions (with their
`require_dbt_version`), and README text — cached on disk under `<data_dir>/hub/` for a day.

The Hub API is undocumented, so everything fails soft: a fetch that fails falls back to
a stale cache, else None ("unknown" in the UI). Parsing is pure and unit-tested in
test_hub.py (fetching with a stubbed httpx transport).
"""
import asyncio
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import settings
from app.dbt.package_versions import as_clauses, latest_compatible, newest, parse_version
from app.logging_setup import get_logger

log = get_logger(__name__)

HUB_API = "https://hub.getdbt.com/api/v1"
CACHE_SECONDS = 24 * 3600
TIMEOUT_SECONDS = 8.0
SEARCH_LIMIT = 50
README_MAX_BYTES = 512 * 1024
README_HOSTS = frozenset({"raw.githubusercontent.com"})
_NAME = re.compile(r"^[A-Za-z0-9_.-]+$")
_GITHUB_REPO = re.compile(r"github\.com[/:]([^/]+)/([^/#?]+?)(?:\.git)?(?:/|$)", re.IGNORECASE)

# tests swap in an httpx.MockTransport
transport: httpx.AsyncBaseTransport | None = None
_locks: dict[str, asyncio.Lock] = {}


@dataclass(frozen=True)
class HubVersion:
    version: str
    require_dbt_version: tuple[str, ...]
    published_at: str | None
    readme_url: str | None


@dataclass(frozen=True)
class HubPackage:
    namespace: str
    name: str
    description: str
    latest: str | None  # newest stable release
    versions: tuple[HubVersion, ...]  # newest first
    repo_url: str | None  # https://github.com/<owner>/<repo>

    @property
    def full_name(self) -> str:
        return f"{self.namespace}/{self.name}"

    def requires(self) -> dict[str, tuple[str, ...]]:
        return {v.version: v.require_dbt_version for v in self.versions}

    def latest_compatible(self, dbt_version: str | None) -> str | None:
        return latest_compatible(self.requires(), dbt_version)

    def version(self, version: str | None) -> HubVersion | None:
        return next((v for v in self.versions if v.version == version), None)


def valid_name(full_name: str) -> bool:
    parts = full_name.split("/")
    return len(parts) == 2 and all(_NAME.match(p) for p in parts)


def _repo_from_source(url: str | None) -> str | None:
    m = _GITHUB_REPO.search(url or "")
    return f"https://github.com/{m.group(1)}/{m.group(2)}" if m else None


def parse_package(raw: dict[str, Any]) -> HubPackage | None:
    """A Hub `/api/v1/<ns>/<name>.json` body; None when it doesn't look like one."""
    if not isinstance(raw, dict) or not raw.get("name") or not isinstance(raw.get("versions"), dict):
        return None
    versions: list[HubVersion] = []
    repo: str | None = None
    for key, item in raw["versions"].items():
        if not isinstance(item, dict) or parse_version(key) is None:
            continue
        source = item.get("_source") or {}
        repo = repo or _repo_from_source(source.get("url"))
        versions.append(HubVersion(
            version=str(item.get("version") or key),
            require_dbt_version=as_clauses(item.get("require_dbt_version")),
            published_at=item.get("published_at") if not str(item.get("published_at", "")).startswith("1970") else None,
            readme_url=source.get("readme"),
        ))
    versions.sort(key=lambda v: parse_version(v.version), reverse=True)  # type: ignore[arg-type,return-value]
    return HubPackage(
        namespace=str(raw.get("namespace") or ""),
        name=str(raw["name"]),
        description=str(raw.get("description") or ""),
        latest=newest(v.version for v in versions),
        versions=tuple(versions),
        repo_url=repo,
    )


def search(index: list[str], query: str, limit: int = SEARCH_LIMIT) -> list[str]:
    """Index names matching `query`: exact name first, then name prefix, then substring."""
    q = query.strip().lower()
    if not q:
        return sorted(index, key=str.lower)[:limit]

    def rank(full: str) -> tuple[int, str] | None:
        lower = full.lower()
        name = lower.rsplit("/", 1)[-1]
        if q in (lower, name):
            return (0, lower)
        if name.startswith(q) or lower.startswith(q):
            return (1, lower)
        if q in lower or q.replace(" ", "_") in lower:
            return (2, lower)
        return None

    ranked = sorted((r, full) for full in index if (r := rank(full)) is not None)
    return [full for _, full in ranked[:limit]]


def hub_candidates_for_git(url: str) -> list[str]:
    """Hub names a GitHub-hosted package might be published under (owner/repo, - → _)."""
    m = _GITHUB_REPO.search(url)
    if not m:
        return []
    owner, repo = m.group(1), m.group(2)
    names = [repo.replace("-", "_"), repo]
    for prefix in ("dbt-", "dbt_"):
        if repo.startswith(prefix):
            names.append(repo[len(prefix):].replace("-", "_"))
    return list(dict.fromkeys(f"{owner}/{n}" for n in names))


def same_repo(a: str | None, b: str | None) -> bool:
    ma, mb = _GITHUB_REPO.search(a or ""), _GITHUB_REPO.search(b or "")
    return bool(ma and mb) and (ma.group(1).lower(), ma.group(2).lower()) == (mb.group(1).lower(), mb.group(2).lower())


# ── Disk cache + fetching ────────────────────────────────────────────────────


def cache_dir() -> Path:
    return settings.data_dir / "hub"


def _cache_file(key: str) -> Path:
    return cache_dir() / (re.sub(r"[^A-Za-z0-9_.-]", "__", key) + ".json")


def _read_cache(key: str) -> tuple[float, Any] | None:
    path = _cache_file(key)
    try:
        return path.stat().st_mtime, json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_cache(key: str, value: Any) -> None:
    path = _cache_file(key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(value), encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        log.warning("hub_cache_write_failed", key=key, error=str(exc))


async def _get_json(url: str) -> tuple[int, Any]:
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=transport, follow_redirects=True) as client:
        resp = await client.get(url)
        if resp.status_code == 404:
            return 404, None
        resp.raise_for_status()
        return resp.status_code, resp.json()


async def _cached(key: str, url: str) -> Any:
    """The JSON at `url`, from the cache while it's fresh; a 404 is cached as None."""
    async with _locks.setdefault(key, asyncio.Lock()):
        hit = await asyncio.to_thread(_read_cache, key)
        if hit is not None and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1].get("data")
        try:
            status, data = await _get_json(url)
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("hub_fetch_failed", url=url, error=str(exc))
            return hit[1].get("data") if hit is not None else None  # stale beats nothing
        await asyncio.to_thread(_write_cache, key, {"data": data, "status": status})
        return data


async def fetch_index() -> list[str] | None:
    """Every Hub package as `namespace/name`; None when the Hub can't be reached."""
    data = await _cached("index", f"{HUB_API}/index.json")
    return [str(n) for n in data if isinstance(n, str)] if isinstance(data, list) else None


async def fetch_package(full_name: str) -> HubPackage | None:
    if not valid_name(full_name):
        return None
    data = await _cached(f"pkg_{full_name}", f"{HUB_API}/{full_name}.json")
    return parse_package(data) if isinstance(data, dict) else None


async def fetch_for_git(url: str) -> HubPackage | None:
    """The Hub package a GitHub-hosted git package is published as, if any."""
    for candidate in hub_candidates_for_git(url):
        pkg = await fetch_package(candidate)
        if pkg is not None and (pkg.repo_url is None or same_repo(pkg.repo_url, url)):
            return pkg
    return None


def readme_url_allowed(url: str | None) -> bool:
    if not url:
        return False
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname in README_HOSTS


async def fetch_readme(url: str) -> str | None:
    """A package README (raw GitHub only), cached like the rest; None on failure."""
    if not readme_url_allowed(url):
        return None
    key = f"readme_{url.removeprefix('https://raw.githubusercontent.com/')}"
    async with _locks.setdefault(key, asyncio.Lock()):
        hit = await asyncio.to_thread(_read_cache, key)
        if hit is not None and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1].get("data")
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=transport) as client:
                resp = await client.get(url)
                if resp.status_code == 404:
                    text = None
                else:
                    resp.raise_for_status()
                    text = resp.content[:README_MAX_BYTES].decode("utf-8", errors="replace")
        except httpx.HTTPError as exc:
            log.warning("hub_readme_failed", url=url, error=str(exc))
            return hit[1].get("data") if hit is not None else None
        await asyncio.to_thread(_write_cache, key, {"data": text})
        return text
