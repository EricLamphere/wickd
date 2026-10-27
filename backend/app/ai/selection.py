"""Rebuild a proposal's file for a subset of its items (some tests, some descriptions).

Proposals keep what they generated plus a small `plan` (see the summaries in
documentation.py / test_generation.py), so the file can be re-derived from the
text it was made against with only the items the user ticked — through the
same splicers and safety checks as the original, never by editing the diff.

Lineage propagation proposals (kind "propagate", app/propagation/proposals.py)
span several files: each item names its file, and only that file's items are
rebuilt.
"""

from pathlib import PurePosixPath

from app.dbt.schema_descriptions import set_descriptions
from app.dbt.schema_tests import DataTestSpec, add_column_tests
from app.dbt.schema_yaml import node_text
from app.propagation import proposals as propagation

DESCRIPTION_KEY = "description"
COLUMN_PREFIX = "col:"


class SelectionError(ValueError):
    """The selection names items this proposal doesn't have, or can't be rebuilt."""


def item_keys(kind: str, result: dict, path: str | None = None) -> list[str]:
    """The proposal's items (for a multi-file proposal, those in the file at `path`)."""
    if kind == propagation.KIND:
        return [i["key"] for i in result.get("items") or [] if path is None or i.get("file") == path]
    if kind == "tests":
        return [t["key"] for t in result.get("tests") or [] if "key" in t]
    if kind == "document":
        keys = [DESCRIPTION_KEY] if result.get("description") else []
        return keys + [COLUMN_PREFIX + c for c in result.get("columns") or {}]
    return []


def rebuild(kind: str, result: dict, original: str | None, path: str, keys: list[str]) -> str:
    """The file at `path` rebuilt from `original` with only the items in `keys`."""
    filename = PurePosixPath(path).name
    if kind == propagation.KIND:
        available = item_keys(kind, result, path)
        unknown = set(keys) - set(available)
        if not available or unknown:
            raise SelectionError(f"unknown items: {', '.join(sorted(unknown))}" if unknown else "no items in this file")
        chosen = set(keys)
        items = [i for i in result["items"] if i.get("file") == path and i["key"] in chosen]
        return propagation.render_file(original, filename, items)

    plan = result.get("plan")
    available = item_keys(kind, result)
    if not plan or not available:
        raise SelectionError("this proposal can't be partially accepted")
    unknown = set(keys) - set(available)
    if unknown:
        raise SelectionError(f"unknown items: {', '.join(sorted(unknown))}")
    chosen = set(keys)

    if kind == "tests":
        tests = [t for t in result["tests"] if t.get("key") in chosen]
        by_column: dict[str, list[DataTestSpec]] = {}
        for t in tests:
            by_column.setdefault(t["column"], []).append(DataTestSpec(t["spec"]["name"], t["spec"]["args"]))
        if not by_column:
            return original or ""
        text = node_text(original, filename, plan["resource_key"], plan["name"], list(by_column))
        return add_column_tests(
            text, filename, plan["resource_key"], plan["name"], by_column, plan.get("dbt_version")
        )

    # document: the node's entry + column stubs as originally planned, then chosen descriptions
    text = node_text(original, filename, plan["resource_key"], plan["name"], plan.get("columns") or [])
    columns = {
        name: desc for name, desc in (result.get("columns") or {}).items() if COLUMN_PREFIX + name in chosen
    }
    description = result.get("description") if DESCRIPTION_KEY in chosen else None
    return set_descriptions(
        text, filename, plan["resource_key"], plan["name"], description, columns,
        overwrite=bool(plan.get("overwrite")),
    ).text
