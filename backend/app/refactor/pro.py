"""Refactors — wickd Pro. Public shim over the private `wickd_pro.refactor` engine.

Same split as app/propagation/pro.py: the API, the proposal plumbing (file
operations, Accept all, Undo, `dbt parse` afterwards) and the UI are public; the
engine that decides which spans of which files change lives in wickd_pro. Only
plain dicts cross the boundary (see app/refactor/inputs.py).

    manifest  load_manifest_dict() output
    files     {project-relative path: raw text}
    lineage   {"results": {uid: {column: [refs]}}, "row_dependencies": {...}} ({} if not traced)

    rename_model(manifest, files, unique_id, new_name)
    rename_column(manifest, files, lineage, unique_id, column, new_name)
    extract_cte(manifest, files, unique_id, cte, new_name)
        → {"changes": [{op: modify | rename | create, path, new_path?, original, proposed}],
           "manual": [{path, line, text, reason}], "notes": [str], "summary": {op, …}}
        raise ValueError (wickd_pro's RefactorError) with a user-facing reason.
"""

from typing import Any


class RefactorUnavailable(Exception):
    """wickd_pro (with the refactor engine) isn't installed in this build."""


UNAVAILABLE = "Refactors require the wickd Pro package, which isn't installed in this build."


def _pro() -> Any:
    try:
        from wickd_pro import refactor
    except ImportError as exc:
        raise RefactorUnavailable(UNAVAILABLE) from exc
    return refactor


def is_available() -> bool:
    try:
        _pro()
    except RefactorUnavailable:
        return False
    return True


def rename_model(manifest: dict, files: dict[str, str], unique_id: str, new_name: str) -> dict:
    return _pro().rename_model(manifest, files, unique_id, new_name)


def rename_column(
    manifest: dict, files: dict[str, str], lineage: dict, unique_id: str, column: str, new_name: str
) -> dict:
    return _pro().rename_column(manifest, files, lineage, unique_id, column, new_name)


def extract_cte(manifest: dict, files: dict[str, str], unique_id: str, cte: str, new_name: str) -> dict:
    return _pro().extract_cte(manifest, files, unique_id, cte, new_name)
