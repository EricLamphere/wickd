"""dbt `{% docs %}` blocks inside Markdown pages, and which nodes use each block.

A file that is only docs blocks is a dbt docs file, already shown on each node, so it
isn't listed as a page. In a mixed file each block is a segment of its own, rendered as a
labeled callout linking to the nodes whose descriptions use it.
"""

from __future__ import annotations

import re
from typing import Any, Literal

_BLOCK = re.compile(
    r"{%-?\s*docs\s+([A-Za-z_][A-Za-z0-9_]*)\s*-?%}(.*?){%-?\s*enddocs\s*-?%}",
    re.DOTALL,
)
# The description fallback (manifests without `doc_blocks`, before dbt 1.10) only trusts
# blocks long enough not to match by accident
_MIN_FALLBACK_CHARS = 20
_USAGE_SECTIONS = ("nodes", "sources", "exposures", "semantic_models", "metrics")

Kind = Literal["page", "blocks_only", "mixed"]


def classify(text: str) -> Kind:
    if not _BLOCK.search(text):
        return "page"
    return "blocks_only" if not _BLOCK.sub("", text).strip() else "mixed"


def segments(text: str) -> list[dict[str, str]]:
    """The page split into Markdown and docs block segments, in order (empty Markdown dropped)."""
    out: list[dict[str, str]] = []
    pos = 0
    for match in _BLOCK.finditer(text):
        before = text[pos:match.start()]
        if before.strip():
            out.append({"kind": "markdown", "text": before})
        out.append({"kind": "docs_block", "name": match.group(1), "text": match.group(2).strip("\n")})
        pos = match.end()
    rest = text[pos:]
    if rest.strip():
        out.append({"kind": "markdown", "text": rest})
    return out


def _block_name(ref: str) -> str:
    """`doc.my_pkg.orders_status` → `orders_status`."""
    return ref.rsplit(".", 1)[-1]


def _node_doc_refs(raw: dict[str, Any]) -> set[str] | None:
    """Block names a node (or its columns) uses, or None when the manifest has no doc_blocks."""
    if "doc_blocks" not in raw:
        return None
    names = {_block_name(r) for r in raw.get("doc_blocks") or [] if isinstance(r, str)}
    for column in (raw.get("columns") or {}).values():
        names |= {_block_name(r) for r in (column or {}).get("doc_blocks") or [] if isinstance(r, str)}
    return names


def _descriptions(raw: dict[str, Any]) -> list[str]:
    texts = [raw.get("description") or ""]
    texts += [(c or {}).get("description") or "" for c in (raw.get("columns") or {}).values()]
    return [t for t in texts if t]


def docs_block_usage(manifest: dict[str, Any], names: set[str]) -> dict[str, list[str]]:
    """For each block name, the unique_ids of nodes that use it, sorted."""
    contents = {
        d.get("name"): (d.get("block_contents") or "").strip()
        for d in (manifest.get("docs") or {}).values()
        if d.get("name") in names
    }
    usage: dict[str, set[str]] = {name: set() for name in names}
    for section in _USAGE_SECTIONS:
        for uid, raw in (manifest.get(section) or {}).items():
            if not isinstance(raw, dict) or raw.get("resource_type") == "test":
                continue
            refs = _node_doc_refs(raw)
            if refs is not None:
                for name in refs & names:
                    usage[name].add(uid)
                continue
            descriptions = _descriptions(raw)
            for name, body in contents.items():
                if len(body) >= _MIN_FALLBACK_CHARS and any(body in d for d in descriptions):
                    usage[name].add(uid)
    return {name: sorted(uids) for name, uids in usage.items()}
