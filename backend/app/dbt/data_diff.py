"""Data diff — wickd Pro. Public shim over the private `wickd_pro.data_diff` package.

The public side finds the models, their relations on both targets, columns and keys, picks the
strategy per model and runs every statement through `dbt show` (app/data_diff/). Which SQL to run,
how to read the results and the summary come from wickd_pro, as plain dicts:

    diff_steps(spec) -> generator   yields {"dev": [sql], "prod": [sql]}, is sent
                                    {"dev": [result], "prod": [result]}, returns the result dict
    supports_separate(adapter_type) -> bool

See wickd_pro/data_diff/__init__.py for the spec and result shapes.
"""

from collections.abc import Generator
from typing import Any


class DataDiffUnavailable(Exception):
    """wickd_pro (with data diff) isn't installed in this build."""


UNAVAILABLE = "Data diff requires the wickd Pro package, which isn't installed in this build."


def _pro() -> Any:
    try:
        from wickd_pro import data_diff
    except ImportError as exc:
        raise DataDiffUnavailable(UNAVAILABLE) from exc
    return data_diff


def is_available() -> bool:
    try:
        _pro()
    except DataDiffUnavailable:
        return False
    return True


def diff_steps(spec: dict) -> Generator[dict, dict, dict]:
    return _pro().diff_steps(spec)


def supports_separate(adapter_type: str | None) -> bool:
    return bool(_pro().supports_separate(adapter_type))
