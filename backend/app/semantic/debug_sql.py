"""Metric debugging (plan 15): MetricFlow's SQL split into its steps (pure; unit-tested).

MetricFlow writes the plan nodes a SELECT implements as `-- <node description>` lines just
before it (its optimizer merges several nodes into one SELECT). So the SQL splits into
steps: each commented SELECT, up to its closing parenthesis — a runnable query of the data
at that point. Plan nodes are matched to steps by description; when the plan isn't
available the steps alone are the anatomy.
"""

from collections import defaultdict
from typing import Any

MAX_STEPS = 200


def _comment_block(lines: list[str], end: int) -> list[str]:
    """The `--` lines right above line `end` (nearest last)."""
    block: list[str] = []
    i = end - 1
    while i >= 0 and lines[i].strip().startswith("--"):
        block.insert(0, lines[i].strip()[2:].strip())
        i -= 1
    return block


def _depth_end(sql: str, start: int) -> int:
    """Where the parenthesised level that `start` is in closes (or the end of the SQL)."""
    depth, quote = 0, None
    for i in range(start, len(sql)):
        ch = sql[i]
        if quote:
            if ch == quote:
                quote = None
        elif ch in ("'", '"', "`"):
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            if depth == 0:
                return i
            depth -= 1
    return len(sql)


def sql_steps(sql: str) -> list[dict[str, Any]]:
    """[{index, labels, sql}] innermost first — the order the data flows."""
    lines = sql.splitlines(keepends=True)
    offsets, pos = [], 0
    for line in lines:
        offsets.append(pos)
        pos += len(line)
    plain = [line.rstrip("\n") for line in lines]
    steps = []
    for n, line in enumerate(plain):
        stripped = line.strip()
        if not stripped.upper().startswith(("SELECT", "WITH")):
            continue
        labels = _comment_block(plain, n)
        if not labels:
            continue
        begin = offsets[n] + (len(line) - len(line.lstrip()))
        text = sql[begin:_depth_end(sql, begin)].rstrip()
        steps.append({"labels": labels, "sql": "\n".join(f"-- {lab}" for lab in labels) + "\n" + text})
        if len(steps) >= MAX_STEPS:
            break
    steps.reverse()
    return [{"index": i, **s} for i, s in enumerate(steps)]


def attach_steps(plan: list[dict[str, Any]], steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The plan with `step` (an index into `steps`) on every node whose description a step names.
    Repeated descriptions (a ratio's two branches) are matched in order."""
    by_label: dict[str, list[int]] = defaultdict(list)
    for step in steps:
        for label in step["labels"]:
            by_label[label].append(step["index"])
    used: dict[str, int] = defaultdict(int)
    out = []
    for node in plan:
        label = str(node.get("label") or "")
        candidates = by_label.get(label) or []
        if candidates:
            k = min(used[label], len(candidates) - 1)
            used[label] += 1
            out.append({**node, "step": candidates[k]})
        else:
            out.append({**node, "step": None})
    return out
