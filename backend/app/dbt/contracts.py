"""Contract checks — wickd Pro. Public shim over the private `wickd_pro.contracts` package.

The public side builds the inputs (both sides' compiled manifests via app/dbt/revisions.py,
the lineage snapshot, dashboards and monitors per metric, optionally probed types) and runs the
job (app/api/contracts.py); which columns a model produces, what changed, who uses it and how
serious that is are decided in wickd_pro. Only plain dicts cross the boundary:

    check_contracts(head, base, unique_ids, lineage, row_deps, semantic_consumers, types=None)
        head / base         manifest dicts (base None: no earlier revision)
        lineage / row_deps  the latest column lineage snapshot, {} when there isn't one
        semantic_consumers  {metric: {dashboards: [{slug, title}], monitors: [{id, metric}]}}
        types               {"head": {uid: {column: type}}, "base": {...}} or None
        → [{unique_id, name, contracted, versioned, access, new_model, columns_known, base_known,
            head_columns, base_columns, contract_findings, column_diff, breaking_changes,
            severity (none/info/warning/error), suggestion}]   (see wickd_pro/contracts/__init__.py)
"""

from typing import Any


class ContractsUnavailable(Exception):
    """wickd_pro (with contract checks) isn't installed in this build."""


UNAVAILABLE = "Contract checks require the wickd Pro package, which isn't installed in this build."


def _pro() -> Any:
    try:
        from wickd_pro import contracts
    except ImportError as exc:
        raise ContractsUnavailable(UNAVAILABLE) from exc
    return contracts


def is_available() -> bool:
    try:
        _pro()
    except ContractsUnavailable:
        return False
    return True


def check_contracts(
    head: dict, base: dict | None, unique_ids: list[str], lineage: dict, row_deps: dict,
    semantic_consumers: dict, types: dict | None = None,
) -> list[dict]:
    return _pro().check_contracts(head, base, unique_ids, lineage, row_deps, semantic_consumers, types)
