"""Manifest → the plain dicts sent to wickd_pro.propagation (see pro.py). Pure."""

from app.dbt.schema_yaml import RESOURCE_KEYS

DEFAULT_TAGS = ("pii", "sensitive")
TAGS_SETTING = "PROPAGATE_TAGS"


def _documentable(manifest: dict) -> dict[str, dict]:
    return {**(manifest.get("nodes") or {}), **(manifest.get("sources") or {})}


def column_docs(manifest: dict) -> dict[str, dict[str, str]]:
    """{uid: {column: description}} for every documented column (rendered text)."""
    docs: dict[str, dict[str, str]] = {}
    for uid, node in _documentable(manifest).items():
        described = {
            name: str(col.get("description"))
            for name, col in (node.get("columns") or {}).items()
            if isinstance(col, dict) and str(col.get("description") or "").strip()
        }
        if described:
            docs[uid] = described
    return docs


def column_tags(column: dict) -> list[str]:
    config = column.get("config") if isinstance(column.get("config"), dict) else {}
    tags = [*(column.get("tags") or []), *(config.get("tags") or [])]
    return list(dict.fromkeys(str(t) for t in tags))


def declared_tags(manifest: dict) -> dict[str, dict[str, list[str]]]:
    """{uid: {column: [tag, ...]}} for columns that declare any tag."""
    declared: dict[str, dict[str, list[str]]] = {}
    for uid, node in _documentable(manifest).items():
        tagged = {
            name: tags
            for name, col in (node.get("columns") or {}).items()
            if isinstance(col, dict) and (tags := column_tags(col))
        }
        if tagged:
            declared[uid] = tagged
    return declared


def exposures(manifest: dict) -> dict[str, dict]:
    return {
        uid: {
            "name": e.get("label") or e.get("name") or uid.split(".")[-1],
            "depends_on": list((e.get("depends_on") or {}).get("nodes") or []),
        }
        for uid, e in (manifest.get("exposures") or {}).items()
    }


def writable_nodes(manifest: dict) -> dict[str, dict]:
    """Nodes whose YAML wickd can edit (models, seeds, snapshots of the root project)."""
    root = (manifest.get("metadata") or {}).get("project_name")
    return {
        uid: node
        for uid, node in (manifest.get("nodes") or {}).items()
        if node.get("resource_type") in RESOURCE_KEYS
        and node.get("original_file_path")
        and (root is None or node.get("package_name") in (None, root))
    }


def parse_tags(raw: str | None) -> list[str]:
    """The PROPAGATE_TAGS project setting: comma-separated, defaults to pii,sensitive."""
    tags = [t.strip().lower() for t in (raw or "").split(",") if t.strip()]
    return list(dict.fromkeys(tags)) or list(DEFAULT_TAGS)
