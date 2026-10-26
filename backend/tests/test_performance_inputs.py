"""app/performance/inputs.py: the plain-data shapes handed to wickd_pro."""
from dataclasses import dataclass
from datetime import datetime

from app.dbt.manifest import ColumnInfo, Manifest, ModelNode
from app.performance import inputs


@dataclass(frozen=True)
class Row:
    invocation_id: int
    unique_id: str
    name: str
    status: str = "success"
    execution_time: float | None = 1.0
    started_at: datetime | None = None
    completed_at: datetime | None = None
    thread_id: str | None = None
    rows_affected: int | None = None
    bytes_processed: int | None = None


def _model(uid: str, materialized: str = "table", columns: tuple[str, ...] = ()) -> ModelNode:
    return ModelNode(
        unique_id=uid, name=uid.split(".")[-1], resource_type="model", schema_=None, database=None,
        materialized=materialized, tags=(), description="", original_file_path=None, raw_sql=None,
        columns=tuple(ColumnInfo(name=c, description="", data_type="") for c in columns),
    )


MANIFEST = Manifest(
    nodes=(_model("model.p.a", "view"), _model("model.p.b", columns=("id", "updated_at"))),
    parents={"model.p.b": ("model.p.a", "source.p.raw.x"), "model.p.a": ()},
)


def test_run_nodes_uses_manifest_and_iso_utc_timestamps() -> None:
    row = Row(1, "model.p.b", "b", started_at=datetime(2026, 10, 22, 10), thread_id="T1", rows_affected=9)
    [node] = inputs.run_nodes([row], {n.unique_id: n for n in MANIFEST.nodes})
    assert node["materialized"] == "table"
    assert node["resource_type"] == "model"
    assert node["started_at"] == "2026-10-22T10:00:00+00:00"
    assert node["completed_at"] is None
    assert (node["thread_id"], node["rows_affected"]) == ("T1", 9)


def test_run_nodes_without_manifest_infers_type_from_unique_id() -> None:
    [node] = inputs.run_nodes([Row(1, "test.p.not_null_x.abc", "not_null_x")], {})
    assert node["resource_type"] == "test"
    assert node["materialized"] is None


def test_run_parents_restricted_to_the_run() -> None:
    assert inputs.run_parents(MANIFEST, {"model.p.a", "model.p.b"}) == {
        "model.p.a": [],
        "model.p.b": ["model.p.a"],
    }
    assert inputs.run_parents(None, {"model.p.a"}) == {"model.p.a": []}


def test_nodes_meta_has_columns_and_children() -> None:
    meta = inputs.nodes_meta(MANIFEST, [Row(1, "model.p.a", "a"), Row(1, "model.p.b", "b", rows_affected=4)])
    assert meta["model.p.a"]["children"] == ["model.p.b"]
    assert meta["model.p.b"]["columns"] == ["id", "updated_at"]
    assert meta["model.p.b"]["rows_affected"] == 4


def test_regression_history_uses_only_earlier_successes() -> None:
    earlier = [Row(1, "model.p.b", "b", execution_time=2), Row(2, "model.p.b", "b", status="error", execution_time=9)]
    current = [Row(3, "model.p.b", "b", execution_time=5), Row(3, "model.p.a", "a", status="error")]
    assert inputs.regression_history(current, earlier) == [
        {"unique_id": "model.p.b", "name": "b", "previous": [2], "current": 5},
    ]


def test_median_durations() -> None:
    rows = [Row(i, "model.p.b", "b", execution_time=t) for i, t in enumerate([3, 1, 2, 10])]
    rows.append(Row(9, "model.p.b", "b", status="error", execution_time=100))
    assert inputs.median_durations(rows)["model.p.b"] == {
        "median_s": 2.5, "last_s": 10, "runs": 4, "recent": [3, 1, 2, 10],
    }
