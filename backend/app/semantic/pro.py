"""Semantic layer drafts — wickd Pro. Public shim over the private `wickd_pro.semantic`.

Same split as app/ai/pro.py: deciding what a model's semantic model and metrics should
be (column roles, entities, aggregations, the prompt and its validation) is private;
collecting the inputs, running the language model, validating the draft in the
MetricFlow sidecar and writing the YAML are here. Only plain dicts cross the boundary.

    facts_for(manifest, unique_id, columns, stats, semantic_manifest) -> facts
        columns: [{name, data_type}]; stats: app/ai/test_generation.column_stats() output
    heuristic_draft(facts) -> draft
    draft_prompt(facts, draft) -> {"messages", "schema", "max_tokens"}
    parse_draft(raw, facts, draft) -> draft                       (ValueError)
    to_manifest_json(draft, node, semantic_manifest) -> {"semantic_models", "metrics"}
    to_yaml_items(draft, spec) -> {"spec", "semantic_model", "metrics": [{key, name, level, entry, inputs}]}
                                                                  (ValueError)
"""

from typing import Any

UNAVAILABLE = "Semantic layer drafts require the wickd Pro package, which isn't installed in this build."


class SemanticDraftUnavailable(Exception):
    """wickd_pro (with semantic drafting) isn't installed."""


def _pro() -> Any:
    try:
        from wickd_pro import semantic
    except ImportError as exc:
        raise SemanticDraftUnavailable(UNAVAILABLE) from exc
    return semantic


def is_available() -> bool:
    try:
        _pro()
    except SemanticDraftUnavailable:
        return False
    return True


def facts_for(manifest: dict, unique_id: str, columns: list[dict], stats: dict, semantic_manifest: dict) -> dict:
    return _pro().facts_for(manifest, unique_id, columns, stats, semantic_manifest)


def heuristic_draft(facts: dict) -> dict:
    return _pro().heuristic_draft(facts)


def draft_prompt(facts: dict, draft: dict) -> dict:
    return _pro().draft_prompt(facts, draft)


def parse_draft(raw: str, facts: dict, draft: dict) -> dict:
    return _pro().parse_draft(raw, facts, draft)


def to_manifest_json(draft: dict, node: dict, semantic_manifest: dict) -> dict:
    return _pro().to_manifest_json(draft, node, semantic_manifest)


def to_yaml_items(draft: dict, spec: str) -> dict:
    return _pro().to_yaml_items(draft, spec)
