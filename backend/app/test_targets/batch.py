"""Tests for many columns at once (Test gaps → "Generate tests for selected").

The chosen ranking rows become one "tests" proposal with a file per schema
YAML touched (`batch: true` in its result; each item names its file, node and
resource key, so partial accept rebuilds one file — app/ai/selection.py). Only
the lineage-backed candidates are used: no LLM, so it's quick and works
without an AI model. Each model's tests are pre-checked against the warehouse
in one `dbt show`, model by model through the runner (the per-project lock
serialises them anyway).
"""

from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

from app.ai.documentation import FileChange
from app.ai.test_generation import existing_tests, precheck_tests, summary_item, to_spec
from app.dbt.schema_tests import DataTestSpec
from app.dbt.schema_yaml import DocumentTarget, SchemaYamlError, plan_document_node
from app.logging_setup import get_logger
from app.propagation.inputs import writable_nodes
from app.test_targets.items import render_tests, structural_tests, suggestion_key

log = get_logger(__name__)

ProgressCallback = Callable[[int, int, str], Awaitable[None]]


def row_key(row: dict) -> str:
    """Stable id of a ranking row, for selecting it from the UI."""
    column = row.get("column")
    label = column if column else "(" + ", ".join(row.get("columns") or []) + ")"
    return f"{row['unique_id']}::{label}"


@dataclass
class BatchResult:
    changes: list[FileChange] = field(default_factory=list)
    tests: list[dict] = field(default_factory=list)  # proposal items (each with "file")
    skipped: list[dict] = field(default_factory=list)  # [{unique_id, reason}]


@dataclass
class _ModelTests:
    unique_id: str
    node: dict
    pairs: list[tuple[dict, DataTestSpec]]


def plan_models(manifest: dict, rows: Iterable[dict]) -> tuple[list[_ModelTests], list[dict]]:
    """Group the rows' candidates per writable model, minus tests that already exist."""
    writable = writable_nodes(manifest)
    by_uid: dict[str, list[dict]] = {}
    for row in rows:
        by_uid.setdefault(row["unique_id"], []).append(row)
    models: list[_ModelTests] = []
    skipped: list[dict] = []
    for uid, model_rows in by_uid.items():
        node = writable.get(uid)
        if node is None:
            skipped.append({"unique_id": uid, "reason": "not a model, seed or snapshot of this project"})
            continue
        seen = {suggestion_key(e) for e in existing_tests(manifest, uid) if e.get("test")}
        pairs: list[tuple[dict, DataTestSpec]] = []
        for test in structural_tests(model_rows):
            spec = to_spec(test, manifest, {})
            if spec is None or suggestion_key(test) in seen:
                continue
            seen.add(suggestion_key(test))
            pairs.append((test, spec))
        if pairs:
            models.append(_ModelTests(uid, node, pairs))
    return models, skipped


async def build_batch(
    project_id: int,
    project_path: Path,
    env: dict[str, str],
    manifest: dict,
    rows: list[dict],
    on_model: ProgressCallback,
) -> BatchResult:
    models, skipped = plan_models(manifest, rows)
    dbt_version = (manifest.get("metadata") or {}).get("dbt_version")
    result = BatchResult(skipped=skipped)
    files: dict[str, dict] = {}  # path → {"original", "text"}
    for index, model in enumerate(models):
        name = model.node["name"]
        await on_model(index, len(models), name)
        target = DocumentTarget(
            name=name,
            resource_type=model.node["resource_type"],
            original_file_path=model.node["original_file_path"],
            patch_path=model.node.get("patch_path"),
        )
        try:
            plan = plan_document_node(project_path, target, [])
        except SchemaYamlError as exc:
            result.skipped.append({"unique_id": model.unique_id, "reason": str(exc)})
            continue
        failures = await precheck_tests(project_id, project_path, env, f"ref('{name}')", model.pairs)
        path = plan.result.path
        state = files.setdefault(path, {"original": plan.original, "text": plan.original})
        offset = len(result.tests)
        items = [
            {
                **summary_item(offset + i, test, spec, failures[i]),
                "file": path,
                "unique_id": model.unique_id,
                "name": name,
                "resource_key": plan.resource_key,
            }
            for i, (test, spec) in enumerate(model.pairs)
        ]
        try:
            state["text"] = render_tests(state["text"], plan.file.name, plan.resource_key, name, items, dbt_version)
        except SchemaYamlError as exc:
            result.skipped.append({"unique_id": model.unique_id, "reason": str(exc)})
            continue
        result.tests.extend(items)

    result.changes = [
        FileChange(path, state["original"], state["text"])
        for path, state in files.items()
        if state["text"] is not None and state["text"] != state["original"]
    ]
    changed = {c.path for c in result.changes}
    result.tests = [t for t in result.tests if t["file"] in changed]
    return result
