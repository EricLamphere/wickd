"""Docs data for the native docs browsers: a project's manifest + catalog as one clean blob.

Pure over parsed JSON; `load_docs_data()` reads the copies docs generation keeps in the
data dir. Served per project by api/docs.py, which the home page's combined docs also use.
"""

import json
from pathlib import Path
from typing import Any

from app.dbt.semantic_nodes import SEMANTIC_SECTIONS, semantic_info


class DocsNotGenerated(Exception):
    """No docs have been generated for this project yet."""


class DocsUnreadable(Exception):
    """The generated manifest exists but can't be read."""


def load_docs_data(docs_dir: Path) -> dict[str, Any]:
    """Blocking (parses JSON): run in a thread. Raises DocsNotGenerated / DocsUnreadable."""
    manifest_path = docs_dir / "manifest.json"
    catalog_path = docs_dir / "catalog.json"
    if not manifest_path.exists():
        raise DocsNotGenerated
    try:
        manifest: dict[str, Any] = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DocsUnreadable(str(exc)) from exc

    catalog_nodes: dict[str, Any] = {}
    if catalog_path.exists():
        try:
            catalog_nodes = json.loads(catalog_path.read_text(encoding="utf-8")).get("nodes", {})
        except (OSError, json.JSONDecodeError):
            pass  # a missing catalog only loses column types
    return build_docs_data(manifest, catalog_nodes)


def build_docs_data(manifest: dict[str, Any], catalog_nodes: dict[str, Any]) -> dict[str, Any]:
    """Merge a parsed manifest and the catalog's `nodes` for rendering."""
    child_map: dict[str, list[str]] = manifest.get("child_map") or {}
    parent_map: dict[str, list[str]] = manifest.get("parent_map") or {}

    # Build a lookup: test uid → {attached_node, column_name, test_name}
    nodes_raw: dict[str, Any] = manifest.get("nodes", {})
    sources_raw: dict[str, Any] = manifest.get("sources", {})
    macros_raw: dict[str, Any] = manifest.get("macros", {})

    # index tests by attached_node + column_name for column-level test badges
    tests_by_node: dict[str, list[dict[str, Any]]] = {}
    for uid, raw in nodes_raw.items():
        if raw.get("resource_type") != "test":
            continue
        attached = raw.get("attached_node") or ""
        col = raw.get("column_name") or ""
        test_meta = raw.get("test_metadata") or {}
        tests_by_node.setdefault(attached, []).append({
            "uid": uid,
            "name": test_meta.get("name") or raw.get("name") or "",
            "column_name": col,
            "kwargs": test_meta.get("kwargs") or {},
        })

    def _merge_node(uid: str, raw: dict[str, Any]) -> dict[str, Any]:
        resource_type = raw.get("resource_type", "")
        config = raw.get("config") or {}

        # Catalog entry for this node
        catalog_entry = catalog_nodes.get(uid, {})
        cat_meta = catalog_entry.get("metadata") or {}
        catalog_cols: dict[str, Any] = catalog_entry.get("columns") or {}

        # Merge manifest + catalog columns; prefer catalog order (index-sorted)
        manifest_cols: dict[str, Any] = raw.get("columns") or {}
        # Use catalog column order when available, fall back to manifest order
        if catalog_cols:
            ordered_cols = sorted(catalog_cols.keys(), key=lambda c: catalog_cols[c].get("index", 0))
        else:
            ordered_cols = list(manifest_cols.keys())

        # Node-level tests indexed by column
        node_tests = tests_by_node.get(uid, [])
        tests_by_col: dict[str, list[str]] = {}
        node_level_tests: list[str] = []
        for t in node_tests:
            col = t["column_name"]
            if col:
                tests_by_col.setdefault(col, []).append(t["name"])
            else:
                node_level_tests.append(t["name"])

        merged_columns: list[dict[str, Any]] = []
        for col_name in ordered_cols:
            mc = manifest_cols.get(col_name) or {}
            cc = catalog_cols.get(col_name) or {}
            merged_columns.append({
                "name": col_name,
                "description": mc.get("description") or "",
                "data_type": cc.get("type") or mc.get("data_type") or "",
                "meta": mc.get("meta") or {},
                "tags": mc.get("tags") or [],
                "constraints": mc.get("constraints") or [],
                "tests": tests_by_col.get(col_name, []),
            })

        # children split into models and tests
        children = child_map.get(uid, [])
        child_models = [c for c in children if not c.startswith("test.")]
        child_tests = [c for c in children if c.startswith("test.")]
        parents = parent_map.get(uid, [])

        return {
            "unique_id": uid,
            "name": raw.get("name") or uid.split(".")[-1],
            "resource_type": resource_type,
            "schema": raw.get("schema"),
            "database": raw.get("database"),
            "package_name": raw.get("package_name"),
            "path": raw.get("original_file_path") or raw.get("path"),
            "language": raw.get("language"),
            "materialized": config.get("materialized") if isinstance(config, dict) else None,
            "access": config.get("access") if isinstance(config, dict) else None,
            "group": config.get("group") if isinstance(config, dict) else None,
            "contract": (config.get("contract") or {}).get("enforced", False) if isinstance(config, dict) else False,
            "relation_name": raw.get("relation_name"),
            "owner": cat_meta.get("owner"),
            "catalog_type": cat_meta.get("type"),  # BASE TABLE, VIEW, etc.
            "tags": raw.get("tags") or [],
            "description": raw.get("description") or "",
            "meta": raw.get("meta") or {},
            "columns": merged_columns,
            "node_level_tests": node_level_tests,
            "raw_code": raw.get("raw_code") or raw.get("raw_sql") or "",
            "compiled_code": raw.get("compiled_code") or raw.get("compiled_sql") or "",
            "depends_on_nodes": (raw.get("depends_on") or {}).get("nodes") or [],
            "depends_on_macros": (raw.get("depends_on") or {}).get("macros") or [],
            "refs": [r.get("name") if isinstance(r, dict) else r for r in (raw.get("refs") or [])],
            "sources": raw.get("sources") or [],
            "child_models": child_models,
            "child_tests": child_tests,
            "parents": parents,
            # test-specific
            "attached_node": raw.get("attached_node"),
            "column_name": raw.get("column_name"),
            "test_metadata": raw.get("test_metadata"),
        }

    result_nodes: list[dict[str, Any]] = []
    for uid, raw in {**nodes_raw, **sources_raw}.items():
        resource_type = raw.get("resource_type", "")
        if resource_type not in {"model", "seed", "snapshot", "test", "source", "analysis"}:
            continue
        result_nodes.append(_merge_node(uid, raw))

    for section, resource_type in SEMANTIC_SECTIONS.items():
        raw_section = manifest.get(section)
        if not isinstance(raw_section, dict):
            continue
        for uid, raw in raw_section.items():
            if not isinstance(raw, dict):
                continue
            merged = _merge_node(uid, {**raw, "resource_type": resource_type, "columns": {}})
            merged["relation_name"] = (raw.get("node_relation") or {}).get("relation_name")
            merged["label"] = raw.get("label") or None
            try:
                merged["semantic"] = semantic_info(resource_type, raw)
            except (TypeError, AttributeError, KeyError):
                merged["semantic"] = None
            result_nodes.append(merged)

    # Macros — only those with docs.show = true (default) and include all packages
    result_macros: list[dict[str, Any]] = []
    for uid, raw in macros_raw.items():
        docs_cfg = (raw.get("docs") or raw.get("config", {}).get("docs") or {})
        if docs_cfg.get("show") is False:
            continue
        children = child_map.get(uid, [])
        parents = parent_map.get(uid, [])
        result_macros.append({
            "unique_id": uid,
            "name": raw.get("name") or uid.split(".")[-1],
            "resource_type": "macro",
            "package_name": raw.get("package_name"),
            "path": raw.get("original_file_path") or raw.get("path"),
            "description": raw.get("description") or "",
            "meta": raw.get("meta") or {},
            "arguments": raw.get("arguments") or [],
            "macro_sql": raw.get("macro_sql") or "",
            "depends_on_macros": (raw.get("depends_on") or {}).get("macros") or [],
            "child_models": [c for c in children if not c.startswith("test.")],
            "child_tests": [c for c in children if c.startswith("test.")],
            "parents": parents,
            "tags": [],
        })

    # Sort nodes: models first, then seeds/snapshots/sources/tests, then by name
    order = {
        "model": 0, "seed": 1, "snapshot": 2, "source": 3, "analysis": 4, "test": 5,
        "semantic_model": 6, "metric": 7, "saved_query": 8,
    }
    result_nodes.sort(key=lambda n: (order.get(n["resource_type"], 9), n["name"]))
    result_macros.sort(key=lambda n: (n["package_name"] or "", n["name"]))

    metadata: dict[str, Any] = manifest.get("metadata") or {}
    project_name: str = metadata.get("project_name") or ""

    # Extract project overview from the docs block (may be project-specific or dbt default)
    docs_blocks: dict[str, Any] = manifest.get("docs") or {}
    project_overview_uid = f"doc.{project_name}.__overview__"
    overview_block = docs_blocks.get(project_overview_uid) or docs_blocks.get("doc.dbt.__overview__") or {}
    project_description: str = overview_block.get("block_contents") or ""

    return {
        "nodes": result_nodes,
        "macros": result_macros,
        "project_name": project_name,
        "adapter_type": metadata.get("adapter_type") or "",
        "project_description": project_description,
    }
