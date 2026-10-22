from pathlib import Path

import pytest

from app.exports.paths import ExportPathError, default_export_dir, resolve_export_path


def test_resolves_file_inside_directory(tmp_path: Path):
    assert resolve_export_path(str(tmp_path), "dag.svg", "svg") == tmp_path / "dag.svg"


def test_appends_missing_extension(tmp_path: Path):
    assert resolve_export_path(str(tmp_path), "my dag", "html") == tmp_path / "my dag.html"


def test_extension_check_is_case_insensitive(tmp_path: Path):
    assert resolve_export_path(str(tmp_path), "DAG.PNG", "png") == tmp_path / "DAG.PNG"


def test_wrong_extension_gets_the_right_one_appended(tmp_path: Path):
    assert resolve_export_path(str(tmp_path), "dag.svg", "png") == tmp_path / "dag.svg.png"


def test_strips_surrounding_whitespace(tmp_path: Path):
    assert resolve_export_path(f"  {tmp_path} ", "  dag.svg ", "svg") == tmp_path / "dag.svg"


def test_expands_tilde(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert resolve_export_path("~", "dag.svg", "svg") == tmp_path / "dag.svg"


@pytest.mark.parametrize("filename", ["", "   ", "a/b.svg", "..", ".", "a\\b.svg", "x\0.svg"])
def test_rejects_bad_filenames(tmp_path: Path, filename: str):
    with pytest.raises(ExportPathError) as exc:
        resolve_export_path(str(tmp_path), filename, "svg")
    assert exc.value.field == "filename"


def test_rejects_overlong_filename(tmp_path: Path):
    with pytest.raises(ExportPathError) as exc:
        resolve_export_path(str(tmp_path), "a" * 300, "svg")
    assert exc.value.field == "filename"


def test_rejects_relative_directory():
    with pytest.raises(ExportPathError) as exc:
        resolve_export_path("relative/dir", "dag.svg", "svg")
    assert exc.value.field == "directory"


def test_rejects_missing_directory(tmp_path: Path):
    with pytest.raises(ExportPathError) as exc:
        resolve_export_path(str(tmp_path / "nope"), "dag.svg", "svg")
    assert exc.value.field == "directory"


def test_rejects_file_as_directory(tmp_path: Path):
    f = tmp_path / "file.txt"
    f.write_text("x")
    with pytest.raises(ExportPathError) as exc:
        resolve_export_path(str(f), "dag.svg", "svg")
    assert exc.value.field == "directory"


def test_default_dir_prefers_downloads(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "Downloads").mkdir()
    assert default_export_dir() == tmp_path / "Downloads"


def test_default_dir_falls_back_to_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert default_export_dir() == tmp_path
