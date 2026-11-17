import pytest

from app.dbt.packages import PackagesError, parse_entries
from app.dbt.packages_yaml import PackageChange, apply_change, apply_changes, render_scalar

FILE = """\
# project packages
packages:
  - package: dbt-labs/dbt_utils
    version: 1.1.1  # pinned for prod
  - package: calogica/dbt_expectations
    version: [">=0.10.0", "<0.11.0"]
  # internal macros
  - git: "https://github.com/acme/dbt-macros.git"
    revision: v0.3.0
  - local: ../shared
"""


def _keys(text: str) -> list[str]:
    return [s.key for s in parse_entries(text, "packages.yml")]


def test_render_scalar_quotes_values_yaml_would_retype():
    assert render_scalar("1.1.1") == "1.1.1"
    assert render_scalar("1.10") == '"1.10"'
    assert render_scalar("2") == '"2"'
    assert render_scalar("dbt-labs/dbt_utils") == "dbt-labs/dbt_utils"
    assert render_scalar(">=1.0.0") == '">=1.0.0"'


def test_add_appends_after_last_entry_in_file_style():
    out = apply_change(FILE, "packages.yml", PackageChange("add", "dbt-labs/codegen", "0.12.1"))
    assert out.startswith(FILE)
    assert out.endswith("  - package: dbt-labs/codegen\n    version: 0.12.1\n")


def test_add_to_new_or_empty_file():
    assert apply_change(None, "packages.yml", PackageChange("add", "a/b", "1.0.0")) == (
        "packages:\n  - package: a/b\n    version: 1.0.0\n"
    )
    out = apply_change("packages: []  # none yet\n", "packages.yml", PackageChange("add", "a/b", "1.0.0"))
    assert _keys(out) == ["a/b"]
    out = apply_change("name: x\n", "dependencies.yml", PackageChange("add", "a/b", "1.0.0"))
    assert out.startswith("name: x\n") and _keys(out) == ["a/b"]


def test_add_with_zero_indent_style():
    text = "packages:\n- package: a/b\n  version: 1.0.0\nother: 1\n"
    out = apply_change(text, "packages.yml", PackageChange("add", "c/d", "2.0.0"))
    assert out == "packages:\n- package: a/b\n  version: 1.0.0\n- package: c/d\n  version: 2.0.0\nother: 1\n"


def test_add_refuses_duplicate():
    with pytest.raises(PackagesError, match="already"):
        apply_change(FILE, "packages.yml", PackageChange("add", "dbt-labs/dbt_utils", "1.2.0"))


def test_set_version_keeps_comment_and_replaces_flow_list():
    out = apply_change(FILE, "packages.yml", PackageChange("set_version", "dbt-labs/dbt_utils", "1.3.0"))
    assert "    version: 1.3.0  # pinned for prod\n" in out
    out = apply_change(out, "packages.yml", PackageChange("set_version", "calogica/dbt_expectations", "0.10.4"))
    assert "    version: 0.10.4\n" in out
    assert "# internal macros" in out and "# project packages" in out


def test_set_version_replaces_block_list():
    text = "packages:\n  - package: a/b\n    version:\n      - \">=1.0.0\"\n      - \"<2.0.0\"\n  - local: x\n"
    out = apply_change(text, "packages.yml", PackageChange("set_version", "a/b", "1.5.0"))
    assert out == "packages:\n  - package: a/b\n    version: 1.5.0\n  - local: x\n"


def test_set_git_revision():
    out = apply_change(FILE, "packages.yml", PackageChange("set_version", "https://github.com/acme/dbt-macros.git", "v0.4.0"))
    assert "    revision: v0.4.0\n" in out


def test_set_version_on_local_is_refused():
    with pytest.raises(PackagesError):
        apply_change(FILE, "packages.yml", PackageChange("set_version", "../shared", "1.0.0"))


def test_remove_entry_and_last_entry():
    out = apply_change(FILE, "packages.yml", PackageChange("remove", "calogica/dbt_expectations"))
    assert _keys(out) == ["dbt-labs/dbt_utils", "https://github.com/acme/dbt-macros.git", "../shared"]
    assert "# internal macros" in out
    single = "packages:  # deps\n  - package: a/b\n    version: 1.0.0\nname: x\n"
    out = apply_change(single, "packages.yml", PackageChange("remove", "a/b"))
    assert out == "packages: []  # deps\nname: x\n"


def test_remove_unknown_and_flow_style():
    with pytest.raises(PackagesError, match="isn't in"):
        apply_change(FILE, "packages.yml", PackageChange("remove", "nope/nope"))
    with pytest.raises(PackagesError, match="inline"):
        apply_change('packages: [{package: a/b, version: "1.0.0"}]\n', "packages.yml", PackageChange("remove", "a/b"))


def test_apply_changes_in_sequence():
    out = apply_changes(FILE, "packages.yml", [
        PackageChange("set_version", "dbt-labs/dbt_utils", "1.3.0"),
        PackageChange("remove", "../shared"),
        PackageChange("add", "dbt-labs/codegen", "0.12.1"),
    ])
    assert _keys(out) == [
        "dbt-labs/dbt_utils", "calogica/dbt_expectations", "https://github.com/acme/dbt-macros.git", "dbt-labs/codegen",
    ]


def test_file_without_trailing_newline():
    out = apply_change("packages:\n  - package: a/b\n    version: 1.0.0", "packages.yml", PackageChange("add", "c/d", "1.0.0"))
    assert _keys(out) == ["a/b", "c/d"]
