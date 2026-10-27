"""Smarter test suggestions — wickd Pro. Public shim over the private
`wickd_pro.test_targets` module.

Same split as app/propagation/pro.py: the API, the YAML writers, the proposal
plumbing and the UI are public; which columns need which tests, the evidence
and the ranking are decided in wickd_pro. Only plain dicts/lists cross the
boundary, all read from a lineage_version 4 column lineage snapshot:

    lineage    {uid: {column: [{node, column, kind}]}}
    row_deps   {uid: [{node, column}]}
    structure  {uid: {"join_pairs": [{left, right, type}], "grain": {columns, via} | None}}

    rank_test_targets(manifest, lineage, row_deps, structure, unique_ids=None)
        → [{unique_id, name, column (None for a model-level test), columns?, score,
            reach, row_uses, exposures, in_grain, used_by?, existing: [test],
            candidates: [{test, evidence, source: grain | join, to?, field?,
                          combination?, models?}]}]   (highest score first)

`used_by` (newer builds) names what reach / row_uses / exposures count:
{columns: [{unique_id, name, columns}], row_uses: [{unique_id, name}],
exposures: [{unique_id, name}]}, capped per list.

`test` is not_null / unique / relationships (`to` = a unique_id, `field` its
column) / unique_combination_of_columns (`combination`, needs dbt_utils).
With `unique_ids`, those models' columns without candidates are included too.
"""

from collections.abc import Iterable
from typing import Any


class TestTargetsUnavailable(Exception):
    """wickd_pro (with test targets) isn't installed in this build."""


UNAVAILABLE = "Smarter test suggestions require the wickd Pro package, which isn't installed in this build."


def _pro() -> Any:
    try:
        from wickd_pro import test_targets
    except ImportError as exc:
        raise TestTargetsUnavailable(UNAVAILABLE) from exc
    return test_targets


def is_available() -> bool:
    try:
        _pro()
    except TestTargetsUnavailable:
        return False
    return True


def rank_test_targets(
    manifest: dict, lineage: dict, row_deps: dict, structure: dict, unique_ids: Iterable[str] | None = None
) -> list[dict]:
    return _pro().rank_test_targets(manifest, lineage, row_deps, structure, unique_ids)
