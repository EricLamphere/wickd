import pytest
from ruamel.yaml import YAML

from app.dbt.schema_descriptions import set_descriptions
from app.dbt.schema_yaml import SchemaYamlError


def _load(text: str) -> dict:
    return YAML(typ="safe").load(text)


BASIC = """version: 2

models:
  - name: orders  # the orders model
    config:
      materialized: table
    columns:
      - name: id
        tests:
          - unique
      - name: amount
        description: Existing amount description.
  - name: customers
"""


def test_inserts_missing_descriptions_and_keeps_existing():
    result = set_descriptions(
        BASIC, "schema.yml", "models", "orders",
        "One row per order.",
        {"id": "Primary key.", "amount": "Should not replace."},
    )
    assert result.node is True
    assert result.columns == ("id",)
    data = _load(result.text)
    orders = data["models"][0]
    assert orders["description"] == "One row per order."
    assert orders["columns"][0] == {"name": "id", "description": "Primary key.", "tests": ["unique"]}
    assert orders["columns"][1]["description"] == "Existing amount description."
    assert "# the orders model" in result.text  # comments survive
    assert data["models"][1] == {"name": "customers"}


def test_overwrite_replaces_existing_description():
    result = set_descriptions(
        BASIC, "schema.yml", "models", "orders", None,
        {"amount": "Order total in USD: tax included."}, overwrite=True,
    )
    assert result.columns == ("amount",)
    assert '"Order total in USD: tax included."' in result.text
    assert _load(result.text)["models"][0]["columns"][1]["description"] == (
        "Order total in USD: tax included."
    )


def test_replaces_multiline_block_description():
    text = (
        "models:\n"
        "  - name: orders\n"
        "    description: |\n"
        "      line one\n"
        "      line two\n"
        "\n"
        "    columns:\n"
        "      - name: id\n"
    )
    result = set_descriptions(text, "s.yml", "models", "orders", "New.", {}, overwrite=True)
    data = _load(result.text)["models"][0]
    assert data["description"] == "New."
    assert data["columns"] == [{"name": "id"}]


def test_description_as_first_key_on_dash_line():
    text = "models:\n  - description: old\n    name: orders\n"
    result = set_descriptions(text, "s.yml", "models", "orders", "New one", {}, overwrite=True)
    assert result.text == "models:\n  - description: New one\n    name: orders\n"


def test_case_insensitive_column_match_and_crlf():
    text = "models:\r\n- name: orders\r\n  columns:\r\n  - name: ID\r\n"
    result = set_descriptions(text, "s.yml", "models", "orders", None, {"id": "Key"})
    assert result.columns == ("ID",)
    assert result.text == "models:\r\n- name: orders\r\n  columns:\r\n  - name: ID\r\n    description: Key\r\n"


def test_no_changes_returns_same_text():
    result = set_descriptions(BASIC, "schema.yml", "models", "orders", "", {"amount": "x"})
    assert not result.changed
    assert result.text == BASIC


def test_whitespace_is_collapsed_and_specials_quoted():
    result = set_descriptions(
        BASIC, "schema.yml", "models", "customers", "Yes\n  multi   line #1", {},
    )
    assert _load(result.text)["models"][1]["description"] == "Yes multi line #1"


def test_missing_entry_raises():
    with pytest.raises(SchemaYamlError):
        set_descriptions(BASIC, "schema.yml", "models", "nope", "x", {})


def test_flow_entry_raises():
    text = "models:\n  - {name: orders}\n"
    with pytest.raises(SchemaYamlError):
        set_descriptions(text, "s.yml", "models", "orders", "x", {})
