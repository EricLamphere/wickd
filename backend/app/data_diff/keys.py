"""The key a data diff joins dev and prod rows on (pure; unit-tested).

Order: the user's pick → a contract `primary_key` constraint → a column with a `unique` test →
`dbt_utils.unique_combination_of_columns` → the grain column lineage detected from the SQL
(plan 04, lineage snapshot v4) → none (counts and schema only). A candidate is skipped when one of
its columns isn't a real column on both sides (tests on expressions like `lower(email)`).
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Key:
    columns: tuple[str, ...]
    source: str  # user | contract | unique_test | unique_combination | detected


def _constraint_key(node: dict) -> list[str] | None:
    for c in node.get("constraints") or []:
        if isinstance(c, dict) and c.get("type") == "primary_key" and c.get("columns"):
            return [str(x) for x in c["columns"]]
    for name, col in (node.get("columns") or {}).items():
        for c in (col or {}).get("constraints") or []:
            if isinstance(c, dict) and c.get("type") == "primary_key":
                return [str((col or {}).get("name") or name)]
    return None


def _tests_on(manifest: dict, uid: str) -> list[dict]:
    out = []
    for node in (manifest.get("nodes") or {}).values():
        if node.get("resource_type") != "test" or not node.get("test_metadata"):
            continue
        attached = node.get("attached_node") or next(iter((node.get("depends_on") or {}).get("nodes") or []), None)
        if attached == uid:
            out.append(node)
    return out


def _unique_tests(tests: list[dict]) -> list[list[str]]:
    singles, combos = [], []
    for t in tests:
        meta = t.get("test_metadata") or {}
        kwargs = meta.get("kwargs") or {}
        if meta.get("name") == "unique":
            column = kwargs.get("column_name") or t.get("column_name")
            if column:
                singles.append([str(column)])
        elif meta.get("name") == "unique_combination_of_columns":
            cols = kwargs.get("combination_of_columns")
            if isinstance(cols, list) and cols:
                combos.append([str(c) for c in cols])
    return [*singles, *combos]


def _strip_quotes(name: str) -> str:
    return name.strip().strip('"`[]')


def candidates(manifest: dict, uid: str, grain: list[str] | None, user: list[str] | None) -> list[Key]:
    node = (manifest.get("nodes") or {}).get(uid) or {}
    out: list[Key] = []
    if user:
        out.append(Key(tuple(user), "user"))
    pk = _constraint_key(node)
    if pk:
        out.append(Key(tuple(pk), "contract"))
    for cols in _unique_tests(_tests_on(manifest, uid)):
        out.append(Key(tuple(cols), "unique_test" if len(cols) == 1 else "unique_combination"))
    if grain:
        out.append(Key(tuple(grain), "detected"))
    return out


def resolve_key(manifest: dict, uid: str, *, available: set[str], grain: list[str] | None = None,
                user: list[str] | None = None) -> Key | None:
    """The first candidate whose columns all exist (case-insensitively) in `available`."""
    lower = {c.lower(): c for c in available}
    for key in candidates(manifest, uid, grain, user):
        names = [_strip_quotes(c) for c in key.columns]
        if names and all(n.lower() in lower for n in names):
            return Key(tuple(lower[n.lower()] for n in names), key.source)
    return None


def grain_of(structure: dict, uid: str) -> list[str] | None:
    grain = ((structure.get(uid) or {}).get("grain") or {}) if isinstance(structure, dict) else {}
    cols = grain.get("columns") if isinstance(grain, dict) else None
    return [str(c) for c in cols] if isinstance(cols, list) and cols else None
