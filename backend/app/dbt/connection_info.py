"""Which warehouse a dbt target connects to, from `dbt debug --target <t>`.

dbt debug prints a "Connection:" block with the adapter's own non-secret connection keys
(host / account / path / …, env_var() already rendered, never passwords or tokens). Data diff
compares two targets' blocks to tell whether a relation name means the same table on both
connections. Only keys that identify the warehouse instance are compared — database and schema
differ between dev and prod by design and are reachable across within one instance.

Cached per (project, target) until profiles.yml or the env vars wickd layers in change.
"""

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

from app.dbt.debug_parser import parse_debug_output
from app.dbt.runner import RunRequest, runner
from app.logging_setup import get_logger

log = get_logger(__name__)

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_TIMESTAMP = re.compile(r"^\s*\d{2}:\d{2}:\d{2}(?:\.\d+)?\s?")
_KEY_LINE = re.compile(r"^\s{2,}([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$")
# keys that say which warehouse instance a connection reaches (anything else lives inside one)
INSTANCE_KEYS = ("host", "port", "account", "path", "server", "region_name", "cluster_id", "endpoint")


@dataclass(frozen=True)
class TargetConnection:
    target: str
    adapter_type: str | None
    fields: dict[str, str] = field(default_factory=dict)
    connected: bool = False
    error: str | None = None

    @property
    def instance(self) -> dict[str, str]:
        return {k: v for k, v in self.fields.items() if k in INSTANCE_KEYS and v not in ("", "None")}


def parse_connection_block(text: str) -> dict[str, str]:
    """The key: value lines under "Connection:" in dbt debug output."""
    found: dict[str, str] = {}
    inside = False
    for raw in _ANSI.sub("", text).splitlines():
        line = _TIMESTAMP.sub("", raw)
        if line.strip() == "Connection:":
            inside = True
            continue
        if not inside:
            continue
        m = _KEY_LINE.match(line)
        if not m:
            if found:
                break
            continue
        found[m.group(1)] = m.group(2).strip()
    return found


def same_instance(a: TargetConnection, b: TargetConnection) -> bool | None:
    """True / False when the instance keys say so; None when neither target has any (e.g.
    BigQuery, whose names are global) and only a read can tell."""
    ia, ib = a.instance, b.instance
    if not ia and not ib:
        return None
    keys = set(ia) | set(ib)
    return all(ia.get(k, "").lower() == ib.get(k, "").lower() for k in keys)


_cache: dict[tuple[int, str], tuple[str, TargetConnection]] = {}


def _fingerprint(project_path: Path, env: dict[str, str]) -> str:
    stamps = []
    for path in (project_path / "profiles.yml", Path(env.get("DBT_PROFILES_DIR", "~/.dbt")).expanduser() / "profiles.yml"):
        try:
            stamps.append(f"{path}:{path.stat().st_mtime_ns}")
        except OSError:
            stamps.append(f"{path}:-")
    payload = "|".join(stamps) + "|" + "|".join(f"{k}={v}" for k, v in sorted(env.items()) if k != "DBT_TARGET")
    return hashlib.sha1(payload.encode()).hexdigest()


async def target_connection(project_id: int, project_path: Path, target: str, env: dict[str, str]) -> TargetConnection:
    fp = _fingerprint(project_path, env)
    cached = _cache.get((project_id, target))
    if cached and cached[0] == fp:
        return cached[1]
    req = RunRequest(project_id=project_id, project_path=project_path, command="debug",
                     extra=("--target", target), env=env)
    code, stdout, stderr = await runner.run(req)
    text = stdout.decode(errors="replace") + "\n" + stderr.decode(errors="replace")
    parsed = parse_debug_output(text)
    conn = next((c for c in parsed.checks if c.key == "connection"), None)
    connected = code == 0 and (conn is None or conn.status == "ok")
    info = TargetConnection(
        target=target, adapter_type=parsed.adapter_name, fields=parse_connection_block(text), connected=connected,
        error=None if connected else (conn.detail if conn and conn.detail else f"dbt debug --target {target} failed"),
    )
    if connected:
        _cache[(project_id, target)] = (fp, info)
    log.info("target_connection", project_id=project_id, target=target, adapter=info.adapter_type,
             instance_keys=sorted(info.instance), connected=connected)
    return info
