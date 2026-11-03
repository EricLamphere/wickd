"""dbt Charts board discovery under charts/ (pure, no dct)."""

from pathlib import Path, PurePosixPath

import pytest

from app.charts import discovery


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    _write(tmp_path, "charts/sales.yml", "title: Sales\ncharts:\n  a: {type: kpi}\n  b: {type: bar}\nrows: [a, b]\n")
    _write(tmp_path, "charts/team/ops.yaml", "charts: {}\nrows: []\n")
    _write(tmp_path, "charts/team/index.yml", "title: Team\n")
    _write(tmp_path, "charts/broken.yml", "title: [unclosed\n")
    _write(tmp_path, "charts/list.yml", "- not a mapping\n")
    _write(tmp_path, "charts/notes.md", "---\ntitle: Notes board\ncharts:\n  x: {type: kpi}\n---\n# Heading\n")
    _write(tmp_path, "charts/plain.md", "# Plain heading\ntext\n")
    _write(tmp_path, "charts/_brand.yml", "theme: dark\n")
    _write(tmp_path, "charts/meta.yml", "source: x\n")
    _write(tmp_path, "charts/partials/kpi.yml", "type: kpi\n")
    _write(tmp_path, "charts/templates/x.yml", "a: b\n")
    _write(tmp_path, "charts/data.csv", "a,b\n")
    return tmp_path


def test_finds_boards_with_rules_of_dct(project: Path) -> None:
    boards = {b.id: b for b in discovery.find_boards(project)}
    assert set(boards) == {"sales", "team/ops", "team/index", "broken", "list", "notes", "plain"}
    assert boards["sales"].title == "Sales"
    assert boards["sales"].chart_count == 2
    assert boards["sales"].path == "charts/sales.yml"
    assert boards["team/ops"].title == "Ops"  # from the file name
    assert boards["team/index"].url_path == "team"
    assert boards["team/ops"].url_path == "team/ops"


def test_invalid_boards_are_listed_with_their_error(project: Path) -> None:
    boards = {b.id: b for b in discovery.find_boards(project)}
    assert boards["broken"].error and "invalid YAML" in boards["broken"].error
    assert boards["list"].error and "mapping" in boards["list"].error


def test_markdown_boards(project: Path) -> None:
    boards = {b.id: b for b in discovery.find_boards(project)}
    assert boards["notes"].title == "Notes board"
    assert boards["notes"].chart_count == 1
    assert boards["plain"].title == "Plain heading"


def test_cache_follows_edits(project: Path) -> None:
    assert discovery.find_board(project, "sales").title == "Sales"
    (project / "charts/sales.yml").write_text("title: Sales v2 with a longer title\nrows: []\n")
    assert discovery.find_board(project, "sales").title == "Sales v2 with a longer title"


def test_no_charts_folder(tmp_path: Path) -> None:
    assert discovery.find_boards(tmp_path) == ()
    assert not discovery.has_boards(tmp_path)


def test_has_boards(project: Path) -> None:
    assert discovery.has_boards(project)


@pytest.mark.parametrize(("rel", "expected"), [
    ("a.yml", True), ("a/b.yaml", True), ("a.md", True), ("a.markdown", True),
    ("_a.yml", False), ("meta.yml", False), ("partials/a.yml", False), (".hidden/a.yml", False),
    ("a.json", False), ("a/.x.yml", False),
])
def test_is_board_file(rel: str, expected: bool) -> None:
    assert discovery.is_board_file(PurePosixPath(rel)) is expected
