from pathlib import Path

import pytest

from app.dbt.hub import parse_package
from app.dbt.package_rows import build_rows, incompatible
from app.dbt.packages import (
    PackagesError,
    find_packages_file,
    parse_entries,
    read_project_packages,
    redact,
)
from app.health.summary import summarize_packages

PACKAGES = """\
packages:
  - package: dbt-labs/dbt_utils
    version: [">=1.0.0", "<2.0.0"]
  - package: calogica/dbt_expectations
    version: 0.10.1
  - git: "https://user:s3cret@github.com/acme/dbt-macros.git"
    revision: v0.3.0
  - git: "https://github.com/acme/dbt-branchy.git"
    revision: main
  - local: ../shared
  - tarball: https://example.com/pkg.tar.gz
    name: tar_pkg
  - private: acme/private-pkg
    revision: "1.0.0"
"""

LOCK = """\
packages:
  - package: dbt-labs/dbt_utils
    version: 1.1.1
  - package: calogica/dbt_expectations
    version: 0.10.1
  - package: calogica/dbt_date
    version: 0.10.0
  - git: "https://user:s3cret@github.com/acme/dbt-macros.git"
    revision: 4b1f0c2
sha1_hash: abc
"""


def _pkg(root: Path, folder: str, name: str, version: str | None, requires: str | None) -> None:
    d = root / folder
    d.mkdir(parents=True)
    lines = [f"name: {name}"]
    if version:
        lines.append(f"version: '{version}'")
    if requires:
        lines.append(f"require-dbt-version: {requires}")
    (d / "dbt_project.yml").write_text("\n".join(lines) + "\n")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    (root / "dbt_project.yml").write_text("name: proj\n")
    (root / "packages.yml").write_text(PACKAGES)
    (root / "package-lock.yml").write_text(LOCK)
    _pkg(root, "dbt_packages/dbt_utils", "dbt_utils", "1.1.1", '[">=1.3.0", "<2.0.0"]')
    _pkg(root, "dbt_packages/dbt_expectations", "dbt_expectations", "0.10.1", '[">=1.7.0", "<1.9.0"]')
    _pkg(root, "dbt_packages/dbt_date", "dbt_date", "0.10.0", '">=1.3.0"')
    _pkg(root, "dbt_packages/dbt_macros", "dbt_macros", "0.3.0", None)
    _pkg(tmp_path, "shared", "shared_macros", "1.0.0", None)
    _pkg(root, "dbt_packages/shared_macros", "shared_macros", "1.0.0", None)
    return root


def test_parse_every_source_type():
    specs = parse_entries(PACKAGES, "packages.yml")
    assert [s.source for s in specs] == ["hub", "hub", "git", "git", "local", "tarball", "private"]
    assert specs[0].requested == (">=1.0.0", "<2.0.0")
    assert specs[1].requested == ("0.10.1",)
    assert specs[2].requested == ("v0.3.0",)
    assert specs[5].name == "tar_pkg"
    assert specs[6].requested == ("1.0.0",)


def test_parse_errors_and_empty():
    assert parse_entries("", "packages.yml") == ()
    assert parse_entries("packages:\n", "packages.yml") == ()
    with pytest.raises(PackagesError):
        parse_entries("packages: [unclosed\n", "packages.yml")
    with pytest.raises(PackagesError):
        parse_entries("- a\n", "packages.yml")
    with pytest.raises(PackagesError):
        parse_entries("packages: nope\n", "packages.yml")


def test_redact_hides_credentials_and_jinja():
    assert redact("https://user:s3cret@github.com/a/b.git") == "https://***@github.com/a/b.git"
    assert redact("https://{{ env_var('TOKEN') }}@github.com/a/b") == "https://***@github.com/a/b"
    assert "TOKEN" not in redact("https://x-access-token:{{env_var('TOKEN')}}@github.com/a/b")


def test_find_packages_file(tmp_path: Path):
    assert find_packages_file(tmp_path) is None
    (tmp_path / "dependencies.yml").write_text("projects:\n  - name: core\n")
    assert find_packages_file(tmp_path) is None
    (tmp_path / "dependencies.yml").write_text("packages:\n  - package: a/b\n    version: 1.0.0\n")
    assert find_packages_file(tmp_path).name == "dependencies.yml"
    (tmp_path / "packages.yml").write_text("packages: []\n")
    assert find_packages_file(tmp_path).name == "packages.yml"


def test_custom_install_path(tmp_path: Path):
    (tmp_path / "dbt_project.yml").write_text("name: p\npackages-install-path: vendor\n")
    _pkg(tmp_path, "vendor/x", "x", "1.0.0", None)
    assert set(read_project_packages(tmp_path).installed) == {"x"}


def _hub(name: str, versions: dict[str, list[str]]) -> dict:
    ns, short = name.split("/")
    return {
        "name": short, "namespace": ns, "description": "d",
        "versions": {v: {"version": v, "require_dbt_version": r, "_source": {"url": f"https://github.com/{ns}/{short}/tree/{v}/"}}
                     for v, r in versions.items()},
    }


def test_rows_join_files_installed_and_hub(project: Path):
    packages = read_project_packages(project)
    hub = {
        "dbt-labs/dbt_utils": parse_package(_hub("dbt-labs/dbt_utils", {
            "1.1.1": [">=1.3.0", "<2.0.0"], "1.3.0": [">=1.3.0", "<2.0.0"], "2.0.0": [">=2.0.0"]})),
        "calogica/dbt_expectations": parse_package(_hub("calogica/dbt_expectations", {"0.10.1": [">=1.7.0", "<1.9.0"]})),
    }
    rows = {r.key: r for r in build_rows(packages, project, "1.10.0", hub)}

    utils = rows["dbt-labs/dbt_utils"]
    assert (utils.locked, utils.installed, utils.compatible) == ("1.1.1", "1.1.1", True)
    assert (utils.latest, utils.latest_compatible, utils.upgrade_to, utils.latest_blocked) == ("2.0.0", "1.3.0", "1.3.0", True)
    assert utils.requested == ">=1.0.0, <2.0.0"

    exp = rows["calogica/dbt_expectations"]
    assert exp.compatible is False and exp.upgrade_to is None

    git = rows["https://user:s3cret@github.com/acme/dbt-macros.git"]
    assert git.name == "https://***@github.com/acme/dbt-macros.git"
    assert git.installed == "0.3.0" and git.locked == "4b1f0c2" and git.editable

    branchy = rows["https://github.com/acme/dbt-branchy.git"]
    assert branchy.installed is None
    assert any("branch or commit" in n for n in branchy.notes)
    assert any("Not installed" in n for n in branchy.notes)

    assert rows["../shared"].installed == "1.0.0" and not rows["../shared"].editable
    transitive = [r for r in rows.values() if not r.direct]
    assert [(r.name, r.locked) for r in transitive] == [("calogica/dbt_date", "0.10.0")]
    assert [r.key for r in incompatible(list(rows.values()))] == ["calogica/dbt_expectations"]


def test_git_tag_upgrade_keeps_prefix(project: Path):
    packages = read_project_packages(project)
    key = "https://user:s3cret@github.com/acme/dbt-macros.git"
    hub = {key: parse_package(_hub("acme/dbt_macros", {"0.3.0": [], "0.4.0": []}))}
    row = next(r for r in build_rows(packages, project, "1.10.0", hub) if r.key == key)
    assert row.upgrade_to == "v0.4.0"


def test_rows_without_hub_or_dbt_version(project: Path):
    rows = build_rows(read_project_packages(project), project, None, {})
    utils = rows[0]
    assert utils.compatible is None and utils.latest is None and utils.upgrade_to is None


def test_summarize_packages():
    bad = summarize_packages([{"name": "a", "direct": True, "installed": "1", "compatible": False}], dbt_version="1.10.0")
    assert bad.status == "fail" and "a doesn't support dbt 1.10.0" in bad.headline
    missing = summarize_packages([{"name": "a", "direct": True, "installed": None, "compatible": None}], dbt_version=None)
    assert missing.status == "warn" and missing.issues == 1
    ok = summarize_packages([{"name": "a", "direct": True, "installed": "1", "compatible": True}], dbt_version="1.10.0")
    assert ok.status == "ok" and ok.headline == "1 package installed"


def test_installed_version_prefers_lock_over_stale_project_version(tmp_path: Path):
    root = tmp_path / "p"
    root.mkdir()
    (root / "packages.yml").write_text("packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.4.1\n")
    (root / "package-lock.yml").write_text("packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.4.1\n")
    _pkg(root, "dbt_packages/dbt_utils", "dbt_utils", "0.1.0", None)  # dbt_utils never bumps it
    [row] = build_rows(read_project_packages(root), root, "1.10.0", {})
    assert row.installed == "1.4.1" and row.notes == ()
    (root / "package-lock.yml").unlink()  # dbt < 1.7: no lock, fall back to dbt_project.yml
    [row] = build_rows(read_project_packages(root), root, "1.10.0", {})
    assert row.installed == "0.1.0"
