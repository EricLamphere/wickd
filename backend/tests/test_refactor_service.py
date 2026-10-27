"""app/refactor/service.run() end to end with the real Pro engine (skipped without wickd_pro.refactor)."""

import json
from pathlib import Path

import pytest

from app.refactor.service import RefactorFailed, run

pytest.importorskip("wickd_pro.refactor")

STG = "model.proj.stg"


def _project(root: Path) -> Path:
    (root / "models").mkdir(parents=True)
    (root / "target").mkdir()
    (root / "dbt_project.yml").write_text("name: proj\n")
    (root / "models" / "stg.sql").write_text("with base as (\n  select 1 as id\n)\nselect id from base\n")
    (root / "models" / "mart.sql").write_text("select s.id from {{ ref('stg') }} s\n")
    manifest = {
        "metadata": {"project_name": "proj", "adapter_type": "duckdb"},
        "nodes": {
            STG: {"name": "stg", "resource_type": "model", "package_name": "proj",
                  "original_file_path": "models/stg.sql", "depends_on": {"nodes": []}, "columns": {}},
            "model.proj.mart": {"name": "mart", "resource_type": "model", "package_name": "proj",
                                "original_file_path": "models/mart.sql", "depends_on": {"nodes": [STG]},
                                "columns": {}},
        },
    }
    (root / "target" / "manifest.json").write_text(json.dumps(manifest))
    return root


def test_rename_column_through_the_real_engine(tmp_path: Path):
    root = _project(tmp_path / "proj")
    result = run(root, {"op": "rename_column", "unique_id": STG, "column": "id", "new_name": "stg_id"}, {})
    proposed = {c["path"]: c["proposed"] for c in result["changes"]}
    assert proposed["models/stg.sql"].endswith("select id as stg_id from base\n")
    assert proposed["models/mart.sql"] == "select s.stg_id as id from {{ ref('stg') }} s\n"


def test_extract_through_the_real_engine_adds_yaml(tmp_path: Path):
    root = _project(tmp_path / "proj")
    result = run(root, {"op": "extract_cte", "unique_id": STG, "cte": "base", "new_name": "stg_base"}, {})
    ops = {c["path"]: c["op"] for c in result["changes"]}
    assert ops == {"models/stg.sql": "modify", "models/stg_base.sql": "create", "models/schema.yml": "create"}


def test_engine_refusal_becomes_refactor_failed(tmp_path: Path):
    root = _project(tmp_path / "proj")
    with pytest.raises(RefactorFailed, match="already used"):
        run(root, {"op": "rename_model", "unique_id": STG, "new_name": "mart"}, {})
