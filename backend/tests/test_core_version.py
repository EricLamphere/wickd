import pytest

from app.dbt.core_version import (
    append_pin,
    dbt_core_requirement,
    install_spec,
    is_valid_version,
    parse_dbt_version,
    requirement_satisfied,
    stable_versions,
)


def test_stable_versions_newest_first_without_prereleases_or_yanked() -> None:
    pypi = {"releases": {
        "1.9.0": [{"yanked": False}],
        "1.10.13": [{"yanked": False}],
        "1.10.2": [{"yanked": False}],
        "1.11.0b1": [{"yanked": False}],
        "1.10.0rc2": [{"yanked": False}],
        "1.8.1": [{"yanked": True}],
        "1.7.0": [],
        "0.21.1": [{"yanked": False}],
        "not-a-version": [{"yanked": False}],
    }}
    assert stable_versions(pypi) == ["1.10.13", "1.10.2", "1.9.0"]


def test_stable_versions_empty() -> None:
    assert stable_versions({}) == []


@pytest.mark.parametrize(("raw", "ok"), [
    ("1.10.13", True), ("1.9.0", True), ("1.11.0b1", False), ("latest", False),
    ("", False), ("1.10", True), (" 1.10.13", False), ("1.10.13; rm -rf", False),
])
def test_is_valid_version(raw: str, ok: bool) -> None:
    assert is_valid_version(raw) is ok


def test_install_spec() -> None:
    assert install_spec("1.10.13") == "dbt-core==1.10.13"
    assert install_spec("") == "dbt-core"


@pytest.mark.parametrize(("text", "line"), [
    ("dbt-core==1.10.13\n", "dbt-core==1.10.13"),
    ("dbt-duckdb\nDBT_Core>=1.8  # pinned for prod\n", "DBT_Core>=1.8"),
    ("dbt-core[extra]~=1.9\n", "dbt-core[extra]~=1.9"),
    ("dbt-core; python_version >= '3.11'\n", "dbt-core; python_version >= '3.11'"),
    ("dbt-duckdb==1.9\ndbt-postgres\n", None),
    ("# dbt-core==1.10\n", None),
    ("-r base.txt\n--index-url https://x\n", None),
    ("dbt-core-extras\n", None),
    ("", None),
])
def test_dbt_core_requirement(text: str, line: str | None) -> None:
    assert dbt_core_requirement(text) == line


def test_append_pin() -> None:
    assert append_pin("dbt-duckdb\n", "1.10.13") == "dbt-duckdb\ndbt-core==1.10.13\n"
    assert append_pin("dbt-duckdb", "1.10.13") == "dbt-duckdb\ndbt-core==1.10.13\n"
    assert append_pin("", "1.10.13") == "dbt-core==1.10.13\n"


@pytest.mark.parametrize(("requirement", "installed", "expected"), [
    ("dbt-core==1.10.13", "1.10.13", True),
    ("dbt-core==1.10.13", "1.12.6", False),
    ("dbt-core>=1.8", "1.12.6", True),
    ("dbt-core>=1.8,<1.10", "1.12.6", False),
    ("dbt-core~=1.9.0", "1.9.4", True),
    ("DBT_Core[extra]==1.9.0; python_version >= '3.11'", "1.9.0", True),
    ("dbt-core", "1.12.6", None),
    ("not a requirement ===", "1.12.6", None),
    ("dbt-core==1.10.13", "unknown", None),
])
def test_requirement_satisfied(requirement: str, installed: str, expected: bool | None) -> None:
    assert requirement_satisfied(requirement, installed) is expected


DBT_1_10_OUTPUT = """Core:
  - installed: 1.10.13
  - latest:    1.12.6  - Update available!

Plugins:
  - snowflake: 1.10.2 - Update available!
"""


@pytest.mark.parametrize(("output", "version"), [
    (DBT_1_10_OUTPUT, "1.10.13"),
    ("installed version: 1.0.0\n   latest version: 1.0.1\n", "1.0.0"),
    ("Core:\n  - installed: 1.11.0b2\n", "1.11.0b2"),
    ("dbt-core 1.9.4\n", "1.9.4"),
    ("dbt Core 1.8.0", "1.8.0"),
    ("command not found", None),
])
def test_parse_dbt_version(output: str, version: str | None) -> None:
    assert parse_dbt_version(output) == version
