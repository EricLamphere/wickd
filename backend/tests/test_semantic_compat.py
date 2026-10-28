"""MetricFlow compatibility table, requirement pins and YAML spec detection (all pure)."""

import shutil
from pathlib import Path

import pytest

from app.semantic import compat
from app.semantic.compat import check, cli_release_for, compatible_versions, recommend
from app.semantic.pins import find_pins, rewrite_pins, would_undo
from app.semantic.spec import classify, detect_spec, is_latest_spec_parse_error, spec_of

FIXTURES = Path(__file__).parent / "fixtures" / "semantic"


# ── compat.check: every gap in the research matrix ─────────────────────────────


@pytest.mark.parametrize(
    ("dbt_core", "python", "latest", "want_cli", "ok", "code"),
    [
        ("1.10.13", "3.12", False, False, True, None),
        ("1.10.2", "3.12", False, False, True, None),  # sidecar reads 1.10.0–1.10.3 manifests
        ("1.10.2", "3.12", False, True, False, "no_cli_release"),  # no dbt-metricflow for 1.10.0–1.10.3
        ("1.9.11", "3.13", False, False, True, None),
        ("1.9.11", "3.13", False, True, False, "no_cli_release"),  # no 1.9 release for Python 3.13
        ("1.10.23", "3.14", False, True, False, "no_cli_release"),  # nor 1.10 on 3.14
        ("1.10.23", "3.13", False, True, True, None),
        ("1.11.16", "3.12", True, False, False, "latest_spec_needs_1_12"),
        ("1.12.6", "3.14", True, True, True, None),
        ("1.6.9", "3.11", False, False, False, "too_old"),
        (None, "3.12", False, False, False, "unknown_version"),
    ],
)
def test_check_matrix(dbt_core, python, latest, want_cli, ok, code) -> None:
    result = check(dbt_core, python, uses_latest_spec=latest, want_cli=want_cli)
    assert result.ok is ok
    assert result.reason_code == code
    if not ok:
        assert result.reason


def test_cli_release_matches_dbt_core_and_python() -> None:
    assert cli_release_for("1.10.13", "3.12")["dbt_metricflow"] == "0.13.0"
    assert cli_release_for("1.12.6", "3.14")["dbt_metricflow"] == "0.15.0"
    assert cli_release_for("1.7.19", "3.11")["dbt_metricflow"] == "0.6.0"
    assert cli_release_for("1.7.19", "3.12") is None
    assert check("1.10.13", "3.12", uses_latest_spec=False, want_cli=True).cli_release == "0.13.0"


def test_candidates_go_both_ways_and_skip_the_current_version() -> None:
    result = check("1.10.2", "3.12", uses_latest_spec=False, want_cli=True)
    assert "1.10.23" in result.compatible_dbt_versions  # same minor, newer patch
    assert "1.9.11" in result.compatible_dbt_versions  # older
    assert "1.12.6" in result.compatible_dbt_versions  # newer
    assert "1.10.2" not in result.compatible_dbt_versions


def test_candidates_respect_python_and_spec() -> None:
    assert compatible_versions("3.14", uses_latest_spec=False, want_cli=True) == ("1.11.16", "1.12.6")
    assert compatible_versions("3.12", uses_latest_spec=True, want_cli=False) == ("1.12.6",)


def test_newer_than_tested_is_ok_with_a_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    result = check("1.13.0", "3.12", uses_latest_spec=False)
    assert result.ok and result.warning and "newer" in result.warning
    monkeypatch.setattr(compat, "NEWEST_TESTED_MINOR", (1, 13))
    assert check("1.13.0", "3.12", uses_latest_spec=False).warning is None


@pytest.mark.parametrize(
    ("current", "candidates", "expected"),
    [
        ("1.10.2", ("1.9.11", "1.10.23", "1.11.16", "1.12.6"), "1.10.23"),
        ("1.11.16", ("1.12.6",), "1.12.6"),
        ("1.13.1", ("1.11.16", "1.12.6"), "1.12.6"),
        ("1.6.0", ("1.7.20", "1.8.10"), "1.7.20"),
        (None, ("1.11.16", "1.12.6"), "1.12.6"),
        ("1.10.2", (), None),
    ],
)
def test_recommend(current, candidates, expected) -> None:
    assert recommend(current, candidates) == expected


# ── requirement pins ───────────────────────────────────────────────────────────

REQS = """\
# tools
dbt-core==1.10.2  # pinned for prod
dbt-snowflake>=1.10
DBT_Core[extra] >=1.9,<1.11 ; python_version >= "3.9"
# dbt-core==1.0.0
dbt-core
"""


def test_find_pins() -> None:
    pins = find_pins(REQS)
    assert [(p.line, p.spec, p.exact) for p in pins] == [
        (2, "==1.10.2", True),
        (4, ">=1.9,<1.11", False),
        (6, "", False),
    ]
    assert pins[0].pinned_version == "1.10.2"
    assert pins[1].pinned_version is None


def test_would_undo() -> None:
    exact, ranged, bare = find_pins(REQS)
    assert would_undo(exact, "1.10.23")
    assert not would_undo(exact, "1.10.2")
    assert not would_undo(ranged, "1.10.23")
    assert would_undo(ranged, "1.12.6")
    assert not would_undo(bare, "1.12.6")


def test_rewrite_exact_only_by_default() -> None:
    text, changed = rewrite_pins(REQS, "1.12.6", replace_ranges=False)
    assert changed == [2]
    assert "dbt-core==1.12.6 # pinned for prod\n" in text
    assert 'DBT_Core[extra] >=1.9,<1.11 ; python_version >= "3.9"' in text


def test_rewrite_ranges_when_asked_keeps_extras_and_markers() -> None:
    text, changed = rewrite_pins(REQS, "1.12.6", replace_ranges=True)
    assert changed == [2, 4]
    assert 'DBT_Core[extra]==1.12.6 ; python_version >= "3.9"\n' in text
    assert "# dbt-core==1.0.0\n" in text
    assert text.endswith("dbt-core\n")


def test_rewrite_keeps_crlf_and_skips_satisfied_ranges() -> None:
    text, changed = rewrite_pins("dbt-core>=1.9,<1.11\r\ndbt-core==1.9.1\r\n", "1.10.5", replace_ranges=True)
    assert changed == [2]
    assert text == "dbt-core>=1.9,<1.11\r\ndbt-core==1.10.5\r\n"


# ── YAML spec detection ────────────────────────────────────────────────────────


def test_spec_of_documents() -> None:
    assert spec_of({"semantic_models": [{"name": "x"}]}) == {"legacy"}
    assert spec_of({"metrics": [{"name": "m"}]}) == set()  # both specs allow top-level metrics
    assert spec_of({"models": [{"name": "m", "semantic_model": {"enabled": True}}]}) == {"latest"}
    assert spec_of({"models": [{"name": "m"}]}) == set()
    assert spec_of(None) == set()
    assert classify({"legacy", "latest"}) == "mixed"
    assert classify(set()) == "none"


@pytest.mark.parametrize(("files", "expected"), [
    (["legacy_spec.yml"], "legacy"),
    (["latest_spec.yml"], "latest"),
    (["legacy_spec.yml", "latest_spec.yml"], "mixed"),
    ([], "none"),
])
def test_detect_spec(tmp_path: Path, files: list[str], expected: str) -> None:
    models = tmp_path / "models" / "sub"
    models.mkdir(parents=True)
    (models / "broken.yml").write_text("models: [unclosed\n")
    for name in files:
        shutil.copy(FIXTURES / name, models / name)
    assert detect_spec(tmp_path) == expected


def test_latest_spec_parse_error() -> None:
    assert is_latest_spec_parse_error("Could not render {{ Dimension(...) }}: 'Dimension' is undefined")
    assert not is_latest_spec_parse_error("Compilation Error: something else")
