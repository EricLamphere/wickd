"""Runs many models' diff generators together: each round, every model's statements for one
connection go into a single `dbt show` (batch.run_many), so a diff of N models costs a handful of
dbt start-ups in total. See wickd_pro/data_diff/flow.py for the generator protocol."""

from collections.abc import Awaitable, Callable, Generator
from typing import Any

SIDES = ("dev", "prod")

Execute = Callable[[str, list[str]], Awaitable[list[dict[str, Any]]]]
OnRound = Callable[[int, int], Awaitable[None]]


def _start(gen: Generator) -> tuple[dict | None, dict | None]:
    """(first request, or the result when the generator finished straight away)."""
    try:
        return next(gen), None
    except StopIteration as stop:
        return None, stop.value


async def run_all(gens: dict[str, Generator], execute: Execute, on_round: OnRound | None = None) -> dict[str, dict]:
    results: dict[str, dict] = {}
    pending: dict[str, dict] = {}
    for uid, gen in gens.items():
        request, done = _start(gen)
        if request is None:
            results[uid] = done or {}
        else:
            pending[uid] = request
    round_no = 0
    while pending:
        round_no += 1
        if on_round is not None:
            await on_round(round_no, len(pending))
        answers: dict[str, dict[str, list]] = {uid: {s: [] for s in SIDES} for uid in pending}
        for side in SIDES:
            owners: list[str] = []
            sqls: list[str] = []
            for uid, request in pending.items():
                for sql in request.get(side) or []:
                    owners.append(uid)
                    sqls.append(sql)
            if not sqls:
                continue
            for uid, res in zip(owners, await execute(side, sqls), strict=True):
                answers[uid][side].append(res)
        advanced: dict[str, dict] = {}
        for uid in pending:
            try:
                advanced[uid] = gens[uid].send(answers[uid])
            except StopIteration as stop:
                results[uid] = stop.value or {}
        pending = advanced
    return results
