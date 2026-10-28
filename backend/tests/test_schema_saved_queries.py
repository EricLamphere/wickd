from pathlib import Path

import pytest
from ruamel.yaml import YAML

from app.dbt.schema_saved_queries import SavedQuerySpec, add_saved_query, group_by_template
from app.dbt.schema_yaml import SchemaYamlError

FIXTURES = Path(__file__).parent / "fixtures" / "semantic"
SPEC = SavedQuerySpec(
    name="revenue_by_country",
    label="Revenue by country",
    metrics=("revenue",),
    group_by=("TimeDimension('metric_time', 'week')", "Dimension('customer__country')"),
    where=("{{ Dimension('customer__country') }} = 'US'",),
)


def _saved(text: str) -> list[dict]:
    return YAML(typ="safe").load(text)["saved_queries"]


@pytest.mark.parametrize("fixture", ["legacy_spec.yml", "latest_spec.yml"])
def test_appends_to_existing_saved_queries_in_both_specs(fixture: str) -> None:
    original = (FIXTURES / fixture).read_text()
    edited = add_saved_query(original, fixture, SPEC)
    assert edited.startswith(original.rstrip("\n").rsplit("\n", 1)[0])  # existing text untouched
    entry = _saved(edited)[-1]
    assert entry == {
        "name": "revenue_by_country", "label": "Revenue by country",
        "query_params": {
            "metrics": ["revenue"],
            "group_by": ["TimeDimension('metric_time', 'week')", "Dimension('customer__country')"],
            "where": ["{{ Dimension('customer__country') }} = 'US'"],
        },
    }
    assert "        - TimeDimension('metric_time', 'week')\n" in edited  # plain, like hand-written files


def test_adds_the_key_when_missing_and_keeps_zero_offset_style() -> None:
    original = "version: 2\n\nmetrics:\n- name: revenue\n  type: simple\n"
    edited = add_saved_query(original, "m.yml", SavedQuerySpec(name="q", metrics=("revenue",)))
    assert edited == original + "\nsaved_queries:\n- name: q\n  query_params:\n    metrics:\n    - revenue\n"


def test_keeps_blank_lines_between_entries() -> None:
    original = (
        "saved_queries:\n  - name: a\n    query_params:\n      metrics: [x]\n\n"
        "  - name: b\n    query_params:\n      metrics: [y]\n"
    )
    edited = add_saved_query(original, "m.yml", SavedQuerySpec(name="c", metrics=("z",)))
    assert edited == original + "\n  - name: c\n    query_params:\n      metrics:\n        - z\n"


def test_empty_key_and_empty_file() -> None:
    assert _saved(add_saved_query("saved_queries:\n", "m.yml", SPEC))[0]["name"] == "revenue_by_country"
    assert add_saved_query("", "m.yml", SavedQuerySpec(name="q", metrics=("m",))).startswith("version: 2\n\nsaved_queries:\n")


@pytest.mark.parametrize("text, spec, message", [
    ("saved_queries:\n  - name: q\n    query_params: {metrics: [m]}\n", SavedQuerySpec(name="q", metrics=("m",)), "already has"),
    ("saved_queries: [{name: a}]\n", SavedQuerySpec(name="q", metrics=("m",)), "inline"),
    ("saved_queries: {}\n", SavedQuerySpec(name="q", metrics=("m",)), "not a list"),
    ("", SavedQuerySpec(name="Bad Name", metrics=("m",)), "lowercase"),
    ("", SavedQuerySpec(name="q", metrics=()), "at least one metric"),
    ("a: [\n", SavedQuerySpec(name="q", metrics=("m",)), "could not parse"),
])
def test_refuses_unsafe_edits(text, spec, message) -> None:
    with pytest.raises(SchemaYamlError, match=message):
        add_saved_query(text, "m.yml", spec)


def test_verification_failure_is_reported(monkeypatch) -> None:
    from app.dbt import schema_saved_queries

    monkeypatch.setattr(schema_saved_queries, "_entry_lines", lambda *a: ["  - name: other\n"])
    with pytest.raises(SchemaYamlError, match="layout is unusual"):
        add_saved_query("saved_queries:\n", "m.yml", SPEC)


DIMS = {"metric_time__day": "time", "customer__country": "categorical", "order__order_date": "time"}


@pytest.mark.parametrize("name, expected", [
    ("metric_time__week", "TimeDimension('metric_time', 'week')"),
    ("metric_time__day", "TimeDimension('metric_time', 'day')"),
    ("order__order_date__month", "TimeDimension('order__order_date', 'month')"),
    ("order__order_date", "TimeDimension('order__order_date')"),
    ("customer__country", "Dimension('customer__country')"),
    ("customer", "Entity('customer')"),
])
def test_group_by_template(name, expected) -> None:
    assert group_by_template(name, DIMS) == expected
