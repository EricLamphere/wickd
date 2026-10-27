from app.propagation import inputs

MANIFEST = {
    "metadata": {"project_name": "proj"},
    "nodes": {
        "model.proj.a": {
            "name": "a", "resource_type": "model", "package_name": "proj", "original_file_path": "models/a.sql",
            "columns": {
                "id": {"description": "Key.", "tags": ["PII"], "config": {"tags": ["pii", "gdpr"]}},
                "x": {"description": "  "},
            },
        },
        "model.dep.b": {"name": "b", "resource_type": "model", "package_name": "dep", "original_file_path": "b.sql"},
        "test.proj.t": {"name": "t", "resource_type": "test", "package_name": "proj", "original_file_path": "t.sql"},
    },
    "sources": {"source.proj.s.t": {"columns": {"c": {"description": "Src.", "tags": []}}}},
    "exposures": {"exposure.proj.e": {"name": "e", "label": "Dashboard", "depends_on": {"nodes": ["model.proj.a"]}}},
}


def test_column_docs_skip_blank_descriptions():
    assert inputs.column_docs(MANIFEST) == {"model.proj.a": {"id": "Key."}, "source.proj.s.t": {"c": "Src."}}


def test_declared_tags_merge_config_tags():
    assert inputs.declared_tags(MANIFEST) == {"model.proj.a": {"id": ["PII", "pii", "gdpr"]}}


def test_writable_nodes_are_root_project_models_seeds_snapshots():
    assert list(inputs.writable_nodes(MANIFEST)) == ["model.proj.a"]


def test_exposures_prefer_the_label():
    assert inputs.exposures(MANIFEST) == {"exposure.proj.e": {"name": "Dashboard", "depends_on": ["model.proj.a"]}}


def test_parse_tags_defaults_and_normalises():
    assert inputs.parse_tags(None) == ["pii", "sensitive"]
    assert inputs.parse_tags(" , ") == ["pii", "sensitive"]
    assert inputs.parse_tags("PII, gdpr,pii") == ["pii", "gdpr"]
