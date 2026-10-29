"""Exposure splicer (dbt/schema_exposures.py): golden YAML for a new file, a file without
`exposures:` and one with it, plus refusals."""

import pytest

from app.dbt.schema_exposures import (
    ExposureSpec,
    add_exposure,
    exposure_metrics,
    remove_exposure,
    update_exposure_metrics,
)
from app.dbt.schema_yaml import SchemaYamlError

SPEC = ExposureSpec(name="revenue_overview", owner="Data team", metrics=("revenue", "order_count"),
                    description="Revenue overview", dashboard_path="wickd/dashboards/revenue-overview.yml")

ENTRY = """\
  - name: revenue_overview
    type: dashboard
    description: "Revenue overview"
    owner:
      name: "Data team"
    depends_on:
      - metric('revenue')
      - metric('order_count')
    meta:
      wickd_dashboard: "wickd/dashboards/revenue-overview.yml"
"""


def test_new_file() -> None:
    assert add_exposure("", "exposures.yml", SPEC) == "version: 2\n\nexposures:\n" + ENTRY


def test_file_without_exposures_key() -> None:
    text = "version: 2\n\nmodels:\n  - name: orders\n"
    assert add_exposure(text, "schema.yml", SPEC) == text + "\nexposures:\n" + ENTRY


def test_existing_exposures_key() -> None:
    text = (
        "version: 2\n"
        "exposures:\n"
        "  - name: weekly_report\n"
        "    type: analysis\n"
        "    owner:\n"
        "      email: a@example.com\n"
        "    depends_on:\n"
        "      - ref('orders')\n"
        "models:\n"
        "  - name: orders\n"
    )
    out = add_exposure(text, "schema.yml", SPEC)
    head, _, tail = out.partition("models:\n")
    assert head.endswith("      - ref('orders')\n" + ENTRY)
    assert tail == "  - name: orders\n"


def test_zero_offset_style() -> None:
    text = "version: 2\nexposures:\n- name: a\n  type: analysis\n  owner:\n    name: x\n"
    out = add_exposure(text, "e.yml", SPEC)
    assert "\n- name: revenue_overview\n  type: dashboard\n" in out
    assert "  depends_on:\n  - metric('revenue')\n" in out


@pytest.mark.parametrize(("spec", "message"), [
    (ExposureSpec(name="Bad Name", owner="x", metrics=("m",)), "lowercase"),
    (ExposureSpec(name="ok", owner="x", metrics=()), "at least one metric"),
    (ExposureSpec(name="ok", owner=" ", metrics=("m",)), "owner"),
    (ExposureSpec(name="ok", owner="x", metrics=("m') }}",)), "valid metric"),
])
def test_refusals(spec: ExposureSpec, message: str) -> None:
    with pytest.raises(SchemaYamlError, match=message):
        add_exposure("", "e.yml", spec)


def test_duplicate_name() -> None:
    text = add_exposure("", "e.yml", SPEC)
    with pytest.raises(SchemaYamlError, match="already has an exposure"):
        add_exposure(text, "e.yml", SPEC)


def test_update_metrics_keeps_other_entries_and_layout() -> None:
    text = (
        "version: 2\n"
        "exposures:\n"
        "  - name: revenue_overview\n"
        "    type: dashboard\n"
        "    owner:\n"
        "      name: x\n"
        "    depends_on:\n"
        "      - ref('orders')\n"
        "      - metric('revenue')\n"
        "    meta:\n"
        "      wickd_dashboard: a.yml\n"
        "  - name: other\n"
        "    type: analysis\n"
        "    owner:\n"
        "      name: y\n"
        "    depends_on:\n"
        "      - metric('revenue')\n"
    )
    out = update_exposure_metrics(text, "e.yml", "revenue_overview", ("revenue", "order_count"))
    assert out == text.replace("      - metric('revenue')\n    meta:", "      - metric('revenue')\n      - metric('order_count')\n    meta:")
    assert exposure_metrics(["ref('x')", "metric('a')", " metric( \"b\" ) "]) == ["a", "b"]


def test_update_metrics_adds_a_missing_depends_on_and_handles_inline_lists() -> None:
    text = "exposures:\n- name: a\n  type: dashboard\n  owner:\n    name: x\n"
    assert update_exposure_metrics(text, "e.yml", "a", ("m",)) == text + "  depends_on:\n  - metric('m')\n"
    inline = "exposures:\n  - name: a\n    depends_on: [metric('m')]\n    type: dashboard\n"
    assert update_exposure_metrics(inline, "e.yml", "a", ("m", "n")) == (
        "exposures:\n  - name: a\n    depends_on:\n      - metric('m')\n      - metric('n')\n    type: dashboard\n")


def test_update_metrics_refusals() -> None:
    with pytest.raises(SchemaYamlError, match="no exposure named"):
        update_exposure_metrics("exposures:\n  - name: a\n", "e.yml", "b", ("m",))
    with pytest.raises(SchemaYamlError, match="no `exposures:`"):
        update_exposure_metrics("models: []\n", "e.yml", "a", ("m",))


TWO = (
    "version: 2\n"
    "\n"
    "exposures:\n"
    "  - name: a\n"
    "    type: dashboard\n"
    "    owner:\n"
    "      name: x\n"
    "\n"
    "  - name: b\n"
    "    type: analysis\n"
    "    owner:\n"
    "      name: y\n"
    "models:\n"
    "  - name: orders\n"
)


def test_remove_one_of_several() -> None:
    first = remove_exposure(TWO, "e.yml", "a")
    assert first.text == TWO.replace("  - name: a\n    type: dashboard\n    owner:\n      name: x\n\n", "")
    assert not first.empty
    last = remove_exposure(TWO, "e.yml", "b")
    assert last.text == TWO.replace("\n  - name: b\n    type: analysis\n    owner:\n      name: y\n", "")


def test_remove_the_only_one() -> None:
    only = add_exposure("", "e.yml", SPEC)
    removed = remove_exposure(only, "e.yml", "revenue_overview")
    assert removed.empty and removed.text.strip() == "version: 2"
    with_models = "version: 2\nmodels:\n  - name: orders\n" + "\nexposures:\n" + ENTRY
    kept = remove_exposure(with_models, "e.yml", "revenue_overview")
    assert not kept.empty and "exposures" not in kept.text and "- name: orders" in kept.text


def test_remove_refusals() -> None:
    with pytest.raises(SchemaYamlError, match="no exposure named"):
        remove_exposure(TWO, "e.yml", "zzz")
    with pytest.raises(SchemaYamlError, match="inline"):
        remove_exposure("exposures: [{name: a}]\n", "e.yml", "a")
