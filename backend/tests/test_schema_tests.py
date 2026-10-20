import pytest
from ruamel.yaml import YAML

from app.dbt.schema_tests import DataTestSpec, add_column_tests, default_test_key, render_test
from app.dbt.schema_yaml import SchemaYamlError


def _load(text: str) -> dict:
    return YAML(typ="safe").load(text)


BASE = """version: 2

models:
  - name: orders  # orders model
    columns:
      - name: id
        description: Key.
        data_tests:
          - unique
      - name: status
      - name: customer_id
        description: Who ordered.
  - name: customers
"""


def test_appends_to_existing_list_and_adds_new_key():
    text = add_column_tests(
        BASE, "s.yml", "models", "orders",
        {
            "id": [DataTestSpec("not_null")],
            "STATUS": [DataTestSpec("accepted_values", {"values": ["placed", "shipped"]})],
            "customer_id": [DataTestSpec("relationships", {"to": "ref('customers')", "field": "id"})],
        },
        "1.9.0",
    )
    cols = _load(text)["models"][0]["columns"]
    assert cols[0]["data_tests"] == ["unique", "not_null"]
    assert cols[1]["data_tests"] == [{"accepted_values": {"values": ["placed", "shipped"]}}]
    assert cols[2]["data_tests"] == [{"relationships": {"to": "ref('customers')", "field": "id"}}]
    assert cols[2]["description"] == "Who ordered."
    assert "# orders model" in text
    assert _load(text)["models"][1] == {"name": "customers"}


def test_follows_tests_key_used_by_the_entry():
    text = "models:\n  - name: m\n    columns:\n      - name: a\n        tests: [unique]\n      - name: b\n"
    with pytest.raises(SchemaYamlError, match="inline"):
        add_column_tests(text, "s.yml", "models", "m", {"a": [DataTestSpec("not_null")]}, "1.9")
    out = add_column_tests(text, "s.yml", "models", "m", {"b": [DataTestSpec("not_null")]}, "1.9")
    assert _load(out)["models"][0]["columns"][1] == {"name": "b", "tests": ["not_null"]}


def test_arguments_block_for_dbt_1_10():
    out = add_column_tests(
        BASE, "s.yml", "models", "orders",
        {"status": [DataTestSpec("accepted_values", {"values": [1, 2], "quote": False})]},
        "1.10.2",
    )
    status = _load(out)["models"][0]["columns"][1]
    assert status["data_tests"] == [{"accepted_values": {"arguments": {"values": [1, 2], "quote": False}}}]


def test_empty_test_key_gets_items():
    text = "models:\n  - name: m\n    columns:\n      - name: a\n        data_tests:\n"
    out = add_column_tests(text, "s.yml", "models", "m", {"a": [DataTestSpec("unique")]}, "1.9")
    assert _load(out)["models"][0]["columns"][0]["data_tests"] == ["unique"]


def test_no_tests_returns_text_unchanged():
    assert add_column_tests(BASE, "s.yml", "models", "orders", {}, "1.9") == BASE


def test_default_key_by_version():
    assert default_test_key("1.7.3") == "tests"
    assert default_test_key("1.8.0") == "data_tests"
    assert default_test_key(None) == "data_tests"


def test_render_test_quotes_strings():
    lines = render_test(DataTestSpec("accepted_values", {"values": ["it's", "a: b"]}), 4, False)
    assert lines == ["    - accepted_values:\n", '        values: ["it\'s", "a: b"]\n']
