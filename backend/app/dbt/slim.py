"""Smallest safe slim build — wickd Pro (plan 18). Public shim over `wickd_pro.slim_selection`.

The public side runs `dbt ls`, compiles both sides of the changed models and loads the column
lineage snapshot (app/dbt/slim_preview.py); which columns changed and which downstream nodes
can be skipped are decided in wickd_pro. Only plain dicts / lists cross the boundary:

    changed_columns(base_sql, head_sql, dialect=None) -> [column] | None   (None: every column)
    logic_unchanged(base_manifest, head_manifest, uid) -> bool   (same SQL modulo whitespace / Jinja comments, config, macros)
    prune(candidates {uid: resource_type}, changed {uid: [column] | None}, lineage, row_deps,
          parents {uid: [uid]}, protected {uid})
        -> {select: [uid], kept: [{unique_id, reason, columns}], skipped: [{unique_id, reason}]}
"""

from typing import Any


class SlimSelectionUnavailable(Exception):
    """wickd_pro (with slim selection) isn't installed in this build."""


UNAVAILABLE = "The smallest safe selection requires the wickd Pro package, which isn't installed in this build."


def _pro() -> Any:
    try:
        from wickd_pro import slim_selection
    except ImportError as exc:
        raise SlimSelectionUnavailable(UNAVAILABLE) from exc
    return slim_selection


def is_available() -> bool:
    try:
        _pro()
    except SlimSelectionUnavailable:
        return False
    return True


def changed_columns(base_sql: str | None, head_sql: str | None, dialect: str | None = None) -> list[str] | None:
    return _pro().changed_columns(base_sql, head_sql, dialect)


def logic_unchanged(base_manifest: dict, head_manifest: dict, uid: str) -> bool:
    return _pro().logic_unchanged(base_manifest, head_manifest, uid)


def prune(
    candidates: dict[str, str], changed: dict[str, list[str] | None], lineage: dict, row_deps: dict,
    parents: dict[str, list[str]], protected: set[str],
) -> dict:
    return _pro().prune(candidates, changed, lineage, row_deps, parents, protected)
