"""MetricFlow for one project: where its semantic manifest is, which dialect, and the worker calls.

Reads `<project>/<target-path>/semantic_manifest.json` itself, so a custom `target-path`
in dbt_project.yml works (the `mf` CLI hard-codes `target/`).
"""

import asyncio
import hashlib
import json
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import yaml

from app.dbt.core_version import parse_dbt_version
from app.dbt.semantic_nodes import SEMANTIC_SECTIONS
from app.dbt.venv import _python_version_info, existing_bin
from app.logging_setup import get_logger
from app.semantic import compat
from app.semantic.runtime import WorkerRequestError, metricflow_runtime
from app.semantic.sidecar_env import ENGINE_VERSION

log = get_logger(__name__)

DEFAULT_TARGET = "target"
EXPLAIN_TIMEOUT_S = 120.0  # the first call may build the sidecar venv
DRAFT_TIMEOUT_S = 180.0  # validation + one explain per metric


class SemanticError(Exception):
    """A semantic-layer request that can't be served; `code` is stable for the UI."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ManifestInfo:
    semantic_manifest: Path
    adapter_type: str | None
    dbt_version: str | None
    counts: dict[str, int]  # semantic_models / metrics / saved_queries
    manifest_mtime: float | None
    # sha1 of semantic_manifest.json: every dbt command rewrites the file, but its content
    # only changes when the semantic layer does — so this, not the mtime, says "stale"
    semantic_hash: str | None = None


def target_dir(project_path: Path) -> Path:
    """`target-path` from dbt_project.yml, else target/."""
    try:
        data = yaml.safe_load((project_path / "dbt_project.yml").read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        data = None
    raw = data.get("target-path") if isinstance(data, dict) else None
    if isinstance(raw, str) and raw.strip() and "{{" not in raw:
        path = Path(raw.strip()).expanduser()
        return path if path.is_absolute() else project_path / path
    return project_path / DEFAULT_TARGET


_info_cache: dict[str, tuple[tuple[int, ...], ManifestInfo]] = {}


def _stat_key(path: Path) -> tuple[int, int]:
    try:
        st = path.stat()
    except OSError:
        return (0, 0)
    return (st.st_mtime_ns, st.st_size)


def _hash(path: Path) -> str | None:
    try:
        return hashlib.sha1(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _read_manifest_info(target: Path) -> ManifestInfo:
    manifest_path = target / "manifest.json"
    semantic = target / "semantic_manifest.json"
    try:
        stat = manifest_path.stat()
    except OSError:
        return ManifestInfo(semantic, None, None, {k: 0 for k in SEMANTIC_SECTIONS}, None)
    key = (stat.st_mtime_ns, stat.st_size, *_stat_key(semantic))
    hit = _info_cache.get(str(manifest_path))
    if hit and hit[0] == key:
        return hit[1]
    try:
        data = json.loads(manifest_path.read_bytes())
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("semantic_manifest_info_unreadable", path=str(manifest_path), error=str(exc))
        return ManifestInfo(semantic, None, None, {k: 0 for k in SEMANTIC_SECTIONS}, stat.st_mtime)
    metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    counts = {k: len(v) if isinstance(v := data.get(k), dict) else 0 for k in SEMANTIC_SECTIONS}
    info = ManifestInfo(
        semantic_manifest=semantic,
        adapter_type=(metadata.get("adapter_type") or None),
        dbt_version=(metadata.get("dbt_version") or None),
        counts=counts,
        manifest_mtime=stat.st_mtime,
        semantic_hash=_hash(semantic),
    )
    _info_cache[str(manifest_path)] = (key, info)
    return info


async def manifest_info(project_path: Path) -> ManifestInfo:
    return await asyncio.to_thread(_read_manifest_info, target_dir(project_path))


def has_semantic_nodes(info: ManifestInfo) -> bool:
    return any(info.counts.values())


# ── dbt environment (shared dbt venv) ─────────────────────────────────────────

_dbt_env_cache: dict[str, tuple[int, tuple[str | None, str | None]]] = {}


async def dbt_environment() -> tuple[str | None, str | None]:
    """(dbt-core version, Python 'major.minor') of the dbt venv; (None, None) when missing.

    `dbt --version` takes ~1 s, so it's cached until the dbt binary changes (an install
    rewrites its entry-point script).
    """
    dbt = existing_bin("dbt")
    python = existing_bin("python")
    if dbt is None:
        return (None, None)
    try:
        stamp = dbt.stat().st_mtime_ns
    except OSError:
        return (None, None)
    hit = _dbt_env_cache.get(str(dbt))
    if hit and hit[0] == stamp:
        return hit[1]
    proc = await asyncio.create_subprocess_exec(
        str(dbt), "--version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    stdout, _ = await proc.communicate()
    version = parse_dbt_version(stdout.decode(errors="replace"))
    info = await asyncio.to_thread(_python_version_info, str(python)) if python else None
    result = (version, f"{info[0]}.{info[1]}" if info else None)
    _dbt_env_cache[str(dbt)] = (stamp, result)
    return result


def forget_dbt_environment() -> None:
    _dbt_env_cache.clear()


# ── worker calls ──────────────────────────────────────────────────────────────


def _hint(info: ManifestInfo) -> str:
    v = compat._version(info.dbt_version)
    if v and (v.major, v.minor) > compat.NEWEST_TESTED_MINOR:
        return (f" (wickd's MetricFlow {ENGINE_VERSION} may be older than this project's dbt "
                f"{info.dbt_version}.)")
    return ""


async def _call(info: ManifestInfo, op: str, payload: dict[str, Any], timeout: float = EXPLAIN_TIMEOUT_S) -> dict:
    if not info.semantic_manifest.exists():
        raise SemanticError("manifest_not_found", "No semantic manifest yet — run dbt parse.")
    body = {"manifest_path": str(info.semantic_manifest), "dialect": info.adapter_type or "", **payload}
    try:
        return await metricflow_runtime.request(op, body, timeout=timeout)
    except WorkerRequestError as exc:
        message = exc.message + (_hint(info) if exc.code == "manifest_invalid" else "")
        raise SemanticError(exc.code, message) from exc


async def explain(project_path: Path, query: dict[str, Any]) -> dict:
    """{sql, columns} for metrics × group-bys (or a saved query)."""
    return await _call(await manifest_info(project_path), "explain", query)


async def explain_on(project_path: Path, manifest: Path, query: dict[str, Any]) -> dict:
    """explain() against another semantic manifest (compare mode: a base revision or target)."""
    return await _call(replace(await manifest_info(project_path), semantic_manifest=manifest), "explain", query)


async def catalog_on(project_path: Path, manifest: Path) -> dict:
    """catalog() of another semantic manifest (compare mode)."""
    return await _call(replace(await manifest_info(project_path), semantic_manifest=manifest), "catalog", {})


async def dimension_values_sql(project_path: Path, metrics: list[str], dimension: str) -> dict:
    payload = {"metrics": metrics, "dimension": dimension}
    return await _call(await manifest_info(project_path), "dimension_values", payload)


EMPTY_SEMANTIC_MANIFEST = {
    "semantic_models": [], "metrics": [], "saved_queries": [],
    "project_configuration": {"time_spine_table_configurations": [], "time_spines": [], "metadata": None},
}


async def validate_draft(
    project_path: Path, extra: dict[str, Any], smoke: list[str], smoke_group_by: list[str]
) -> dict:
    """A draft checked against the project's semantic manifest in the sidecar, nothing written:
    {errors, warnings (only what the draft adds), smoke: {metric: {sql} | {error}}}.

    A project without semantic_manifest.json yet (no semantic YAML) is checked against an
    empty one."""
    info = await manifest_info(project_path)
    payload = {"extra": extra, "smoke": smoke, "smoke_group_by": smoke_group_by}
    if info.semantic_manifest.exists():
        return await _call(info, "validate_draft", payload, timeout=DRAFT_TIMEOUT_S)
    with tempfile.TemporaryDirectory(prefix="wickd-semantic-") as tmp:
        empty = Path(tmp) / "semantic_manifest.json"
        empty.write_text(json.dumps(EMPTY_SEMANTIC_MANIFEST), encoding="utf-8")
        return await _call(replace(info, semantic_manifest=empty), "validate_draft", payload, timeout=DRAFT_TIMEOUT_S)


async def catalog(project_path: Path) -> dict:
    """Metrics with their dimensions, and saved queries, as MetricFlow sees them."""
    return await _call(await manifest_info(project_path), "catalog", {})


# MetricFlow (0.212+) rewrites a legacy cumulative metric's `measure` input into a
# `cumulative_type_params.metric` input while loading the manifest, but keeps the measure,
# then its own validator warns that the metric has both. The user's YAML only has the measure.
_BOTH_INPUTS_WARNING = "should not have both a measure and a metric as inputs"


def legacy_cumulative_metrics(semantic_manifest: dict) -> set[str]:
    """Cumulative metrics declared with only a measure (MetricFlow adds the metric input itself)."""
    names = set()
    for metric in semantic_manifest.get("metrics") or []:
        if not isinstance(metric, dict) or metric.get("type") != "cumulative":
            continue
        params = metric.get("type_params") or {}
        cumulative = params.get("cumulative_type_params") or {}
        if params.get("measure") and not cumulative.get("metric"):
            names.add(metric.get("name"))
    return names


def drop_conversion_warnings(results: dict, semantic_manifest: dict) -> dict:
    """`results` without the both-inputs warning MetricFlow raises about its own conversion."""
    legacy = legacy_cumulative_metrics(semantic_manifest)
    warnings = [
        w for w in results.get("warnings") or []
        if not (w.get("object_name") in legacy and _BOTH_INPUTS_WARNING in (w.get("message") or ""))
    ]
    return {**results, "warnings": warnings}


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_bytes())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


async def validate(project_path: Path) -> dict:
    """{errors, warnings, future_errors}: MetricFlow's semantic validations (no warehouse)."""
    info = await manifest_info(project_path)
    results = await _call(info, "validate", {})
    return drop_conversion_warnings(results, await asyncio.to_thread(_read_json, info.semantic_manifest))
