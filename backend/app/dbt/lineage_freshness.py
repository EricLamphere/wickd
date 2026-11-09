"""Column lineage cache keys: when a saved snapshot is out of date, and which models a refresh must re-trace.

A snapshot is never keyed on manifest.json's mtime: dbt rewrites the file on nearly every
command, even when nothing changed. Instead:

- **Freshness** compares a per-node fingerprint of the current manifest with the one the
  snapshot was traced from. Each node's fingerprint is its metadata (name, relation, documented
  columns, parents, source file checksum) plus a hash of its compiled SQL. A selective command
  (`dbt run -s x`) strips compiled_code from every other node, so compiled SQL is compared only
  when both sides have it; when it's missing, the file checksum and the macros stand in for it.
- **Incremental refresh**: trace_job() is a pure function of its LineageJob, so a job whose key
  (its inputs) matches the previous snapshot's reuses that model's results instead of re-tracing.

Everything here is pure except tracer_key()'s one-time package hash and current_fingerprint()'s
memoized manifest read.
"""

import hashlib
import json
from dataclasses import dataclass, field
from functools import lru_cache
from importlib import metadata
from pathlib import Path
from typing import Any

from app.dbt.column_lineage import LineageJob


def _sha(value: Any) -> str:
    return hashlib.sha1(json.dumps(value, sort_keys=True, default=list).encode("utf-8")).hexdigest()


# ── tracer identity ───────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _engine_identity() -> str:
    """The installed wickd_pro's source (or version, in a frozen build without sources) plus sqlglot's version."""
    parts: list[str] = []
    try:
        import wickd_pro

        pkg_dir = Path(wickd_pro.__file__).parent
        digest = hashlib.sha1()
        for path in sorted(pkg_dir.rglob("*.py")):
            digest.update(path.relative_to(pkg_dir).as_posix().encode())
            digest.update(path.read_bytes())
        parts.append(digest.hexdigest())
    except (ImportError, OSError, TypeError):
        pass
    for dist in ("wickd-pro", "sqlglot"):
        try:
            parts.append(f"{dist}={metadata.version(dist)}")
        except metadata.PackageNotFoundError:
            parts.append(f"{dist}=none")
    return "|".join(parts)


def tracer_key(lineage_version: int) -> str:
    """Changes when the lineage engine or what a scan records changes, so old results aren't reused."""
    return _sha([lineage_version, _engine_identity()])


# ── manifest fingerprint (freshness) ──────────────────────────────────────────

@dataclass(frozen=True)
class Fingerprint:
    adapter: str
    macros: str
    # uid → [metadata hash, compiled SQL hash or None]
    nodes: dict[str, list[str | None]] = field(default_factory=dict)

    def to_json(self, tracer: str) -> str:
        return json.dumps({"tracer": tracer, "adapter": self.adapter, "macros": self.macros, "nodes": self.nodes})


def _node_meta(uid: str, raw: dict, parents: list[str]) -> str:
    checksum = raw.get("checksum")
    return _sha([
        raw.get("resource_type"),
        raw.get("name") or uid.split(".")[-1],
        raw.get("relation_name") or "",
        sorted((raw.get("columns") or {}).keys()),
        sorted(parents),
        checksum.get("checksum") if isinstance(checksum, dict) else None,
    ])


def manifest_fingerprint(manifest: dict) -> Fingerprint:
    parent_map: dict = manifest.get("parent_map") or {}
    raw_nodes: dict = {**(manifest.get("nodes") or {}), **(manifest.get("sources") or {})}
    nodes: dict[str, list[str | None]] = {}
    for uid, raw in raw_nodes.items():
        if not isinstance(raw, dict):
            continue
        code = raw.get("compiled_code") or raw.get("compiled_sql")
        nodes[uid] = [
            _node_meta(uid, raw, list(parent_map.get(uid) or [])),
            hashlib.sha1(code.encode("utf-8")).hexdigest() if code else None,
        ]
    macros = sorted(
        (uid, (m or {}).get("macro_sql") or "") for uid, m in (manifest.get("macros") or {}).items()
    )
    return Fingerprint(
        adapter=str((manifest.get("metadata") or {}).get("adapter_type") or ""),
        macros=_sha(macros),
        nodes=nodes,
    )


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"


def stale_reason(stored_json: str | None, current: Fingerprint, tracer: str) -> str | None:
    """Why a snapshot traced from `stored_json` no longer matches the current manifest, or None if it does."""
    try:
        stored = json.loads(stored_json or "")
    except ValueError:
        stored = None
    if not isinstance(stored, dict) or not isinstance(stored.get("nodes"), dict):
        return "Loaded before wickd tracked changes; refresh once to enable it."
    if stored.get("tracer") != tracer:
        return "wickd's lineage engine was updated since this was loaded."
    if stored.get("adapter") != current.adapter:
        return "The project's adapter changed."

    old: dict = stored["nodes"]
    added = current.nodes.keys() - old.keys()
    removed = old.keys() - current.nodes.keys()
    if added or removed:
        bits = [f"{_plural(len(added), 'node')} added"] if added else []
        bits += [f"{_plural(len(removed), 'node')} removed"] if removed else []
        return f"{' and '.join(bits).capitalize()} since this was loaded."

    changed = 0
    code_unknown = False
    for uid, (meta, code) in current.nodes.items():
        old_meta, old_code = (list(old[uid]) + [None, None])[:2]
        if meta != old_meta or (code is not None and old_code is not None and code != old_code):
            changed += 1
        elif code is None and old_code is not None:
            code_unknown = True
    if changed:
        return f"{_plural(changed, 'node')} changed since this was loaded."
    if code_unknown and stored.get("macros") != current.macros:
        return "Macros changed since this was loaded."
    return None


# ── per-job keys (incremental refresh) ────────────────────────────────────────

def job_key(job: LineageJob, tracer: str) -> str:
    """Hash of everything trace_job() reads. name_to_uid covers the whole project, so only the names
    the job could resolve (its parents, or any name appearing in its SQL) count — a model added
    elsewhere doesn't invalidate it."""
    sql_lower = job.sql.lower()
    parents = {p.lower() for p in job.parent_short_names}
    names = sorted(
        (name, uid) for name, uid in job.name_to_uid.items()
        if name.lower() in parents or name.lower() in sql_lower
    )
    return _sha([
        tracer, job.uid, list(job.columns), job.sql, job.dialect, list(job.parent_short_names),
        sorted(job.sources.items()), sorted((k, list(v)) for k, v in job.parent_columns.items()), names,
    ])


@dataclass(frozen=True)
class JobPlan:
    keys: dict[str, str]
    to_trace: list[LineageJob]
    reused: list[str]


def plan_jobs(jobs: list[LineageJob], tracer: str, previous_keys: dict[str, str]) -> JobPlan:
    """Split jobs into those whose inputs match the previous scan (reuse its results) and those to trace."""
    keys = {job.uid: job_key(job, tracer) for job in jobs}
    reused = [job.uid for job in jobs if previous_keys.get(job.uid) == keys[job.uid]]
    reused_set = set(reused)
    return JobPlan(keys=keys, to_trace=[j for j in jobs if j.uid not in reused_set], reused=reused)


def carry_over(previous: dict, uids: list[str]) -> dict:
    """The previous scan's entries for the reused models (models with no entry had none)."""
    return {uid: previous[uid] for uid in uids if uid in previous}


# ── memoized current fingerprint ──────────────────────────────────────────────

_memo: dict[str, tuple[tuple[int, int], Fingerprint]] = {}


def current_fingerprint(manifest_path: Path) -> Fingerprint | None:
    """The manifest's fingerprint, recomputed only when the file changes. None if it can't be read.
    Blocking (reads and parses the manifest): call it from a thread."""
    try:
        stat = manifest_path.stat()
    except OSError:
        return None
    stamp = (stat.st_mtime_ns, stat.st_size)
    key = str(manifest_path)
    cached = _memo.get(key)
    if cached is not None and cached[0] == stamp:
        return cached[1]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(manifest, dict):
        return None
    fingerprint = manifest_fingerprint(manifest)
    _memo[key] = (stamp, fingerprint)
    return fingerprint
