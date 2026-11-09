import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.dbt.semantic_nodes import SEMANTIC_SECTIONS, semantic_info
from app.logging_setup import get_logger

log = get_logger(__name__)


@dataclass(frozen=True)
class ColumnInfo:
    name: str
    description: str
    data_type: str
    # constraint types declared on the column (not_null, unique, primary_key, …)
    constraints: tuple[str, ...] = ()


@dataclass(frozen=True)
class ModelNode:
    unique_id: str
    name: str
    resource_type: str  # model, seed, source, snapshot, test, exposure
    schema_: str | None
    database: str | None
    materialized: str | None
    tags: tuple[str, ...]
    description: str
    original_file_path: str | None
    raw_sql: str | None
    compiled_sql: str | None = None
    source_name: str | None = None  # set for resource_type == "source"
    columns: tuple[ColumnInfo, ...] = field(default_factory=tuple)
    # test-only fields for locating a test in its YAML schema file
    test_metadata_name: str | None = None  # e.g. "unique", "not_null", "relationships"
    column_name: str | None = None  # column the test applies to, if any
    attached_node: str | None = None  # unique_id of the model this test is attached to
    # path to the schema YAML file that defines this node's description/columns
    # format: "package_name://models/subdir/schema.yml"; None if no schema file exists
    patch_path: str | None = None
    # semantic_model / metric / saved_query only
    label: str | None = None
    semantic: dict[str, Any] | None = field(default=None, hash=False, compare=False)
    # model governance: `contract: {enforced: true}`, model-level constraint types, versions, access
    contract_enforced: bool = False
    constraints: tuple[str, ...] = ()
    version: str | None = None
    latest_version: str | None = None
    access: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "unique_id": self.unique_id,
            "name": self.name,
            "resource_type": self.resource_type,
            "schema": self.schema_,
            "database": self.database,
            "materialized": self.materialized,
            "tags": list(self.tags),
            "description": self.description,
            "original_file_path": self.original_file_path,
            "source_name": self.source_name,
            "columns": [
                {"name": c.name, "description": c.description, "data_type": c.data_type,
                 "constraints": list(c.constraints)}
                for c in self.columns
            ],
            "test_metadata_name": self.test_metadata_name,
            "column_name": self.column_name,
            "attached_node": self.attached_node,
            "patch_path": self.patch_path,
            "label": self.label,
            "semantic": self.semantic,
            "contract_enforced": self.contract_enforced,
            "constraints": list(self.constraints),
            "version": self.version,
            "latest_version": self.latest_version,
            "access": self.access,
        }


@dataclass(frozen=True)
class UnitTestRef:
    """A dbt 1.8+ unit test. Kept out of `Manifest.nodes` so it never appears in the DAG."""

    unique_id: str
    name: str
    model: str | None  # name of the model under test
    original_file_path: str | None
    model_unique_id: str | None = None  # the model under test's unique_id (depends_on)
    description: str = ""
    # `given[].input` in order, e.g. "ref('stg_orders')", "source('shop', 'orders')", "this"
    inputs: tuple[str, ...] = ()
    # raw `given` / `expect` / `overrides` from the manifest (plain JSON)
    given: tuple[dict[str, Any], ...] = field(default=(), hash=False, compare=False)
    expect: dict[str, Any] | None = field(default=None, hash=False, compare=False)
    overrides: dict[str, Any] | None = field(default=None, hash=False, compare=False)


@dataclass(frozen=True)
class Manifest:
    nodes: tuple[ModelNode, ...]
    parents: dict[str, tuple[str, ...]]  # unique_id -> parent unique_ids
    unit_tests: tuple[UnitTestRef, ...] = ()

    def edges(self) -> list[tuple[str, str]]:
        pairs: list[tuple[str, str]] = []
        node_ids = {n.unique_id for n in self.nodes}
        for child, parents in self.parents.items():
            if child not in node_ids:
                continue
            for parent in parents:
                if parent in node_ids:
                    pairs.append((parent, child))
        return pairs


_NODE_RESOURCE_TYPES = {"model", "seed", "snapshot", "test"}


def _constraint_types(raw: Any) -> tuple[str, ...]:
    if not isinstance(raw, list):
        return ()
    return tuple(str(c["type"]) for c in raw if isinstance(c, dict) and c.get("type"))


def _version(raw: Any) -> str | None:
    return None if raw is None or raw == "" else str(raw)


def _contract_enforced(raw: dict[str, Any], config: Any) -> bool:
    contract = raw.get("contract") if isinstance(raw.get("contract"), dict) else None
    if contract is None and isinstance(config, dict) and isinstance(config.get("contract"), dict):
        contract = config["contract"]
    return bool(contract and contract.get("enforced"))


def _extract_node(
    unique_id: str, raw: dict[str, Any], *, allowed_types: set[str] = _NODE_RESOURCE_TYPES
) -> ModelNode | None:
    resource_type = raw.get("resource_type")
    if resource_type not in allowed_types:
        return None
    config = raw.get("config") or {}
    raw_columns: dict[str, Any] = raw.get("columns") or {}
    columns = tuple(
        ColumnInfo(
            name=k,
            description=v.get("description") or "" if isinstance(v, dict) else "",
            data_type=v.get("data_type") or "" if isinstance(v, dict) else "",
            constraints=_constraint_types(v.get("constraints")) if isinstance(v, dict) else (),
        )
        for k, v in raw_columns.items()
    )
    test_meta = raw.get("test_metadata") if isinstance(raw.get("test_metadata"), dict) else {}
    return ModelNode(
        unique_id=unique_id,
        name=raw.get("name") or unique_id.split(".")[-1],
        resource_type=resource_type,
        schema_=raw.get("schema"),
        database=raw.get("database"),
        materialized=config.get("materialized") if isinstance(config, dict) else None,
        tags=tuple(raw.get("tags") or ()),
        description=raw.get("description") or "",
        original_file_path=raw.get("original_file_path"),
        raw_sql=raw.get("raw_code") or raw.get("raw_sql"),
        compiled_sql=raw.get("compiled_code") or raw.get("compiled_sql"),
        source_name=raw.get("source_name") if resource_type == "source" else None,
        columns=columns,
        test_metadata_name=test_meta.get("name") if resource_type == "test" else None,
        column_name=raw.get("column_name") if resource_type == "test" else None,
        attached_node=raw.get("attached_node") if resource_type == "test" else None,
        patch_path=raw.get("patch_path"),
        contract_enforced=resource_type == "model" and _contract_enforced(raw, config),
        constraints=_constraint_types(raw.get("constraints")) if resource_type == "model" else (),
        version=_version(raw.get("version")) if resource_type == "model" else None,
        latest_version=_version(raw.get("latest_version")) if resource_type == "model" else None,
        access=raw.get("access") if resource_type == "model" and isinstance(raw.get("access"), str) else None,
    )


def _extract_unit_tests(raw_unit_tests: Any) -> tuple[UnitTestRef, ...]:
    if not isinstance(raw_unit_tests, dict):
        return ()
    refs: list[UnitTestRef] = []
    for unique_id, raw in raw_unit_tests.items():
        if not isinstance(raw, dict):
            continue
        given = tuple(g for g in raw.get("given") or () if isinstance(g, dict))
        depends = (raw.get("depends_on") or {}).get("nodes") if isinstance(raw.get("depends_on"), dict) else None
        model_uid = next(
            (n for n in depends or () if isinstance(n, str) and n.startswith(("model.", "snapshot."))), None
        )
        refs.append(UnitTestRef(
            unique_id=unique_id,
            name=raw.get("name") or unique_id.split(".")[-1],
            model=raw.get("model"),
            original_file_path=raw.get("original_file_path"),
            model_unique_id=model_uid,
            description=raw.get("description") or "",
            inputs=tuple(str(g.get("input")) for g in given if g.get("input")),
            given=given,
            expect=raw.get("expect") if isinstance(raw.get("expect"), dict) else None,
            overrides=raw.get("overrides") if isinstance(raw.get("overrides"), dict) else None,
        ))
    return tuple(refs)


def _extract_semantic_nodes(raw_section: Any, resource_type: str) -> list[ModelNode]:
    if not isinstance(raw_section, dict):
        return []
    nodes: list[ModelNode] = []
    for unique_id, raw in raw_section.items():
        if not isinstance(raw, dict):
            continue
        try:
            info = semantic_info(resource_type, raw)
        except (TypeError, AttributeError, KeyError) as exc:
            log.warning("semantic_node_parse_failed", unique_id=unique_id, error=str(exc))
            info = None
        config = raw.get("config") if isinstance(raw.get("config"), dict) else {}
        nodes.append(ModelNode(
            unique_id=unique_id,
            name=raw.get("name") or unique_id.split(".")[-1],
            resource_type=resource_type,
            schema_=None,
            database=None,
            materialized=None,
            tags=tuple(t for t in (raw.get("tags") or config.get("tags") or ()) if isinstance(t, str)),
            description=raw.get("description") or "",
            original_file_path=raw.get("original_file_path"),
            raw_sql=None,
            label=raw.get("label") or None,
            semantic=info,
        ))
    return nodes


def load_manifest(manifest_path: Path) -> Manifest | None:
    if not manifest_path.exists():
        return None
    try:
        data = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("manifest_read_failed", path=str(manifest_path), error=str(exc))
        return None

    nodes: list[ModelNode] = []
    parents: dict[str, tuple[str, ...]] = {}

    raw_nodes: dict[str, Any] = data.get("nodes") or {}
    for unique_id, raw in raw_nodes.items():
        node = _extract_node(unique_id, raw)
        if node is not None:
            nodes.append(node)

    raw_sources: dict[str, Any] = data.get("sources") or {}
    for unique_id, raw in raw_sources.items():
        node = _extract_node(unique_id, {**raw, "resource_type": "source"}, allowed_types={"source"})
        if node is not None:
            nodes.append(node)

    raw_exposures: dict[str, Any] = data.get("exposures") or {}
    for unique_id, raw in raw_exposures.items():
        node = _extract_node(unique_id, {**raw, "resource_type": "exposure"}, allowed_types={"exposure"})
        if node is not None:
            nodes.append(node)

    for section, resource_type in SEMANTIC_SECTIONS.items():
        nodes.extend(_extract_semantic_nodes(data.get(section), resource_type))

    # parent_map in manifest.json: { unique_id: [parent_ids] }
    parent_map = data.get("parent_map") or {}
    if isinstance(parent_map, dict):
        for child, parent_list in parent_map.items():
            if isinstance(parent_list, list):
                parents[child] = tuple(p for p in parent_list if isinstance(p, str))

    return Manifest(
        nodes=tuple(nodes),
        parents=parents,
        unit_tests=_extract_unit_tests(data.get("unit_tests")),
    )
