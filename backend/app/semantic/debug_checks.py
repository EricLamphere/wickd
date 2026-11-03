"""Metric debugging (plan 15, Base): check query results → findings (pure; unit-tested).

Each CheckQuery (debug_queries.py) gives one or more findings:
{id, kind, node, status ok|info|warn|fail|error|skipped, title, value, detail, sql}.
Rows are read by position: warehouses disagree on column-name case.
"""

from collections.abc import Sequence
from typing import Any

from app.semantic.debug_queries import CheckQuery

FANOUT_TOLERANCE = 1e-9
_STATUS_ORDER = {"fail": 0, "error": 1, "warn": 2, "info": 3, "skipped": 4, "ok": 5}


def _num(value: Any) -> float:
    try:
        return float(value) if value is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _count(value: Any) -> str:
    return f"{int(_num(value)):,}"


def _pct(part: float, whole: float) -> str:
    if whole <= 0:
        return "0%"
    share = 100 * part / whole
    return f"{share:.1f}%" if share >= 0.1 or share == 0 else "<0.1%"


def _finding(cq: CheckQuery, suffix: str, status: str, title: str, value: str, detail: str,
             **data: Any) -> dict[str, Any]:
    """`suffix` is the check name, optionally `:<n>` for one of several (an input's filter / nulls).
    `data`: the numbers behind it (shares 0–1, counts, ratio) plus the check's meta, for the Pro
    explanation."""
    return {"id": f"{cq.id}:{suffix}", "kind": cq.kind, "check": suffix.split(":")[0], "node": cq.node,
            "status": status, "title": title, "value": value, "detail": detail, "sql": cq.sql,
            "data": {**cq.meta, **data}}


def _share(part: float, whole: float) -> float:
    return part / whole if whole > 0 else 0.0


def _day(value: Any) -> str | None:
    text = str(value) if value is not None else ""
    return text[:10] if len(text) >= 10 and text[4] == "-" else None


def _input(cq: CheckQuery, row: Sequence[Any]) -> list[dict]:
    m = cq.meta
    items = m.get("items") or []
    values = (list(row) + [None] * (4 + 2 * len(items)))[: 4 + 2 * len(items)]
    total, scope, min_time, max_time = values[:4]
    total_n, scope_n = _num(total), _num(scope)
    model = m["semantic_model"]
    who = f"{', '.join(f'`{x}`' for x in m.get('metrics') or [])} read{'s' if len(items) == 1 else ''} {model}"
    ranged = bool(m.get("start") or m.get("end"))
    out = []
    if total_n == 0:
        out.append(_finding(cq, "rows", "fail", f"{model} has no rows", "0",
                            f"{who}, which is empty on this target — the metric can only be empty or null.", rows=0))
    elif scope_n == 0:
        out.append(_finding(cq, "rows", "warn", f"No {model} rows in scope", f"0 of {_count(total)}",
                            f"{who}: none of its {_count(total)} rows fall in the requested range"
                            f"{' and filters' if ranged else ' / filters'}.", rows=total_n, scope_rows=0))
    else:
        scope_text = f" ({_count(scope)} in range)" if ranged else ""
        out.append(_finding(cq, "rows", "ok", f"{model} rows", _count(total),
                            f"{who}: {_count(total)} rows{scope_text}.", rows=total_n, scope_rows=scope_n))
    if m.get("has_time"):
        out.append(_coverage(cq, _day(min_time), _day(max_time), m))
    for i, item in enumerate(items):
        out += _input_item(cq, i, item, scope, scope_n, values[4 + 2 * i], values[5 + 2 * i])
    return out


def _input_item(cq: CheckQuery, i: int, item: dict, scope: Any, scope_n: float, kept: Any, nulls: Any) -> list[dict]:
    kept_n, null_n = _num(kept), _num(nulls)
    metric, expr = item["metric"], item["expr"]
    own = {"metric": metric, "expr": expr, "agg": item.get("agg")}
    out = []
    if item.get("filters"):
        if not item.get("filter_checked"):
            out.append(_finding(cq, f"filter:{i}", "skipped", f"`{metric}`'s filter", "—",
                                "The filter uses a dimension from another semantic model, so it isn't counted here.", **own))
        else:
            status = "warn" if scope_n > 0 and kept_n == 0 else "info"
            out.append(_finding(cq, f"filter:{i}", status, f"`{metric}`'s filter", f"keeps {_pct(kept_n, scope_n)}",
                                f"{' AND '.join(item['filters'])} keeps {_count(kept)} of {_count(scope)} rows"
                                + (" — it drops every row." if status == "warn" else
                                   f"; {_count(scope_n - kept_n)} are excluded."),
                                kept_share=_share(kept_n, scope_n), kept_rows=kept_n, scope_rows=scope_n, **own))
    if null_n > 0:
        out.append(_finding(cq, f"nulls:{i}", "warn", f"Nulls in `{metric}`'s expression", _pct(null_n, kept_n),
                            f"{_count(nulls)} of {_count(kept)} rows have a null `{expr}`; "
                            f"{item.get('agg') or 'the aggregation'} skips them.", share=_share(null_n, kept_n),
                            null_rows=null_n, **own))
    elif kept_n > 0:
        out.append(_finding(cq, f"nulls:{i}", "ok", f"Nulls in `{metric}`'s expression", "none",
                            f"`{expr}` is never null in the {_count(kept)} rows used.", **own))
    return out


def _coverage(cq: CheckQuery, lo: str | None, hi: str | None, m: dict) -> dict:
    title = f"{m['agg_time_dimension']} coverage"
    if lo is None or hi is None:
        return _finding(cq, "time", "warn" if lo is None and hi is None else "info", title, "—",
                        f"`{m['agg_time_dimension']}` has no values." if lo is None and hi is None
                        else "Couldn't read its min / max.")
    span = f"{lo} → {hi}"
    start, end = (m.get("start") or "")[:10] or None, (m.get("end") or "")[:10] or None
    if (start and start > hi) or (end and end < lo):
        return _finding(cq, "time", "fail", title, span,
                        f"The requested range ({start or '…'} → {end or '…'}) has no data: {m['semantic_model']} "
                        f"spans {span}.", min=lo, max=hi)
    if (start and start < lo) or (end and end > hi):
        return _finding(cq, "time", "warn", title, span,
                        f"The data only covers {span}, part of the requested {start or '…'} → {end or '…'}.",
                        min=lo, max=hi)
    return _finding(cq, "time", "ok", title, span, f"{m['semantic_model']} has data from {lo} to {hi}.")


def _join(cq: CheckQuery, row: Sequence[Any]) -> list[dict]:
    left, joined, unmatched, null_keys, dupes = (list(row) + [None] * 5)[:5]
    m = cq.meta
    left_n, joined_n, unmatched_n, dupes_n = _num(left), _num(joined), _num(unmatched), _num(dupes)
    title = f"Join {m['left']} → {m['right']} on `{m['entity']}`"
    ratio = joined_n / left_n if left_n else 1.0
    out = []
    if ratio > 1 + FANOUT_TOLERANCE:
        out.append(_finding(cq, "fanout", "fail", title, f"{ratio:.2f}× rows",
                            f"Joining multiplies {m['left']}'s rows by {ratio:.2f}× ({_count(left)} → {_count(joined)}): "
                            f"{_count(dupes)} `{m['entity']}` values repeat in {m['right']}, where it's declared "
                            f"{m['right_entity_type']}. Sums over the join count those rows more than once.",
                            ratio=ratio, duplicate_keys=dupes_n))
    elif dupes_n > 0:
        out.append(_finding(cq, "fanout", "warn", title, "1.00× rows",
                            f"No row is multiplied now, but {_count(dupes)} `{m['entity']}` values repeat in "
                            f"{m['right']} (declared {m['right_entity_type']}).", ratio=ratio, duplicate_keys=dupes_n))
    else:
        out.append(_finding(cq, "fanout", "ok", title, "1.00× rows",
                            f"`{m['entity']}` is unique in {m['right']}; the join keeps {_count(left)} rows."))
    if unmatched_n > 0:
        dims = ", ".join(f"`{d}`" for d in m.get("dimensions") or [])
        nulls = f" ({_count(null_keys)} have no `{m['entity']}` at all)" if _num(null_keys) else ""
        out.append(_finding(cq, "coverage", "warn", f"{m['left']} rows without a {m['right']} match",
                            _pct(unmatched_n, left_n),
                            f"{_count(unmatched)} of {_count(left)} {m['left']} rows find no {m['right']} row{nulls}"
                            + (f"; they show under ∅ for {dims}." if dims else "."),
                            share=_share(unmatched_n, left_n), unmatched_rows=unmatched_n))
    return out


def _dimension(cq: CheckQuery, row: Sequence[Any]) -> list[dict]:
    total, nulls, empty, _distinct, _normalized = (list(row) + [None] * 5)[:5]
    m = cq.meta
    missing = _num(nulls) + _num(empty)
    if missing == 0:
        return [_finding(cq, "nulls", "ok", f"`{m['dimension']}` values", "all set",
                         f"Every {m['semantic_model']} row has a `{m['dimension']}`.")]
    return [_finding(cq, "nulls", "warn", f"`{m['dimension']}` missing", _pct(missing, _num(total)),
                     f"{_count(nulls)} null and {_count(empty)} empty of {_count(total)} {m['semantic_model']} rows; "
                     "they show as ∅.", share=_share(missing, _num(total)))]


def _variants(cq: CheckQuery, rows: Sequence[Sequence[Any]]) -> list[dict]:
    m = cq.meta
    if not rows:
        return [_finding(cq, "variants", "ok", f"`{m['dimension']}` spellings", "consistent",
                         "No values differ only by case or whitespace.")]
    examples = "; ".join(f"'{r[2]}' / '{r[3]}'" for r in rows[:3] if len(r) >= 4)
    return [_finding(cq, "variants", "warn", f"`{m['dimension']}` spellings", f"{len(rows)} groups",
                     f"Values that differ only by case or whitespace are separate groups: {examples}.", groups=len(rows))]


def interpret(cq: CheckQuery, rows: Sequence[Sequence[Any]] | None, error: str | None) -> list[dict]:
    if error is not None:
        return [_finding(cq, "error", "error", f"Check failed ({cq.kind})", "—", error[:1500])]
    rows = rows or []
    if cq.kind == "variants":
        return _variants(cq, rows)
    if not rows:
        return [_finding(cq, "error", "error", f"Check returned nothing ({cq.kind})", "—", "No row came back.")]
    handler = {"input": _input, "join": _join, "dimension": _dimension}[cq.kind]
    return handler(cq, rows[0])


def warnings(findings: list[dict]) -> list[dict]:
    """fail / error / warn findings, worst first (the list at the top of the panel)."""
    flagged = [f for f in findings if f["status"] in ("fail", "error", "warn")]
    return sorted(flagged, key=lambda f: _STATUS_ORDER[f["status"]])
