"""Lineage propagation — wickd Pro. Public shim over the private
`wickd_pro.propagation` module.

Same split as app/performance/pro.py: the API, the YAML writers, the proposal
plumbing and the UI are public; which descriptions are inherited and where
tagged data flows is decided in wickd_pro. Only plain dicts/lists cross the
boundary (see app/propagation/inputs.py for how they're built).

    lineage   {uid: {column: [{node, column, kind}]}}  (a lineage_version 3 snapshot)
    docs      {uid: {column: description}}             (documented columns only)
    declared  {uid: {column: [tag, ...]}}
    exposures {exposure_uid: {name, depends_on: [uid, ...]}}

    inherit_descriptions(lineage, docs, *, allowed_kinds, unique_ids=None)
        → {"fills": [{unique_id, column, description, source: {node, column},
                      kind, path: [{node, column, kind}]}],
           "conflicts": [{unique_id, column, candidates: [{description, source}]}]}
    tag_flow(lineage, declared, tags, exposures)
        → {"columns": [{unique_id, column, tag, declared, via_kind, path}],
           "exposures": [{unique_id, name, tag, via: [uid, ...]}]}
    inherit_tags(lineage, declared, tags)
        → [{unique_id, column, tags: [...], via_kind: {tag: kind}}]
"""

from collections.abc import Iterable
from typing import Any


class PropagationUnavailable(Exception):
    """wickd_pro (with lineage propagation) isn't installed in this build."""


def _pro() -> Any:
    try:
        from wickd_pro import propagation
    except ImportError as exc:
        raise PropagationUnavailable(
            "Lineage propagation requires the wickd Pro package, which isn't installed in this build."
        ) from exc
    return propagation


def is_available() -> bool:
    try:
        _pro()
    except PropagationUnavailable:
        return False
    return True


def inherit_descriptions(
    lineage: dict, docs: dict, *, allowed_kinds: Iterable[str], unique_ids: Iterable[str] | None = None
) -> dict:
    return _pro().inherit_descriptions(lineage, docs, allowed_kinds=allowed_kinds, unique_ids=unique_ids)


def tag_flow(lineage: dict, declared: dict, tags: list[str], exposures: dict) -> dict:
    return _pro().tag_flow(lineage, declared, tags, exposures)


def inherit_tags(lineage: dict, declared: dict, tags: list[str]) -> list[dict]:
    return _pro().inherit_tags(lineage, declared, tags)
