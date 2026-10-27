"""
Tests for the public column-lineage shim's row-dependency and transform-kind
delegation (app.dbt.column_lineage.trace_job_full / trace_job_kinds and their
supports_* probes).

The private wickd_pro package isn't needed: `_pro()` is patched to return a
stand-in module, covering both a Pro build that has row-dependency tracing
and an older one that only has trace_job().
"""
from types import SimpleNamespace

import pytest

import app.dbt.column_lineage as shim
from app.dbt.column_lineage import ColumnLineageUnavailable, ColumnRef, LineageJob

JOB = LineageJob(
    uid="model.p.child", columns=("a",), sql="SELECT a FROM parent WHERE b = 1", dialect=None,
    parent_short_names=("parent",), name_to_uid={"parent": "model.p.parent"}, sources={"parent": "SELECT a, b"},
)
A = ColumnRef(node="model.p.parent", column="a")
B = ColumnRef(node="model.p.parent", column="b")


def _trace_job(job: LineageJob):
    return job.uid, {"a": [A]}


def test_trace_job_full_uses_pro_implementation(monkeypatch: pytest.MonkeyPatch) -> None:
    pro = SimpleNamespace(trace_job=_trace_job, trace_job_full=lambda job: (job.uid, {"a": [A]}, [B]))
    monkeypatch.setattr(shim, "_pro", lambda: pro)
    assert shim.supports_row_dependencies() is True
    assert shim.trace_job_full(JOB) == ("model.p.child", {"a": [A]}, [B])


def test_trace_job_full_falls_back_for_older_pro_builds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shim, "_pro", lambda: SimpleNamespace(trace_job=_trace_job))
    assert shim.supports_row_dependencies() is False
    assert shim.trace_job_full(JOB) == ("model.p.child", {"a": [A]}, [])


def test_supports_row_dependencies_without_pro(monkeypatch: pytest.MonkeyPatch) -> None:
    def _missing():
        raise ColumnLineageUnavailable("not installed")

    monkeypatch.setattr(shim, "_pro", _missing)
    assert shim.supports_row_dependencies() is False


def test_trace_job_kinds_uses_pro_implementation(monkeypatch: pytest.MonkeyPatch) -> None:
    pro = SimpleNamespace(
        trace_job=_trace_job,
        trace_job_full=lambda job: (job.uid, {"a": [A]}, [B]),
        trace_job_kinds=lambda job: (job.uid, {"a": [(A, "rename")]}, [B]),
    )
    monkeypatch.setattr(shim, "_pro", lambda: pro)
    assert shim.supports_transform_kinds() is True
    assert shim.trace_job_kinds(JOB) == ("model.p.child", {"a": [(A, "rename")]}, [B])


def test_trace_job_kinds_falls_back_without_kinds(monkeypatch: pytest.MonkeyPatch) -> None:
    pro = SimpleNamespace(trace_job=_trace_job, trace_job_full=lambda job: (job.uid, {"a": [A]}, [B]))
    monkeypatch.setattr(shim, "_pro", lambda: pro)
    assert shim.supports_transform_kinds() is False
    assert shim.trace_job_kinds(JOB) == ("model.p.child", {"a": [(A, None)]}, [B])


def test_supports_transform_kinds_without_pro(monkeypatch: pytest.MonkeyPatch) -> None:
    def _missing():
        raise ColumnLineageUnavailable("not installed")

    monkeypatch.setattr(shim, "_pro", _missing)
    assert shim.supports_transform_kinds() is False


def test_trace_job_structure_uses_pro_implementation(monkeypatch: pytest.MonkeyPatch) -> None:
    structure = {"join_pairs": [], "grain": {"columns": ["a"], "via": "distinct"}}
    pro = SimpleNamespace(
        trace_job=_trace_job,
        trace_job_kinds=lambda job: (job.uid, {"a": [(A, "rename")]}, [B]),
        trace_job_structure=lambda job: (job.uid, {"a": [(A, "rename")]}, [B], structure),
    )
    monkeypatch.setattr(shim, "_pro", lambda: pro)
    assert shim.supports_structure() is True
    assert shim.trace_job_structure(JOB) == ("model.p.child", {"a": [(A, "rename")]}, [B], structure)


def test_trace_job_structure_falls_back_on_older_pro(monkeypatch: pytest.MonkeyPatch) -> None:
    pro = SimpleNamespace(trace_job=_trace_job, trace_job_kinds=lambda job: (job.uid, {"a": [(A, "rename")]}, [B]))
    monkeypatch.setattr(shim, "_pro", lambda: pro)
    assert shim.supports_structure() is False
    assert shim.trace_job_structure(JOB) == (
        "model.p.child", {"a": [(A, "rename")]}, [B], {"join_pairs": [], "grain": None},
    )


def test_supports_structure_without_pro(monkeypatch: pytest.MonkeyPatch) -> None:
    def _missing():
        raise ColumnLineageUnavailable("not installed")

    monkeypatch.setattr(shim, "_pro", _missing)
    assert shim.supports_structure() is False
