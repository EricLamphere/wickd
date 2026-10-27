"""What the refactor engine reads (app/refactor/inputs.py)."""

from pathlib import Path

from app.refactor.inputs import describe, project_files

MANIFEST = {
    "nodes": {
        "model.p.stg": {"name": "stg", "resource_type": "model", "depends_on": {"nodes": []}},
        "model.p.a": {"name": "a", "resource_type": "model", "depends_on": {"nodes": ["model.p.stg"]}},
        "model.p.b": {"name": "b", "resource_type": "model", "depends_on": {"nodes": ["model.p.stg"]}},
        "test.p.t": {"name": "t", "resource_type": "test", "depends_on": {"nodes": ["model.p.stg"]}},
    }
}


def test_project_files_reads_resource_dirs_only(tmp_path: Path):
    (tmp_path / "dbt_project.yml").write_text("name: p\nmodel-paths: ['src']\n")
    for rel in ("src/a.sql", "src/schema.yml", "src/docs.md", "macros/m.sql", "src/data.csv",
                "dbt_packages/x/models/y.sql", "target/compiled/a.sql", "src/.hidden/z.sql", "models/ignored.sql"):
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x")
    assert set(project_files(tmp_path)) == {
        "dbt_project.yml", "src/a.sql", "src/schema.yml", "src/docs.md", "macros/m.sql",
    }


def test_describe_each_operation():
    assert describe({"op": "rename_model", "unique_id": "model.p.stg", "new_name": "x"}, MANIFEST) == (
        "Rename model `stg` → `x` (2 downstream models)"
    )
    assert describe({"op": "rename_column", "unique_id": "model.p.a", "column": "c", "new_name": "d"}, MANIFEST) == (
        "Rename column `c` → `d` in `a`"
    )
    assert describe({"op": "extract_cte", "model": "a", "unique_id": "model.p.a", "cte": "base", "new_name": "a_base"}) == (
        "Extract CTE `base` from `a` into model `a_base`"
    )
