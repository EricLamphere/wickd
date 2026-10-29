"""Exposure splicer (dbt/schema_exposures.py): golden YAML for a new file, a file without
`exposures:` and one with it, plus refusals."""

import pytest

from app.dbt.schema_exposures import ExposureSpec, add_exposure
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
