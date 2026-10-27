import pytest
from ruamel.yaml import YAML

from app.dbt.schema_column_tags import add_column_tags
from app.dbt.schema_descriptions import raw_descriptions, raw_source_descriptions
from app.dbt.schema_yaml import SchemaYamlError


def _load(text: str) -> dict:
    return YAML(typ="safe").load(text)


BASE = """version: 2

models:
  - name: users  # people
    columns:
      - name: id
        description: Key.
      - name: email
        tags:
          - contact
      - name: phone
        tags: [contact]  # keep me
      - name: ssn
        tags: sensitive
      - name: address
        config:
          tags: ["contact"]
      - name: notes
        tags:
  - name: other
"""


def _columns(text: str) -> dict[str, dict]:
    return {c["name"]: c for c in _load(text)["models"][0]["columns"]}


def test_adds_tags_in_every_existing_style():
    text = add_column_tags(
        BASE, "s.yml", "models", "users",
        {"ID": ["pii"], "email": ["pii"], "phone": ["pii", "sensitive"], "ssn": ["pii"],
         "address": ["pii"], "notes": ["pii"]},
    )
    cols = _columns(text)
    assert cols["id"] == {"name": "id", "description": "Key.", "tags": ["pii"]}
    assert cols["email"]["tags"] == ["contact", "pii"]
    assert cols["phone"]["tags"] == ["contact", "pii", "sensitive"]
    assert cols["ssn"]["tags"] == ["sensitive", "pii"]
    assert cols["address"]["config"]["tags"] == ["contact", "pii"]
    assert "tags" not in cols["address"]
    assert cols["notes"]["tags"] == ["pii"]
    assert "# keep me" in text and "# people" in text
    assert "      - name: id\n        description: Key.\n        tags: [pii]\n" in text
    assert _load(text)["models"][1] == {"name": "other"}


def test_skips_tags_already_present_in_any_case():
    assert add_column_tags(BASE, "s.yml", "models", "users", {"email": ["CONTACT"]}) == BASE


def test_quotes_tags_that_need_it():
    text = add_column_tags(BASE, "s.yml", "models", "users", {"id": ["needs review"]})
    assert _columns(text)["id"]["tags"] == ["needs review"]
    assert 'tags: ["needs review"]' in text


def test_keeps_crlf_line_endings():
    text = add_column_tags(BASE.replace("\n", "\r\n"), "s.yml", "models", "users", {"id": ["pii"]})
    assert "\n" not in text.replace("\r\n", "")
    assert _columns(text)["id"]["tags"] == ["pii"]


def test_multi_line_flow_lists_are_refused():
    text = "models:\n  - name: m\n    columns:\n      - name: a\n        tags: [x,\n          y]\n"
    with pytest.raises(SchemaYamlError, match="several lines"):
        add_column_tags(text, "s.yml", "models", "m", {"a": ["pii"]})


def test_missing_node_or_columns():
    with pytest.raises(SchemaYamlError, match="not in"):
        add_column_tags(BASE, "s.yml", "models", "nope", {"id": ["pii"]})
    with pytest.raises(SchemaYamlError, match="no columns"):
        add_column_tags(BASE, "s.yml", "models", "other", {"id": ["pii"]})


def test_raw_descriptions_keep_doc_blocks():
    text = (
        "models:\n  - name: m\n    columns:\n      - name: a\n        description: '{{ doc(\"a\") }}'\n"
        "      - name: b\n        description: ''\n"
        "sources:\n  - name: raw\n    tables:\n      - name: users\n        columns:\n"
        "          - name: id\n            description: User key.\n"
    )
    assert raw_descriptions(text, "s.yml", "models", "m") == {"a": '{{ doc("a") }}'}
    assert raw_descriptions(text, "s.yml", "models", "missing") == {}
    assert raw_source_descriptions(text, "s.yml", "raw", "users") == {"id": "User key."}
    assert raw_source_descriptions(text, "s.yml", "raw", "nope") == {}
