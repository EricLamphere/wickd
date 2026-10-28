from pathlib import Path

import pytest
from ruamel.yaml import YAML

from app.dbt.schema_semantic import chosen_metrics, render_latest, render_legacy
from app.dbt.schema_yaml import SchemaYamlError

FIXTURES = Path(__file__).parent / "fixtures" / "semantic"

LEGACY_ITEMS = {
    "spec": "legacy",
    "semantic_model": {
        "name": "payments",
        "description": "One row per payment.",
        "model": "ref('stg_payments')",
        "defaults": {"agg_time_dimension": "paid_at"},
        "entities": [{"name": "payment", "type": "primary", "expr": "payment_id"},
                     {"name": "order_id", "type": "foreign"}],
        "dimensions": [{"name": "paid_at", "type": "time", "type_params": {"time_granularity": "day"}},
                       {"name": "method", "type": "categorical"}],
        "measures": [{"name": "payment_count", "agg": "count", "expr": "payment_id"},
                     {"name": "paid_amount", "description": "Amount: in dollars.", "agg": "sum", "expr": "amount"}],
    },
    "metrics": [
        {"key": "metric:payment_count", "name": "payment_count", "level": "top", "inputs": [],
         "entry": {"name": "payment_count", "label": "Payments", "type": "simple", "type_params": {"measure": "payment_count"}}},
        {"key": "metric:paid_amount", "name": "paid_amount", "level": "top", "inputs": [],
         "entry": {"name": "paid_amount", "label": "Paid amount", "type": "simple", "type_params": {"measure": "paid_amount"}}},
        {"key": "metric:avg_payment", "name": "avg_payment", "level": "top", "inputs": ["paid_amount", "payment_count"],
         "entry": {"name": "avg_payment", "label": "Average payment", "type": "ratio",
                   "type_params": {"numerator": "paid_amount", "denominator": "payment_count"}}},
        {"key": "metric:paid_per_order", "name": "paid_per_order", "level": "top", "inputs": ["paid_amount", "order_count"],
         "entry": {"name": "paid_per_order", "label": "Paid per order", "type": "ratio",
                   "type_params": {"numerator": "paid_amount", "denominator": "order_count"}}},
    ],
}
ALL = ["semantic_model", "metric:payment_count", "metric:paid_amount", "metric:avg_payment", "metric:paid_per_order"]

LATEST_ITEMS = {
    "spec": "latest",
    "semantic_model": {
        "model": {"semantic_model": {"enabled": True, "name": "payments"}, "agg_time_dimension": "paid_at"},
        "columns": {
            "payment_id": {"entity": {"type": "primary", "name": "payment"}},
            "paid_at": {"granularity": "day", "dimension": {"type": "time"}},
            "method": {"dimension": {"type": "categorical"}},
        },
    },
    "metrics": [
        {"key": "metric:payment_count", "name": "payment_count", "level": "model", "inputs": [],
         "entry": {"name": "payment_count", "label": "Payments", "type": "simple", "agg": "count", "expr": "payment_id"}},
        {"key": "metric:paid_amount", "name": "paid_amount", "level": "model", "inputs": [],
         "entry": {"name": "paid_amount", "label": "Paid amount", "type": "simple", "agg": "sum", "expr": "amount"}},
        {"key": "metric:avg_payment", "name": "avg_payment", "level": "top", "inputs": ["paid_amount", "payment_count"],
         "entry": {"name": "avg_payment", "type": "ratio", "numerator": "paid_amount", "denominator": "payment_count"}},
    ],
}


def _load(text: str) -> dict:
    return YAML(typ="safe").load(text)


def test_legacy_appends_to_an_existing_semantic_file_untouched() -> None:
    original = (FIXTURES / "legacy_spec.yml").read_text()
    text = render_legacy(original, "semantic.yml", LEGACY_ITEMS, ALL)
    data = _load(text)
    assert text.startswith(original.split("\nmetrics:")[0])  # earlier text kept byte for byte
    assert data["semantic_models"][-1]["name"] == "payments"
    assert data["semantic_models"][-1]["measures"][1]["description"] == "Amount: in dollars."
    assert [m["name"] for m in data["metrics"]][-4:] == ["payment_count", "paid_amount", "avg_payment", "paid_per_order"]
    assert "  - name: payments\n    description: One row per payment.\n    model: ref('stg_payments')\n" in text


def test_legacy_creates_keys_in_a_models_only_file_in_its_indent_style() -> None:
    original = "version: 2\n\nmodels:\n- name: stg_payments\n  columns:\n  - name: payment_id\n"
    text = render_legacy(original, "schema.yml", LEGACY_ITEMS, ["semantic_model", "metric:payment_count"])
    assert text.startswith(original + "\nsemantic_models:\n- name: payments\n")
    assert "\nmetrics:\n- name: payment_count\n  label: Payments\n  type: simple\n  type_params:\n    measure: payment_count\n" in text
    assert render_legacy(None, "new.yml", LEGACY_ITEMS, ["semantic_model"]).startswith("version: 2\n\nsemantic_models:\n")


def test_selection_drops_metrics_whose_inputs_are_gone() -> None:
    names = lambda keys: [m["name"] for m in chosen_metrics(LEGACY_ITEMS, keys)]
    assert names(ALL) == ["payment_count", "paid_amount", "avg_payment", "paid_per_order"]
    assert names([k for k in ALL if k != "metric:payment_count"]) == ["paid_amount", "paid_per_order"]
    # without the semantic model only ratios over existing metrics could survive, and these need its measures
    assert names([k for k in ALL if k != "semantic_model"]) == []
    text = render_legacy("models: []\n", "s.yml", LEGACY_ITEMS, ["metric:avg_payment"])
    assert text == "models: []\n"


def test_legacy_refuses_name_clashes_and_inline_lists() -> None:
    with pytest.raises(SchemaYamlError, match="already has `payments`"):
        render_legacy("semantic_models:\n  - name: payments\n", "s.yml", LEGACY_ITEMS, ["semantic_model"])
    with pytest.raises(SchemaYamlError, match="inline"):
        render_legacy("metrics: [{name: x}]\n", "s.yml", LEGACY_ITEMS, ["semantic_model", "metric:payment_count"])


def test_latest_adds_keys_to_the_model_and_its_columns() -> None:
    original = (
        "models:\n"
        "  - name: stg_payments\n"
        "    description: Payments.\n"
        "    columns:\n"
        "      - name: payment_id\n"
        "        description: Key.  # the key\n"
        "      - name: amount\n"
        "\n"
        "  - name: other\n"
    )
    text = render_latest(original, "schema.yml", "stg_payments", LATEST_ITEMS,
                         ["semantic_model", "metric:payment_count", "metric:paid_amount", "metric:avg_payment"])
    model = _load(text)["models"][0]
    assert model["semantic_model"] == {"enabled": True, "name": "payments"} and model["agg_time_dimension"] == "paid_at"
    cols = {c["name"]: c for c in model["columns"]}
    assert cols["payment_id"] == {"name": "payment_id", "description": "Key.", "entity": {"type": "primary", "name": "payment"}}
    assert cols["paid_at"] == {"name": "paid_at", "granularity": "day", "dimension": {"type": "time"}}  # added column
    assert [m["name"] for m in model["metrics"]] == ["payment_count", "paid_amount"]
    assert _load(text)["metrics"] == [{"name": "avg_payment", "type": "ratio", "numerator": "paid_amount", "denominator": "payment_count"}]
    assert "        description: Key.  # the key\n        entity:\n          type: primary\n" in text
    assert _load(text)["models"][1] == {"name": "other"}


def test_latest_creates_the_model_entry_and_refuses_existing_keys() -> None:
    text = render_latest(None, "schema.yml", "stg_payments", LATEST_ITEMS, ["semantic_model", "metric:payment_count"])
    model = _load(text)["models"][0]
    assert model["semantic_model"]["name"] == "payments" and len(model["columns"]) == 3
    already = "models:\n  - name: stg_payments\n    semantic_model:\n      enabled: true\n"
    with pytest.raises(SchemaYamlError, match="already has `semantic_model`"):
        render_latest(already, "schema.yml", "stg_payments", LATEST_ITEMS, ["semantic_model"])
