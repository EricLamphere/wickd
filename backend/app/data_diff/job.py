"""The data diff job (wickd Pro, plan 06): changed models built in dev, compared with prod.

1. `building` — with `build`, `dbt run --select <models>` on the active (dev) target through
   api/runs.py, so it shows in Run History. Never anything on prod.
2. `resolving` — both targets' connection identity (`dbt debug`, cached), relations on prod
   (relations.py: `dbt parse` for DIFF_BASE_TARGET into the data dir).
3. `probing` — both sides' columns (one batch probe per target), keys, strategy per model
   (prepare.py; a zero-row read of prod from dev).
4. `comparing` — wickd_pro's generators, every model's statements for one connection in one
   `dbt show` per round (driver.py).

One job per project at a time; snapshots are one row per model. Events: data_diff_started,
data_diff_progress {phase, round?}, data_diff_finished {ok, counts}.
"""

import asyncio
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.data_diff import prepare
from app.data_diff.driver import run_all
from app.data_diff.prepare import ModelPlan
from app.db.models import DataDiffSnapshot, Project
from app.dbt import data_diff
from app.dbt.connection_info import target_connection
from app.dbt.probe import probe_many_warehouse_columns
from app.dbt.relations import manifest_for_target, relations_from_manifest
from app.dbt.revisions import RevisionError
from app.dbt.run_results import load_run_results
from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.semantic.batch import other_target_path, run_many

log = get_logger(__name__)

KEEP_PER_MODEL = 5
FAILED_RUN = {"error", "fail", "runtime error", "skipped"}


@dataclass(frozen=True)
class DiffRequest:
    unique_ids: list[str]
    scope: str = "working"
    base: str | None = None
    keys: dict[str, list[str]] = field(default_factory=dict)
    columns: dict[str, list[str]] = field(default_factory=dict)
    where: dict[str, str] = field(default_factory=dict)
    build: bool = True
    mode: str = "auto"
    tolerance: float = 0.0


@dataclass(frozen=True)
class Targets:
    dev: str
    prod: str


class DiffFailed(Exception):
    pass


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


async def _publish(project_id: int, kind: str, data: dict[str, Any]) -> None:
    await bus.publish(Event(topic=f"project:{project_id}", type=kind, data=data))


async def _update(snap_ids: dict[str, int], **fields: Any) -> None:
    from app.db.engine import SessionLocal

    async with SessionLocal() as session:
        for snap_id in snap_ids.values():
            snap = await session.get(DataDiffSnapshot, snap_id)
            if snap is not None and snap.status == "running":
                for key, value in fields.items():
                    setattr(snap, key, value)
        await session.commit()


async def _phase(project_id: int, snap_ids: dict[str, int], phase: str, **extra: Any) -> None:
    await _update(snap_ids, phase=phase)
    await _publish(project_id, "data_diff_progress", {"snapshot_ids": list(snap_ids.values()), "phase": phase, **extra})


async def _build(project: Project, plans: list[ModelPlan]) -> None:
    from app.api.runs import _run_dbt_and_persist

    names = [p.name for p in plans if not p.error]
    if not names:
        return
    await _run_dbt_and_persist(project, "run", " ".join(sorted(set(names))))
    results = {r.unique_id: r for r in load_run_results(Path(project.path) / "target" / "run_results.json")}
    for p in plans:
        r = results.get(p.unique_id)
        if r is not None and r.status in FAILED_RUN:
            p.fail("build_failed", f"`dbt run` failed for `{p.name}` in dev: {(r.message or r.status)[:300]}")
    built = [p for p in plans if not p.error]
    for p in built:
        p.notes.append("Built in dev with `dbt run` just before comparing; its parents were read from dev, so if "
                       "they're older than prod, their differences show up here too.")


async def _probe(project: Project, plans: list[ModelPlan], targets: Targets, env: dict[str, str]) -> None:
    names = tuple(sorted({p.name for p in plans if not p.error}))
    if not names:
        return
    path = Path(project.path)
    dev = await probe_many_warehouse_columns(project.id, path, names, env, targets.dev)
    prod = await probe_many_warehouse_columns(project.id, path, names, env, targets.prod,
                                              target_path=other_target_path(project.id, targets.prod))
    prepare.apply_columns(plans, dev, prod, targets.dev, targets.prod)


async def _structure(project_id: int) -> dict:
    from app.db.engine import SessionLocal
    from app.test_targets.service import LineageNotReady, latest_inputs

    async with SessionLocal() as session:
        try:
            return (await latest_inputs(session, project_id)).structure
        except LineageNotReady:
            return {}


def _runner(project: Project, targets: Targets):
    async def run(side: str, sqls: list[str]) -> list[dict[str, Any]]:
        target = targets.dev if side == "dev" else targets.prod
        results = await run_many(project.id, Path(project.path), sqls, target=target)
        return [{"columns": r.columns, "rows": r.rows, "error": r.error} for r in results]
    return run


async def _prepare(project: Project, req: DiffRequest, targets: Targets, env: dict[str, str],
                   snap_ids: dict[str, int]) -> tuple[list[ModelPlan], str | None]:
    path = Path(project.path)
    manifest = await asyncio.to_thread(_read_json, path / "target" / "manifest.json")
    plans = prepare.new_plans(manifest, req.unique_ids)
    for p in plans:
        p.columns = req.columns.get(p.unique_id) or None
        p.where = (req.where.get(p.unique_id) or "").strip() or None
        prepare.incremental_note(p)
    if req.build:
        await _phase(project.id, snap_ids, "building")
        await _build(project, plans)
        manifest = await asyncio.to_thread(_read_json, path / "target" / "manifest.json")

    await _phase(project.id, snap_ids, "resolving")
    dev_conn = await target_connection(project.id, path, targets.dev, env)
    prod_conn = await target_connection(project.id, path, targets.prod, env)
    if not prod_conn.connected:
        raise DiffFailed(f"Couldn't connect to the `{targets.prod}` target: {prod_conn.error}")
    adapter = dev_conn.adapter_type or (manifest.get("metadata") or {}).get("adapter_type")
    if prod_conn.adapter_type and adapter and prod_conn.adapter_type != adapter:
        raise DiffFailed(f"`{targets.dev}` uses {adapter} and `{targets.prod}` uses {prod_conn.adapter_type}; "
                         "data diff compares two targets of the same adapter.")
    try:
        prod_manifest = await manifest_for_target(project, targets.prod)
    except RevisionError as exc:
        raise DiffFailed(f"Couldn't parse the project for `{targets.prod}`: {exc.message}") from exc
    prepare.apply_relations(plans, relations_from_manifest(manifest, req.unique_ids),
                            relations_from_manifest(prod_manifest, req.unique_ids), targets.prod)

    await _phase(project.id, snap_ids, "probing")
    await _probe(project, plans, targets, env)
    prepare.apply_keys(plans, manifest, await _structure(project.id), req.keys)
    await prepare.choose_modes(plans, dev_conn, prod_conn, _runner(project, targets), req.mode)
    if any(p.mode == "separate" for p in plans if not p.error) and not data_diff.supports_separate(adapter):
        for p in plans:
            if p.mode == "separate":
                p.fail("unsupported", f"Comparing across connections isn't supported for {adapter} yet, and "
                       f"`{targets.dev}` can't read the prod relation directly.")
    return plans, adapter


async def _store(snap_ids: dict[str, int], plans: list[ModelPlan], results: dict[str, dict]) -> dict[str, int]:
    from app.db.engine import SessionLocal

    counts = {"done": 0, "error": 0, "different": 0}
    async with SessionLocal() as session:
        for p in plans:
            snap = await session.get(DataDiffSnapshot, snap_ids[p.unique_id])
            if snap is None:
                continue
            out = results.get(p.unique_id)
            error = p.error or (out or {}).get("error")
            if out is not None:
                out = {**out, "notes": [*p.notes, *[n for n in out.get("notes") or [] if n not in p.notes]]}
            snap.dev_relation, snap.prod_relation = p.dev_relation, p.prod_relation
            snap.mode = (out or {}).get("mode") or p.mode
            snap.key_json = json.dumps(list(p.key.columns) if p.key else [])
            snap.key_source = p.key.source if p.key else None
            snap.results_json = json.dumps(out if out is not None else {"notes": p.notes, "error": p.error})
            snap.status = "error" if error or out is None else "done"
            snap.error_message = (error or {}).get("message") if snap.status == "error" else None
            snap.phase = None
            snap.finished_at = datetime.now(UTC)
            counts[snap.status] += 1
            c = (out or {}).get("counts") or {}
            if any(c.get(k) for k in ("added", "removed", "changed")) or (c and c.get("dev_rows") != c.get("prod_rows")):
                counts["different"] += 1
        await session.commit()
    return counts


async def _trim(project_id: int, unique_ids: list[str]) -> None:
    from app.db.engine import SessionLocal

    async with SessionLocal() as session:
        for uid in unique_ids:
            rows = (await session.execute(
                select(DataDiffSnapshot.id).where(DataDiffSnapshot.project_id == project_id, DataDiffSnapshot.unique_id == uid)
                .order_by(DataDiffSnapshot.id.desc()).offset(KEEP_PER_MODEL)
            )).scalars().all()
            for snap_id in rows:
                snap = await session.get(DataDiffSnapshot, snap_id)
                if snap is not None:
                    await session.delete(snap)
        await session.commit()


async def _diff(project: Project, req: DiffRequest, targets: Targets, env: dict[str, str],
                snap_ids: dict[str, int]) -> dict[str, int]:
    plans, adapter = await _prepare(project, req, targets, env, snap_ids)
    for p in plans:
        if not p.error:
            await _update({p.unique_id: snap_ids[p.unique_id]}, mode=p.mode)
    await _phase(project.id, snap_ids, "comparing")
    gens = {p.unique_id: data_diff.diff_steps(p.spec(adapter, req.tolerance)) for p in plans if not p.error}

    async def on_round(round_no: int, pending: int) -> None:
        await _publish(project.id, "data_diff_progress", {"snapshot_ids": list(snap_ids.values()), "phase": "comparing",
                                                          "round": round_no, "pending": pending})
    results = await run_all(gens, _runner(project, targets), on_round)
    return await _store(snap_ids, plans, results)


async def run_job(project: Project, req: DiffRequest, targets: Targets, env: dict[str, str], snap_ids: dict[str, int]) -> None:
    ids = list(snap_ids.values())
    await _publish(project.id, "data_diff_started", {"snapshot_ids": ids, "count": len(ids)})
    ok, counts = True, {}
    try:
        counts = await _diff(project, req, targets, env, snap_ids)
        ok = counts.get("error", 0) == 0
    except asyncio.CancelledError:
        ok = False
        await _update(snap_ids, status="error", phase=None, error_message="Cancelled", finished_at=datetime.now(UTC))
        await _publish(project.id, "data_diff_finished", {"snapshot_ids": ids, "ok": False, "cancelled": True})
        raise
    except DiffFailed as exc:
        ok = False
        await _update(snap_ids, status="error", phase=None, error_message=str(exc)[-2000:], finished_at=datetime.now(UTC))
    except Exception as exc:
        ok = False
        log.exception("data_diff_failed", project_id=project.id)
        await _update(snap_ids, status="error", phase=None, error_message=f"The data diff failed: {exc}"[-2000:],
                      finished_at=datetime.now(UTC))
    await _trim(project.id, req.unique_ids)
    await _publish(project.id, "data_diff_finished", {"snapshot_ids": ids, "ok": ok, "counts": counts})
