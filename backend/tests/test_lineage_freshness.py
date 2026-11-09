"""Column lineage cache keys: content-based freshness and incremental refresh planning."""

import json
from pathlib import Path

from app.dbt.column_lineage import LineageJob
from app.dbt.lineage_freshness import (
    carry_over,
    current_fingerprint,
    job_key,
    manifest_fingerprint,
    plan_jobs,
    stale_reason,
    tracer_key,
)

TRACER = "t1"


def _manifest(**over) -> dict:
    m = {
        "metadata": {"adapter_type": "duckdb", "generated_at": "2026-01-01", "invocation_id": "a"},
        "nodes": {
            "model.p.a": {"resource_type": "model", "name": "a", "relation_name": '"db"."s"."a"',
                          "columns": {"id": {}}, "checksum": {"checksum": "fa"},
                          "compiled_code": "select 1 as id"},
            "model.p.b": {"resource_type": "model", "name": "b", "relation_name": '"db"."s"."b"',
                          "columns": {}, "checksum": {"checksum": "fb"},
                          "compiled_code": "select id from a"},
        },
        "sources": {},
        "macros": {"macro.p.m": {"macro_sql": "{% macro m() %}1{% endmacro %}"}},
        "parent_map": {"model.p.a": [], "model.p.b": ["model.p.a"]},
    }
    m.update(over)
    return m


def _stored(manifest: dict, tracer: str = TRACER) -> str:
    return manifest_fingerprint(manifest).to_json(tracer)


def _strip_code(manifest: dict, keep: set[str]) -> dict:
    nodes = {uid: ({**n} if uid in keep else {k: v for k, v in n.items() if k != "compiled_code"})
             for uid, n in manifest["nodes"].items()}
    return {**manifest, "nodes": nodes}


def test_identical_content_is_fresh_even_when_run_metadata_changes():
    stored = _stored(_manifest())
    rerun = _manifest(metadata={"adapter_type": "duckdb", "generated_at": "2026-02-02", "invocation_id": "b"})
    assert stale_reason(stored, manifest_fingerprint(rerun), TRACER) is None


def test_selective_run_stripping_compiled_code_stays_fresh():
    stored = _stored(_manifest())
    after_run_one = _strip_code(_manifest(), keep={"model.p.b"})
    assert stale_reason(stored, manifest_fingerprint(after_run_one), TRACER) is None


def test_after_parse_with_no_compiled_code_stays_fresh():
    stored = _stored(_manifest())
    assert stale_reason(stored, manifest_fingerprint(_strip_code(_manifest(), keep=set())), TRACER) is None


def test_changed_compiled_sql_is_stale():
    m = _manifest()
    m["nodes"]["model.p.b"]["compiled_code"] = "select id, 2 as x from a"
    assert stale_reason(_stored(_manifest()), manifest_fingerprint(m), TRACER) == "1 node changed since this was loaded."


def test_changed_source_file_is_stale_without_compiled_code():
    m = _strip_code(_manifest(), keep=set())
    m["nodes"]["model.p.a"]["checksum"] = {"checksum": "new"}
    assert "changed" in stale_reason(_stored(_manifest()), manifest_fingerprint(m), TRACER)


def test_changed_parents_or_columns_are_stale():
    m = _manifest()
    m["parent_map"] = {"model.p.a": [], "model.p.b": []}
    assert stale_reason(_stored(_manifest()), manifest_fingerprint(m), TRACER) is not None
    m = _manifest()
    m["nodes"]["model.p.a"]["columns"] = {"id": {}, "name": {}}
    assert stale_reason(_stored(_manifest()), manifest_fingerprint(m), TRACER) is not None


def test_added_and_removed_nodes_are_stale():
    m = _manifest()
    m["nodes"]["model.p.c"] = {"resource_type": "model", "name": "c", "compiled_code": "select 1"}
    assert stale_reason(_stored(_manifest()), manifest_fingerprint(m), TRACER) == "1 node added since this was loaded."
    m = _manifest()
    del m["nodes"]["model.p.b"]
    assert stale_reason(_stored(_manifest()), manifest_fingerprint(m), TRACER) == "1 node removed since this was loaded."


def test_macro_change_counts_only_when_compiled_sql_is_missing():
    edited = {"macro.p.m": {"macro_sql": "{% macro m() %}2{% endmacro %}"}}
    # compiled SQL present for every node: it already reflects the macro
    assert stale_reason(_stored(_manifest()), manifest_fingerprint(_manifest(macros=edited)), TRACER) is None
    # compiled SQL gone: the macro change might alter it
    m = _strip_code(_manifest(macros=edited), keep=set())
    assert stale_reason(_stored(_manifest()), manifest_fingerprint(m), TRACER) == "Macros changed since this was loaded."


def test_compiled_code_appearing_where_scan_had_none_is_not_a_change():
    stored = _stored(_strip_code(_manifest(), keep={"model.p.a"}))
    assert stale_reason(stored, manifest_fingerprint(_manifest()), TRACER) is None


def test_tracer_adapter_and_legacy_snapshots_are_stale():
    current = manifest_fingerprint(_manifest())
    assert "engine" in stale_reason(_stored(_manifest(), tracer="old"), current, TRACER)
    other = _manifest(metadata={"adapter_type": "snowflake"})
    assert "adapter" in stale_reason(_stored(other), current, TRACER)
    assert "refresh once" in stale_reason("", current, TRACER)
    assert "refresh once" in stale_reason("not json", current, TRACER)


def test_tracer_key_depends_on_lineage_version():
    assert tracer_key(4) == tracer_key(4)
    assert tracer_key(4) != tracer_key(3)


# ── job keys ──────────────────────────────────────────────────────────────────

def _job(uid: str = "model.p.b", sql: str = "select id from a", **over) -> LineageJob:
    fields = {
        "uid": uid, "columns": ("id",), "sql": sql, "dialect": "duckdb", "parent_short_names": ("a",),
        "name_to_uid": {"a": "model.p.a", "b": "model.p.b", "zzz": "model.p.zzz"},
        "sources": {"a": "SELECT id"}, "parent_columns": {"a": ("id",)}, "name": uid.split(".")[-1],
    }
    fields.update(over)
    return LineageJob(**fields)


def test_job_key_ignores_unrelated_project_names():
    base = _job()
    elsewhere = _job(name_to_uid={**base.name_to_uid, "new_model": "model.p.new_model"})
    assert job_key(base, TRACER) == job_key(elsewhere, TRACER)


def test_job_key_changes_with_inputs():
    base = job_key(_job(), TRACER)
    assert job_key(_job(sql="select id, 1 as x from a"), TRACER) != base
    assert job_key(_job(sources={"a": "SELECT id, name"}), TRACER) != base
    assert job_key(_job(parent_columns={"a": ("id", "name")}), TRACER) != base
    assert job_key(_job(name_to_uid={"a": "source.p.a"}), TRACER) != base
    assert job_key(_job(), "t2") != base


def test_plan_jobs_reuses_matching_keys():
    a, b = _job("model.p.x"), _job("model.p.y", sql="select id from a where id > 1")
    previous = {"model.p.x": job_key(a, TRACER), "model.p.y": "stale"}
    plan = plan_jobs([a, b], TRACER, previous)
    assert plan.reused == ["model.p.x"]
    assert [j.uid for j in plan.to_trace] == ["model.p.y"]
    assert plan.keys["model.p.x"] == previous["model.p.x"]


def test_carry_over_copies_only_reused_entries():
    prev = {"m1": {"c": []}, "m2": {"d": []}}
    assert carry_over(prev, ["m1", "m3"]) == {"m1": {"c": []}}


# ── memoized read ─────────────────────────────────────────────────────────────

def test_current_fingerprint_reads_and_memoizes(tmp_path: Path):
    path = tmp_path / "manifest.json"
    assert current_fingerprint(path) is None
    path.write_text(json.dumps(_manifest()))
    first = current_fingerprint(path)
    assert first == manifest_fingerprint(_manifest())
    assert current_fingerprint(path) is first
    path.write_text("not json")
    assert current_fingerprint(path) is None
