"""Run one refactor operation: read the project, call the engine, add what the public
side owns (the YAML stub for an extracted model). Blocking; call it in a thread."""

from pathlib import Path

from app.ai.documentation import load_manifest_dict
from app.ai.errors import ProposalError
from app.dbt.schema_yaml import DocumentTarget, SchemaYamlError, plan_document_node
from app.refactor import inputs, pro


class RefactorFailed(Exception):
    """The engine refused the operation or the project couldn't be read; message is user-facing."""


def run(project_path: Path, operation: dict, lineage: dict) -> dict:
    """The engine's result ({changes, manual, notes, summary}) for `operation`."""
    try:
        manifest = load_manifest_dict(project_path)
        files = inputs.project_files(project_path)
    except (ProposalError, inputs.TooManyFiles) as exc:
        raise RefactorFailed(str(exc)) from exc
    op, uid, new = operation["op"], operation["unique_id"], operation["new_name"]
    try:
        if op == "rename_model":
            result = pro.rename_model(manifest, files, uid, new)
        elif op == "rename_column":
            result = pro.rename_column(manifest, files, lineage, uid, operation["column"], new)
        elif op == "extract_cte":
            result = pro.extract_cte(manifest, files, uid, operation["cte"], new)
            result = _with_yaml_stub(project_path, result)
        else:
            raise RefactorFailed(f"unknown refactor `{op}`")
    except ValueError as exc:  # the engine's RefactorError
        raise RefactorFailed(str(exc)) from exc
    return result


def _with_yaml_stub(project_path: Path, result: dict) -> dict:
    """Add a `- name:` entry (and column stubs) for the extracted model to its folder's YAML."""
    summary = result["summary"]
    target = DocumentTarget(
        name=summary["new"], resource_type="model", original_file_path=summary["new_path"], patch_path=None
    )
    try:
        planned = plan_document_node(project_path, target, summary.get("columns") or [])
    except SchemaYamlError as exc:
        notes = [*result["notes"], f"No YAML entry was added for `{summary['new']}`: {exc}"]
        return {**result, "notes": notes}
    path = planned.result.path
    if any(c["path"] == path for c in result["changes"]):
        return result  # the engine already edits that file; leave the stub to the user
    change = {
        "op": "create" if planned.original is None else "modify",
        "path": path, "original": planned.original, "proposed": planned.text,
    }
    return {**result, "changes": [*result["changes"], change]}
