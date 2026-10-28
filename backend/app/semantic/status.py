"""Whether a project's semantic layer can run, and why not: one place for every page state."""

import asyncio
from dataclasses import asdict, dataclass, field
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Project
from app.dbt.changes import resource_dirs_from_project_yml
from app.semantic import compat, sidecar_env
from app.semantic.mode import global_mode, resolve
from app.semantic.service import dbt_environment, has_semantic_nodes, manifest_info
from app.semantic.spec import detect_spec

# Adapters MetricFlow can render SQL for (worker_main._DIALECTS).
SUPPORTED_ADAPTERS = frozenset({
    "duckdb", "postgres", "snowflake", "bigquery", "databricks", "spark", "redshift", "trino", "athena",
})

# reason codes for "this dbt-core can't run MetricFlow" (the version dialog fixes them)
INCOMPATIBLE_REASONS = frozenset({"too_old", "latest_spec_needs_1_12", "no_cli_release", "unknown_version"})

_spec_cache: dict[str, tuple[float | None, str]] = {}


@dataclass(frozen=True)
class SemanticStatus:
    available: bool  # MetricFlow can validate and explain here
    can_query: bool  # … and render SQL for this adapter
    mode: str  # auto | off
    mode_source: str  # project | global
    reason_code: str | None
    reason: str | None
    warning: str | None
    dbt_core: str | None
    python: str | None
    engine_version: str
    sidecar: str  # missing | stale | ready
    spec: str  # legacy | latest | mixed | none
    adapter_type: str | None
    counts: dict[str, int]
    compatible_dbt_versions: list[str] = field(default_factory=list)
    recommended_version: str | None = None
    cli_release: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def project_spec(project_path: Path, mtime: float | None) -> str:
    """legacy | latest | mixed | none, cached until the manifest changes (YAML edits re-parse)."""
    hit = _spec_cache.get(str(project_path))
    if hit and hit[0] == mtime and mtime is not None:
        return hit[1]
    try:
        text = (project_path / "dbt_project.yml").read_text(encoding="utf-8")
    except OSError:
        text = None
    dirs = resource_dirs_from_project_yml(text)
    spec = detect_spec(project_path, dirs)
    _spec_cache[str(project_path)] = (mtime, spec)
    return spec


def forget_spec(project_path: Path) -> None:
    """YAML changed: detect the spec again (a failed parse leaves the manifest untouched)."""
    _spec_cache.pop(str(project_path), None)


async def semantic_status(session: AsyncSession, project: Project, *, want_cli: bool = False) -> SemanticStatus:
    path = Path(project.path)
    info = await manifest_info(path)
    spec = await asyncio.to_thread(project_spec, path, info.manifest_mtime)
    effective = resolve(project.metricflow_mode, await global_mode(session))
    dbt_core, python = await dbt_environment()
    result = compat.check(dbt_core, python, uses_latest_spec=spec in ("latest", "mixed"), want_cli=want_cli)
    adapter = (info.adapter_type or "").lower() or None

    reason_code, reason = result.reason_code, result.reason
    if effective.mode == "off":
        reason_code, reason = "off", "MetricFlow is turned off for this project."
    elif result.ok and not has_semantic_nodes(info) and spec == "none":
        reason_code, reason = "no_semantic_nodes", "This project has no semantic models or metrics yet."
    available = effective.mode == "auto" and result.ok and (has_semantic_nodes(info) or spec != "none")
    can_query = available and adapter in SUPPORTED_ADAPTERS
    if available and not can_query:
        reason_code = "unsupported_adapter"
        reason = f"MetricFlow can't write SQL for the {adapter or 'unknown'} adapter, so metrics can be browsed but not queried."

    return SemanticStatus(
        available=available,
        can_query=can_query,
        mode=effective.mode,
        mode_source=effective.source,
        reason_code=reason_code,
        reason=reason,
        warning=result.warning,
        dbt_core=dbt_core,
        python=python,
        engine_version=sidecar_env.ENGINE_VERSION,
        sidecar=sidecar_env.status().state,
        spec=spec,
        adapter_type=adapter,
        counts=info.counts,
        compatible_dbt_versions=list(result.compatible_dbt_versions),
        recommended_version=compat.recommend(dbt_core, result.compatible_dbt_versions),
        cli_release=result.cli_release,
    )
