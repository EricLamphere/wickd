"""AI test suggestions: generic dbt tests for a model's columns, as a proposed file change.

1. Columns from the warehouse (same probe as documentation) and a data sample,
   summarised per column (nulls, distinct values) so suggestions are grounded.
2. The model picks tests from a schema that only allows real columns, the four
   generic tests and upstream relationship targets; wickd_pro validates again.
3. Every suggestion is pre-checked against the warehouse in ONE `dbt show`
   query, so the review shows which tests pass today.
4. Tests are spliced into the schema YAML (app/dbt/schema_tests.py).
Nothing is written here — the result becomes an AiProposal the user reviews.
"""

import asyncio
from dataclasses import dataclass
from pathlib import Path

from app.ai import pro
from app.ai.client import stream_chat
from app.ai.config import AiConfig
from app.ai.documentation import (
    MAX_AI_COLUMNS,
    FileChange,
    PhaseCallback,
    TextCallback,
    _noop,
    load_manifest_dict,
    node_columns,
)
from app.ai.errors import NothingToPropose, ProposalError
from app.ai.provider import resolve_provider
from app.ai.run_context import tests_on
from app.ai.runtime import llama_server
from app.dbt.runner import RunRequest, runner
from app.dbt.schema_tests import DataTestSpec, add_column_tests
from app.dbt.schema_yaml import RESOURCE_KEYS, DocumentTarget, plan_document_node
from app.dbt.show_parser import parse_show_json
from app.logging_setup import get_logger

log = get_logger(__name__)

SAMPLE_ROWS = 500
MAX_LISTED_VALUES = 12
SHOW_TIMEOUT_S = 60


@dataclass(frozen=True)
class TestsResult:
    change: FileChange
    # {"tests": [{column, test, reason, values?, to?, field?, failures: int | None}]}
    summary: dict


# ── data sample ──────────────────────────────────────────────────────────────


def _is_number(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def column_stats(columns: list[str], rows: list[list]) -> dict:
    """Per column: rows, nulls, distinct; the distinct values when there are few."""
    stats: dict = {}
    for i, name in enumerate(columns):
        values = [row[i] if i < len(row) else None for row in rows]
        present = [v for v in values if v is not None]
        distinct = {repr(v): v for v in present}
        entry = {
            "rows": len(values),
            "nulls": len(values) - len(present),
            "distinct": len(distinct),
            "numeric": bool(present) and all(_is_number(v) for v in present),
            "values": None,
        }
        if 0 < len(distinct) <= MAX_LISTED_VALUES and len(distinct) < len(present):
            entry["values"] = sorted(distinct.values(), key=str)
        stats[name] = entry
    return stats


def _target_args(env: dict[str, str]) -> tuple[str, ...]:
    target = env.get("DBT_TARGET")
    return ("--target", target) if target else ()


async def _show(
    project_id: int, project_path: Path, env: dict[str, str], extra: tuple[str, ...], select: str | None
) -> tuple[list[str], list[list]] | None:
    req = RunRequest(
        project_id=project_id,
        project_path=project_path,
        command="show",
        select=select,
        extra=extra + ("--output", "json") + _target_args(env),
        env=env,
    )
    try:
        async with asyncio.timeout(SHOW_TIMEOUT_S):
            code, stdout, stderr = await runner.run(req)
    except (TimeoutError, OSError) as exc:
        log.info("ai_tests_show_failed", error=str(exc))
        return None
    if code != 0:
        log.info("ai_tests_show_failed", error=stderr.decode(errors="replace")[-300:])
        return None
    cols, rows = parse_show_json(stdout.decode(errors="replace"))
    return (cols, rows) if cols else None


# ── turning suggestions into YAML + a pre-check query ────────────────────────


def _relation(manifest: dict, unique_id: str) -> str | None:
    """Jinja that refers to a node: ref('x') or source('s', 't')."""
    for section in ("nodes", "sources"):
        node = (manifest.get(section) or {}).get(unique_id)
        if isinstance(node, dict):
            if node.get("resource_type") == "source":
                return f"source('{node.get('source_name')}', '{node.get('name')}')"
            return f"ref('{node.get('name')}')"
    return None


def to_spec(test: dict, manifest: dict, stats: dict) -> DataTestSpec | None:
    kind = test["test"]
    if kind in ("not_null", "unique"):
        return DataTestSpec(kind)
    if kind == "accepted_values":
        numeric = (stats.get(test["column"]) or {}).get("numeric", False)
        if numeric:
            try:
                values = [float(v) if "." in v else int(v) for v in test["values"]]
            except ValueError:
                numeric = False
        if numeric:
            return DataTestSpec(kind, {"values": values, "quote": False})
        return DataTestSpec(kind, {"values": test["values"]})
    if kind == "relationships":
        relation = _relation(manifest, test["to"])
        return DataTestSpec(kind, {"to": relation, "field": test["field"]}) if relation else None
    return None


def _sql_literal(v: object) -> str:
    return str(v) if _is_number(v) else "'" + str(v).replace("'", "''") + "'"


def check_sql(model_ref: str, tests: list[tuple[dict, DataTestSpec]]) -> str:
    """One query counting each test's failing rows, so a dbt show checks them all at once."""
    parts = []
    for i, (test, spec) in enumerate(tests):
        col = test["column"]
        if spec.name == "not_null":
            body = f"from {{{{ {model_ref} }}}} where {col} is null"
        elif spec.name == "unique":
            body = (
                f"from (select {col} from {{{{ {model_ref} }}}} where {col} is not null "
                f"group by {col} having count(*) > 1) dupes"
            )
        elif spec.name == "accepted_values":
            values = ", ".join(_sql_literal(v) for v in spec.args["values"])
            body = f"from {{{{ {model_ref} }}}} where {col} is not null and {col} not in ({values})"
        else:  # relationships
            body = (
                f"from {{{{ {model_ref} }}}} child left join {{{{ {spec.args['to']} }}}} parent "
                f"on child.{col} = parent.{spec.args['field']} "
                f"where child.{col} is not null and parent.{spec.args['field']} is null"
            )
        parts.append(f"select {i} as wickd_test, count(*) as failures {body}")
    return "\nunion all\n".join(parts)


async def _precheck(
    project_id: int, project_path: Path, env: dict[str, str], model_ref: str,
    tests: list[tuple[dict, DataTestSpec]],
) -> list[int | None]:
    result = await _show(
        project_id, project_path, env,
        ("--inline", check_sql(model_ref, tests), "--limit", str(len(tests) + 1)), None,
    )
    failures: list[int | None] = [None] * len(tests)
    if result is None:
        return failures
    cols, rows = result
    lower = [c.lower() for c in cols]
    if "wickd_test" not in lower or "failures" not in lower:
        return failures
    t_i, f_i = lower.index("wickd_test"), lower.index("failures")
    for row in rows:
        try:
            failures[int(row[t_i])] = int(row[f_i])
        except (TypeError, ValueError, IndexError):
            continue
    return failures


# ── pipeline ─────────────────────────────────────────────────────────────────


def existing_tests(manifest: dict, unique_id: str) -> list[dict]:
    return [
        {"column": t.get("column_name"), "test": (t.get("test_metadata") or {}).get("name")}
        for t in tests_on(manifest, unique_id)
        if (t.get("test_metadata") or {}).get("name")
    ]


async def generate_tests(
    *,
    project_id: int,
    project_path: Path,
    unique_id: str,
    env: dict[str, str],
    config: AiConfig,
    on_phase: PhaseCallback = _noop,
    on_text: TextCallback = _noop,
) -> TestsResult:
    manifest = await asyncio.to_thread(load_manifest_dict, project_path)
    node = (manifest.get("nodes") or {}).get(unique_id)
    if not isinstance(node, dict):
        raise ProposalError("node not found in the manifest")
    if node.get("resource_type") not in RESOURCE_KEYS or not node.get("original_file_path"):
        raise ProposalError(f"adding tests to a {node.get('resource_type')} is not supported")

    await on_phase("columns")
    columns = (await node_columns(project_id, project_path, node, unique_id, env))[:MAX_AI_COLUMNS]
    if not columns:
        raise ProposalError("no columns found — build the model, or document its columns first")

    await on_phase("sampling")
    sample = await _show(project_id, project_path, env, ("--limit", str(SAMPLE_ROWS)), node["name"])
    stats = column_stats(*sample) if sample else {}

    existing = existing_tests(manifest, unique_id)
    prompt = pro.suggest_tests_prompt(manifest, unique_id, columns, stats, existing)
    await on_phase("writing")
    provider = await resolve_provider(config)
    parts: list[str] = []
    async for delta in stream_chat(
        provider, prompt["messages"], max_tokens=prompt.get("max_tokens"), schema=prompt["schema"]
    ):
        parts.append(delta)
        llama_server.touch()
        await on_text("".join(parts))
    raw = "".join(parts).strip()
    try:
        suggested = pro.parse_suggested_tests(raw, manifest, unique_id, columns, existing)
    except ValueError as exc:
        log.warning("ai_tests_unparseable", unique_id=unique_id, error=str(exc), raw=raw[:500])
        raise ProposalError(f"the model's answer wasn't usable: {exc}") from exc

    pairs = [(t, s) for t in suggested if (s := to_spec(t, manifest, stats)) is not None]
    if not pairs:
        raise NothingToPropose("No new tests worth adding — the existing tests already cover this model.")

    failures: list[int | None] = [None] * len(pairs)
    if sample is not None:
        await on_phase("checking")
        failures = await _precheck(project_id, project_path, env, f"ref('{node['name']}')", pairs)

    target = DocumentTarget(
        name=node["name"],
        resource_type=node["resource_type"],
        original_file_path=node["original_file_path"],
        patch_path=node.get("patch_path"),
    )
    tested_columns = list(dict.fromkeys(t["column"] for t, _ in pairs))
    plan = await asyncio.to_thread(plan_document_node, project_path, target, tested_columns)
    by_column: dict[str, list[DataTestSpec]] = {}
    for test, spec in pairs:
        by_column.setdefault(test["column"], []).append(spec)
    dbt_version = (manifest.get("metadata") or {}).get("dbt_version")
    text = add_column_tests(
        plan.text, plan.file.name, plan.resource_key, target.name, by_column, dbt_version
    )

    summary = {
        "tests": [
            {
                "column": t["column"],
                "test": t["test"],
                "reason": t.get("reason", ""),
                **({"values": t["values"]} if "values" in t else {}),
                **({"to": t["to"].split(".")[-1], "field": t["field"]} if "to" in t else {}),
                "failures": failures[i],
                "key": f"t{i}",
                "spec": {"name": spec.name, "args": spec.args},
            }
            for i, (t, spec) in enumerate(pairs)
        ],
        # how to rebuild the file for a subset of items (app/ai/selection.py)
        "plan": {"resource_key": plan.resource_key, "name": target.name, "dbt_version": dbt_version},
    }
    return TestsResult(change=FileChange(plan.result.path, plan.original, text), summary=summary)
