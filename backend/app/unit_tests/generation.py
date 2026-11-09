"""Generate a dbt unit test for a model, as a proposed file change (plan 19, Pro).

1. Compile the model (incremental models with --full-refresh: a unit test runs the
   full-refresh branch unless it overrides is_incremental) and read each input's
   columns + types from the warehouse.
2. wickd_pro plans which rows to sample: per input, rows that hit each simple
   branch (CASE / WHERE / JOIN conditions), NULLs in filter columns, unmatched join
   keys; joined inputs are sampled for the keys already picked. Up to 5 rows per
   input, only the columns the model reads. Each query is a read-only `dbt show`.
3. The model's SQL is rewritten to read those rows instead of the real tables and
   run once: its output becomes `expect:` — "what the model produces today", never
   claimed to be correct; the user reviews it.
4. The entry is spliced into the model's YAML (app/dbt/schema_unit_tests.py).

Optional: mask text values (deterministic fakes, join keys kept consistent) before
the expectation runs, so real values don't land in the repo; write to a file the
user picked or named (app/unit_tests/files.py) instead of the default location.
"""

import asyncio
from dataclasses import dataclass
from pathlib import Path

from app.ai.config import AiConfig
from app.ai.documentation import FileChange, PhaseCallback, TextCallback, _noop, load_manifest_dict
from app.dbt.probe import probe_relations
from app.dbt.schema_unit_tests import add_unit_test
from app.dbt.schema_yaml import SchemaYamlError, _inside, _read
from app.unit_tests import pro
from app.unit_tests.context import (
    EXPECT_LIMIT,
    UnitTestError,
    check_model,
    compile_model,
    fixture_format,
    model_inputs,
    show_inline,
    target_file,
    unit_test_name,
    unit_tests_for,
)
from app.unit_tests.files import resolve_file

KIND = "unit_test"
SAMPLE_LIMIT = 50
MAX_ROUNDS = 8


@dataclass(frozen=True)
class UnitTestResult:
    change: FileChange
    summary: dict


def _table(rows: list[dict], columns: list[str] | None = None) -> dict:
    cols = columns or list(dict.fromkeys(k for row in rows for k in row))
    return {"columns": cols, "rows": [[row.get(c) for c in cols] for row in rows]}


async def _input_columns(
    project_id: int, project_path: Path, env: dict[str, str], inputs: list[dict]
) -> list[dict]:
    probe = await probe_relations(project_id, project_path, {i["key"]: i["key"] for i in inputs}, env, env.get("DBT_TARGET"))
    if probe is None:
        raise UnitTestError("couldn't read the inputs' columns from the warehouse — check the connection and build them")
    missing = [key for key, result in probe.items() if result.not_built]
    if missing:
        raise UnitTestError(f"{', '.join(missing)} isn't built in the warehouse yet — build it first")
    return [
        {"key": i["key"], "relation": i["relation"], "columns": list(probe[i["key"]].columns),
         "types": list(probe[i["key"]].types)}
        for i in inputs
    ]


async def _sample(
    project_id: int, project_path: Path, env: dict[str, str], plan: dict, inputs: list[dict]
) -> dict[str, list[dict]]:
    fixtures: dict[str, list[dict]] = {}
    for _ in range(MAX_ROUNDS):
        queries = pro.next_queries(plan, inputs, fixtures)
        if not queries:
            break
        for key, sql in queries.items():
            columns, rows = await show_inline(project_id, project_path, env, sql, SAMPLE_LIMIT)
            fixtures[key] = pro.pick_rows(columns, rows) if columns else []
    return fixtures


def _description(plan: dict, rows: int) -> str:
    branches = [p["sql"] for p in plan.get("predicates") or []][:4]
    covers = f" covering {'; '.join(branches)}" if branches else ""
    return f"What the model produced on {rows} sampled input rows{covers} (drafted by wickd; review the rows)."


async def generate_unit_test(
    *,
    project_id: int,
    project_path: Path,
    unique_id: str,
    env: dict[str, str],
    config: AiConfig | None = None,  # unused: same signature as the other generators
    on_phase: PhaseCallback = _noop,
    on_text: TextCallback = _noop,
    focus: str | None = None,
    mask: bool = False,
    file: str | None = None,
) -> UnitTestResult:
    manifest = await asyncio.to_thread(load_manifest_dict, project_path)
    node = check_model(manifest, unique_id)
    adapter = (manifest.get("metadata") or {}).get("adapter_type")

    await on_phase("columns")
    incremental = (node.get("config") or {}).get("materialized") == "incremental"
    sql = await compile_model(project_id, project_path, node["name"], env, incremental)
    inputs = await _input_columns(project_id, project_path, env, model_inputs(manifest, unique_id))
    plan = pro.plan_unit_test(sql, adapter, inputs, focus, node.get("relation_name"))
    if plan.get("refusal"):
        raise UnitTestError(f"can't draft a unit test for {node['name']}: {plan['refusal']}")

    await on_phase("sampling")
    fixtures = await _sample(project_id, project_path, env, plan, inputs)
    if not any(fixtures.values()):
        raise UnitTestError("the model's inputs have no rows to sample — build or seed them first")
    if mask:
        fixtures = pro.mask_fixtures(plan, fixtures)

    await on_phase("expecting")
    try:
        expect_sql = pro.expectation_sql(plan, sql, inputs, fixtures)
    except ValueError as exc:
        raise UnitTestError(f"can't run {node['name']} on the sampled rows: {exc}") from exc
    out_columns, out_rows = await show_inline(project_id, project_path, env, expect_sql, EXPECT_LIMIT)
    expected = [dict(zip(out_columns, row, strict=False)) for row in out_rows]
    wanted = {c.lower() for c in pro.expect_columns(plan, focus)}
    columns = [c for c in out_columns if c.lower() in wanted] or out_columns

    await on_phase("writing")
    existing = {u.get("name") for u in unit_tests_for(manifest, node["name"])}
    name = unit_test_name(node["name"], focus, {n for n in existing if n})
    fmt = fixture_format(manifest)
    item = pro.build_item(
        name=name, model=node["name"], description=_description(plan, sum(len(r) for r in fixtures.values())),
        inputs=[i["key"] for i in inputs], fixtures=fixtures, columns=columns, expected=expected, fmt=fmt,
    )
    # the user's choice (an existing YAML file or a new name), else the default location
    path = resolve_file(project_path, file, node["original_file_path"]) if file else target_file(project_path, manifest, node)
    original = await asyncio.to_thread(_read_optional, project_path, path)
    try:
        text = add_unit_test(original, Path(path).name, item)
    except SchemaYamlError as exc:
        raise UnitTestError(str(exc)) from exc

    summary = {
        "unit_test": {"name": name, "model": node["name"], "file": path, "format": fmt},
        "fixtures": [{"input": key, **_table(rows)} for key, rows in fixtures.items()],
        "expected": _table(expected, columns),
        "branches": [p["sql"] for p in plan.get("predicates") or []],
        "focus": focus,
        "masked": mask,
        "incremental": incremental,
        "notes": list(plan.get("notes") or []) + (
            ["Generated for the full-refresh branch (is_incremental() false)."] if incremental else []
        ),
    }
    return UnitTestResult(change=FileChange(path, original, text), summary=summary)


def _read_optional(project_path: Path, relative: str) -> str | None:
    root = project_path.resolve()
    path = _inside(root, relative)
    return _read(path) if path.exists() else None
