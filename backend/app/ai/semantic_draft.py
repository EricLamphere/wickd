"""Add a model to the semantic layer: Wicky drafts its semantic model + starting metrics.

1. Facts: the model's warehouse columns with types, a 500-row sample summarised per
   column, its tests and the existing semantic models (entities to join to).
2. wickd_pro drafts from the facts; with an AI model set up, the model names, describes
   and picks measures/metrics within a schema that only allows real columns.
3. The draft is validated in the MetricFlow sidecar against the project's semantic
   manifest without writing anything (a "shadow manifest"), and a LIMIT 5 smoke query
   per metric runs in ONE `dbt show` (semantic/batch.py), so the review shows what each
   metric returns before it's accepted.
4. The YAML is spliced in the project's spec (dbt/schema_semantic.py), plus a MetricFlow
   time spine as separate files when the project has none.
Nothing is written here — the result becomes an AiProposal (kind "semantic").
"""

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from app.ai.client import stream_chat
from app.ai.config import AiConfig
from app.ai.documentation import (
    FileChange,
    PhaseCallback,
    TextCallback,
    _noop,
    load_manifest_dict,
    node_columns,
)
from app.ai.errors import NothingToPropose, ProposalError
from app.ai.provider import llm_ready, resolve_provider
from app.ai.runtime import llama_server
from app.ai.test_generation import SAMPLE_ROWS, _show, column_stats
from app.dbt.probe import probe_many_warehouse_columns
from app.dbt.schema_semantic import render_latest, render_legacy
from app.dbt.schema_yaml import DocumentTarget, plan_document_node
from app.logging_setup import get_logger
from app.semantic import batch, service
from app.semantic import pro as semantic_pro
from app.semantic.compat import _version
from app.semantic.status import project_spec

log = get_logger(__name__)

KIND = "semantic"
SEMANTIC_MODEL_KEY = "semantic_model"
TIME_SPINE_MODEL = "metricflow_time_spine"
SPINE_SQL_KEY, SPINE_YAML_KEY = "time_spine_model", "time_spine_config"
SMOKE_ROWS = 5
FACTS_ONLY_NOTE = "Drafted from column facts only — set up the AI model for better names, descriptions and metric choices."

SPINE_SQL = """{{ config(materialized='table') }}

-- One row per day. MetricFlow joins cumulative and time-offset metrics to it, and uses it
-- for metric_time. Added by wickd; widen the range if your data goes beyond it.
select cast(date_day as date) as date_day
from ({{ dbt.date_spine('day', "cast('2015-01-01' as date)", "cast('2035-01-01' as date)") }}) as spine
"""
SPINE_YAML = """version: 2

models:
  - name: metricflow_time_spine
    description: One row per day, for MetricFlow (added by wickd).
    time_spine:
      standard_granularity_column: date_day
    columns:
      - name: date_day
        granularity: day
"""


@dataclass(frozen=True)
class SemanticDraftResult:
    changes: list[FileChange]
    # {"spec", "model", "items": [...], "plan": {...}, "warnings": [...], "note"?}
    summary: dict


def draft_spec(project: str, dbt_version: str | None) -> str:
    """latest only on dbt 1.12+ for a project already on it (or with no semantic YAML yet);
    the latest spec fails to parse on 1.11, and a project is never switched to a mix."""
    v = _version(dbt_version)
    modern = bool(v) and (v.major, v.minor) >= (1, 12)
    return "latest" if modern and project in ("latest", "none", "mixed") else "legacy"


def has_time_spine(manifest: dict, semantic_manifest: dict) -> bool:
    config = semantic_manifest.get("project_configuration") or {}
    if config.get("time_spines") or config.get("time_spine_table_configurations"):
        return True
    return any(
        isinstance(n, dict) and n.get("resource_type") == "model"
        and (n.get("name") == TIME_SPINE_MODEL or (n.get("time_spine") or (n.get("config") or {}).get("time_spine")))
        for n in (manifest.get("nodes") or {}).values()
    )


def semantic_model_on(node: dict, semantic_manifest: dict) -> str | None:
    """The existing semantic model built on this node, if any."""
    alias = (node.get("alias") or node.get("name") or "").lower()
    schema = (node.get("schema") or "").lower()
    for sm in semantic_manifest.get("semantic_models") or []:
        rel = sm.get("node_relation") or {}
        if (rel.get("alias") or "").lower() == alias and (rel.get("schema_name") or "").lower() in ("", schema):
            return sm.get("name")
    return None


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


async def _columns(project_id: int, project_path: Path, node: dict, unique_id: str, env: dict) -> list[dict]:
    """[{name, data_type}] from the warehouse, else the project's documented columns."""
    probed = await probe_many_warehouse_columns(project_id, project_path, (node["name"],), env, env.get("DBT_TARGET"))
    result = (probed or {}).get(node["name"])
    if result is not None and result.error is None and result.columns:
        types = list(result.types) + [""] * (len(result.columns) - len(result.types))
        return [{"name": c, "data_type": t} for c, t in zip(result.columns, types, strict=False)]
    documented = {k.lower(): (v or {}).get("data_type") or "" for k, v in (node.get("columns") or {}).items()}
    names = await node_columns(project_id, project_path, node, unique_id, env)
    return [{"name": n, "data_type": documented.get(n.lower(), "")} for n in names]


async def _llm_draft(config: AiConfig, facts: dict, draft: dict, on_phase: PhaseCallback, on_text: TextCallback) -> tuple[dict, str | None]:
    prompt = semantic_pro.draft_prompt(facts, draft)
    await on_phase("writing")
    provider = await resolve_provider(config)
    parts: list[str] = []
    async for delta in stream_chat(provider, prompt["messages"], max_tokens=prompt.get("max_tokens"), schema=prompt["schema"]):
        parts.append(delta)
        llama_server.touch()
        await on_text("".join(parts))
    try:
        return semantic_pro.parse_draft("".join(parts), facts, draft), None
    except ValueError as exc:
        log.warning("semantic_draft_unparseable", error=str(exc))
        return draft, f"The AI model's answer wasn't usable ({exc}); this is wickd's draft from the column facts."


def _definition(metric: dict, measures: dict) -> str:
    if metric["type"] == "ratio":
        return f"{metric['numerator']} / {metric['denominator']}"
    m = measures.get(metric.get("measure"), {})
    return f"{m.get('agg', '?')}({m.get('column', '?')})"


async def _smoke(project_id: int, project_path: Path, smoke: dict) -> dict[str, dict]:
    """{metric: {columns, rows} | {error}} — every smoke query in one `dbt show`."""
    runnable = [(name, r["sql"]) for name, r in smoke.items() if r.get("sql")]
    out = {name: {"error": r.get("error") or "no SQL"} for name, r in smoke.items() if not r.get("sql")}
    if runnable:
        results = await batch.run_many(project_id, project_path, [sql for _, sql in runnable], limit=SMOKE_ROWS)
        for (name, _), res in zip(runnable, results, strict=True):
            out[name] = {"error": res.error} if res.error else {"columns": res.columns, "rows": res.rows[:SMOKE_ROWS]}
    return out


def _spine_relation(node: dict) -> dict:
    return {"node_relation": {"alias": TIME_SPINE_MODEL, "schema_name": node.get("schema"), "database": node.get("database"),
                              "relation_name": None}, "primary_column": {"name": "date_day", "time_granularity": "day"}}


async def _validate(project_path: Path, node: dict, semantic_manifest: dict, draft: dict, spine_missing: bool) -> dict:
    """The draft in the sidecar against the real semantic manifest (+ the new time spine)."""
    shadow = semantic_pro.to_manifest_json(draft, node, semantic_manifest)
    if spine_missing and draft["metrics"]:
        shadow["time_spines"] = [_spine_relation(node)]
    group_by = [] if spine_missing else ["metric_time__day"]
    return await service.validate_draft(project_path, shadow, [m["name"] for m in draft["metrics"]], group_by)


def _spine_changes(project_path: Path, model_dir: str, dbt_version: str | None) -> list[FileChange]:
    sql_path = str(PurePosixPath(model_dir) / f"{TIME_SPINE_MODEL}.sql")
    if (project_path / sql_path).exists():
        return []
    changes = [FileChange(sql_path, None, SPINE_SQL)]
    v = _version(dbt_version)
    yml_path = str(PurePosixPath(model_dir) / f"{TIME_SPINE_MODEL}.yml")
    if v and (v.major, v.minor) >= (1, 9) and not (project_path / yml_path).exists():
        changes.append(FileChange(yml_path, None, SPINE_YAML))  # 1.9+: the model is declared a spine
    return changes


def render_semantic(plan: dict, original: str | None, path: str, keys: list[str]) -> str:
    """The YAML file for the chosen items (also used to rebuild a partial accept)."""
    filename = PurePosixPath(path).name
    if plan["spec"] == "latest":
        return render_latest(original, filename, plan["model"], plan["yaml"], keys)
    return render_legacy(original, filename, plan["yaml"], keys)


async def generate_semantic_draft(
    *,
    project_id: int,
    project_path: Path,
    unique_id: str,
    env: dict[str, str],
    config: AiConfig,
    on_phase: PhaseCallback = _noop,
    on_text: TextCallback = _noop,
) -> SemanticDraftResult:
    manifest = await asyncio.to_thread(load_manifest_dict, project_path)
    node = (manifest.get("nodes") or {}).get(unique_id)
    if not isinstance(node, dict) or node.get("resource_type") != "model" or not node.get("original_file_path"):
        raise ProposalError("only models can be added to the semantic layer")
    semantic_manifest = await asyncio.to_thread(_read_json, service.target_dir(project_path) / "semantic_manifest.json")
    existing = semantic_model_on(node, semantic_manifest)
    if existing:
        raise NothingToPropose(f"{node['name']} is already in the semantic layer (semantic model `{existing}`).")

    await on_phase("facts")
    columns = await _columns(project_id, project_path, node, unique_id, env)
    if not columns:
        raise ProposalError("no columns found — build the model first")
    sample = await _show(project_id, project_path, env, ("--limit", str(SAMPLE_ROWS)), node["name"])
    facts = semantic_pro.facts_for(manifest, unique_id, columns, column_stats(*sample) if sample else {}, semantic_manifest)
    heuristic = semantic_pro.heuristic_draft(facts)
    draft, note = heuristic, FACTS_ONLY_NOTE
    if llm_ready(config):
        draft, note = await _llm_draft(config, facts, heuristic, on_phase, on_text)

    dbt_version = (manifest.get("metadata") or {}).get("dbt_version")
    spec = draft_spec(await asyncio.to_thread(project_spec, project_path, None), dbt_version)
    await on_phase("validating")
    spine_missing = not has_time_spine(manifest, semantic_manifest)
    checked = await _validate(project_path, node, semantic_manifest, draft, spine_missing)
    if checked["errors"] and draft is not heuristic:  # the AI's version broke a rule: wickd's own draft
        log.info("semantic_draft_ai_invalid", errors=[e["message"] for e in checked["errors"][:3]])
        draft, note = heuristic, "The AI model's draft didn't pass MetricFlow's validation, so this is wickd's draft from the column facts."
        checked = await _validate(project_path, node, semantic_manifest, draft, spine_missing)
    if checked["errors"]:
        messages = "; ".join(e["message"] for e in checked["errors"][:5])
        raise ProposalError(f"MetricFlow rejected the draft: {messages}")
    try:
        yaml_items = semantic_pro.to_yaml_items(draft, spec)
    except ValueError as exc:
        raise ProposalError(str(exc)) from exc
    spine = bool(draft["metrics"]) and spine_missing
    smoke = await _smoke(project_id, project_path, checked.get("smoke") or {})

    target = DocumentTarget(name=node["name"], resource_type="model",
                            original_file_path=node["original_file_path"], patch_path=node.get("patch_path"))
    plan_file = await asyncio.to_thread(plan_document_node, project_path, target, [])
    path = plan_file.result.path
    plan = {"spec": spec, "model": node["name"], "yaml": yaml_items}
    keys = [SEMANTIC_MODEL_KEY, *(m["key"] for m in yaml_items["metrics"])]
    text = await asyncio.to_thread(render_semantic, plan, plan_file.original, path, keys)
    changes = [FileChange(path, plan_file.original, text)]
    if spine:
        changes += _spine_changes(project_path, str(PurePosixPath(node["original_file_path"]).parent), dbt_version)

    sm = draft["semantic_model"]
    measures = {m["name"]: m for m in sm["measures"]}
    items = [{
        "key": SEMANTIC_MODEL_KEY, "file": path, "kind": "semantic_model", "name": sm["name"],
        "description": sm.get("description") or "",
        "entities": [f"{e['name']} ({e['type']})" for e in sm["entities"]],
        "dimensions": [d["name"] for d in sm["dimensions"]],
        "measures": [f"{m['name']} = {m['agg']}({m['column']})" for m in sm["measures"]],
        "agg_time_dimension": sm.get("agg_time_dimension"),
    }]
    for m in draft["metrics"]:
        items.append({
            "key": f"metric:{m['name']}", "file": path, "kind": "metric", "name": m["name"], "label": m.get("label") or "",
            "description": m.get("description") or "", "type": m["type"], "definition": _definition(m, measures),
            "smoke": smoke.get(m["name"]),
        })
    for change in changes[1:]:
        is_sql = change.path.endswith(".sql")
        items.append({"key": SPINE_SQL_KEY if is_sql else SPINE_YAML_KEY, "file": change.path, "kind": "time_spine",
                      "name": TIME_SPINE_MODEL, "description": "Time spine model (one row per day)" if is_sql
                      else "Declares the model as MetricFlow's time spine (dbt 1.9+)"})
    summary = {
        "spec": spec, "model": node["name"], "semantic_model": sm["name"], "items": items, "plan": plan,
        "warnings": [w["message"] for w in checked.get("warnings") or []][:10],
        **({"note": note} if note else {}),
    }
    return SemanticDraftResult(changes=changes, summary=summary)


# ── after Accept: dbt parse, then MetricFlow's validation of what was added ──


async def _verify(proposal_id: int, project_id: int, project_path: Path, names: set[str]) -> None:
    from app.refactor import verify  # result lands in result_json["verify"], like refactors

    await verify._record(proposal_id, {"status": "running"})
    try:
        outcome = await verify._parse(project_id, project_path)
        if outcome["status"] == "ok":
            checked = await service.validate(project_path)
            mine = [e["message"] for e in checked.get("errors") or [] if e.get("object_name") in names]
            outcome = (
                {"status": "error", "output": "MetricFlow validation:\n" + "\n".join(mine[:10])} if mine
                else {"status": "ok", "output": "dbt parse and MetricFlow validation passed."}
            )
    except Exception as exc:  # never leave the check stuck in `running`
        log.exception("semantic_verify_crashed", proposal_id=proposal_id)
        outcome = {"status": "error", "output": f"unexpected error: {exc}"}
    await verify._record(proposal_id, outcome)


def start_semantic_verify(proposal_id: int, project_id: int, project_path: Path, result: dict) -> None:
    names = {result.get("semantic_model")} | {i["name"] for i in result.get("items") or [] if i.get("kind") == "metric"}
    asyncio.create_task(_verify(proposal_id, project_id, project_path, {n for n in names if n}))
