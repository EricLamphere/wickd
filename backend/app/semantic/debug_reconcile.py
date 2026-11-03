"""Metric debugging (plan 15, Base): "Reconcile with SQL" — a metric's result next to a plain SQL
query that should equal it, aligned by the query's group-by columns (pure; unit-tested).

Columns match by name, case-insensitively (Snowflake upper-cases them). The SQL must return
every group-by column and at least one of the metrics.
"""

from collections.abc import Mapping, Sequence
from typing import Any

MAX_DIFF_ROWS = 500
TOLERANCE = 1e-6


class ReconcileError(ValueError):
    """The two results can't be compared (missing columns)."""


def _index(columns: Sequence[str]) -> dict[str, int]:
    return {str(c).lower(): i for i, c in enumerate(columns)}


def _key_part(value: Any) -> str:
    if value is None:
        return "∅"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value)
    # dates come back as '2026-01-01' from one side and '2026-01-01 00:00:00' from the other
    return text[:10] if len(text) >= 19 and text[4] == "-" and text[10:19] in (" 00:00:00", "T00:00:00") else text


def _number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _same(a: Any, b: Any) -> bool:
    x, y = _number(a), _number(b)
    if x is None or y is None:
        return x is None and y is None and (a is None) == (b is None)
    return abs(x - y) <= TOLERANCE * max(1.0, abs(x), abs(y))


def _rows_by_key(result: Mapping[str, Any], keys: list[str], values: list[str]) -> dict[tuple, list[Any]]:
    idx = _index(result.get("columns") or [])
    out: dict[tuple, list[Any]] = {}
    for row in result.get("rows") or []:
        key = tuple(_key_part(row[idx[k]]) for k in keys)
        vals = [row[idx[v]] for v in values]
        if key in out:  # repeated keys: add them up, as the metric would
            vals = [(_number(a) or 0) + (_number(b) or 0) for a, b in zip(out[key], vals, strict=True)]
        out[key] = vals
    return out


def reconcile(
    metric_result: Mapping[str, Any], sql_result: Mapping[str, Any], key_columns: list[str], metrics: list[str]
) -> dict[str, Any]:
    """{columns, rows (differences), summary {keys, matching, different, only_metric, only_sql}, compared}."""
    keys = [k.lower() for k in key_columns]
    sql_idx = _index(sql_result.get("columns") or [])
    missing = [k for k, low in zip(key_columns, keys, strict=True) if low not in sql_idx]
    if missing:
        raise ReconcileError(f"Your SQL must return the group-by column{'s' if len(missing) > 1 else ''} "
                             f"{', '.join(f'`{m}`' for m in missing)}.")
    compared = [m for m in metrics if m.lower() in sql_idx]
    if not compared:
        raise ReconcileError(f"Your SQL must return a column named like the metric ({', '.join(f'`{m}`' for m in metrics)}).")
    values = [m.lower() for m in compared]
    ours = _rows_by_key(metric_result, keys, values)
    theirs = _rows_by_key(sql_result, keys, values)
    rows, summary = [], {"keys": 0, "matching": 0, "different": 0, "only_metric": 0, "only_sql": 0}
    for key in sorted(set(ours) | set(theirs)):
        summary["keys"] += 1
        a, b = ours.get(key), theirs.get(key)
        if a is None or b is None:
            status = "only_sql" if a is None else "only_metric"
        else:
            status = "matching" if all(_same(x, y) for x, y in zip(a, b, strict=True)) else "different"
        summary[status] += 1
        if status == "matching" or len(rows) >= MAX_DIFF_ROWS:
            continue
        cells: list[Any] = list(key) + [status]
        for i in range(len(compared)):
            x = a[i] if a is not None else None
            y = b[i] if b is not None else None
            nx, ny = _number(x), _number(y)
            cells += [x, y, (nx - ny) if nx is not None and ny is not None else None]
        rows.append(cells)
    columns = list(key_columns) + ["status"]
    for m in compared:
        columns += [f"{m} (metric)", f"{m} (sql)", f"{m} difference"]
    return {"columns": columns, "rows": rows, "summary": summary, "compared": compared,
            "truncated": summary["different"] + summary["only_metric"] + summary["only_sql"] > len(rows)}
