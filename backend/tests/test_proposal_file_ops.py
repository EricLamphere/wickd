"""Proposal file operations (app/ai/file_ops.py): apply and undo, with their conflict checks."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from app.ai.file_ops import FileOp, FileOpError, apply, check_apply, check_undo, undo


def _op(op: str, path: str, original: str | None, proposed: str = "", new_path: str | None = None) -> FileOp:
    return FileOp(op=op, path=path, new_path=new_path, original=original, proposed=proposed)


def _applied(op: FileOp, root: Path) -> FileOp:
    check_apply(root, op)
    return FileOp(**{**op.__dict__, "applied": apply(root, op)})


def test_modify_apply_and_undo(tmp_path: Path):
    (tmp_path / "a.sql").write_text("old")
    op = _applied(_op("modify", "a.sql", "old", "new"), tmp_path)
    assert (tmp_path / "a.sql").read_text() == "new"
    check_undo(tmp_path, op)
    undo(tmp_path, op)
    assert (tmp_path / "a.sql").read_text() == "old"


def test_modify_refuses_a_changed_file(tmp_path: Path):
    (tmp_path / "a.sql").write_text("edited")
    with pytest.raises(FileOpError, match="changed since"):
        check_apply(tmp_path, _op("modify", "a.sql", "old", "new"))


def test_create_refuses_existing_and_undo_deletes(tmp_path: Path):
    (tmp_path / "x.sql").write_text("hi")
    with pytest.raises(FileOpError, match="already exists"):
        check_apply(tmp_path, _op("create", "x.sql", None, "new"))
    op = _applied(_op("create", "sub/y.sql", None, "new"), tmp_path)
    assert (tmp_path / "sub" / "y.sql").read_text() == "new"
    undo(tmp_path, op)
    assert not (tmp_path / "sub" / "y.sql").exists()


def test_legacy_modify_without_original_is_a_create(tmp_path: Path):
    assert _op("modify", "n.yml", None, "x").kind == "create"


def test_delete_apply_and_undo(tmp_path: Path):
    (tmp_path / "d.sql").write_text("bye")
    op = _applied(_op("delete", "d.sql", "bye"), tmp_path)
    assert not (tmp_path / "d.sql").exists() and op.applied is None
    check_undo(tmp_path, op)
    undo(tmp_path, op)
    assert (tmp_path / "d.sql").read_text() == "bye"


def test_rename_apply_and_undo(tmp_path: Path):
    (tmp_path / "models").mkdir()
    (tmp_path / "models" / "a.sql").write_text("select 1")
    op = _applied(_op("rename", "models/a.sql", "select 1", "select 2", "models/b.sql"), tmp_path)
    assert not (tmp_path / "models" / "a.sql").exists()
    assert (tmp_path / "models" / "b.sql").read_text() == "select 2"
    undo(tmp_path, op)
    assert (tmp_path / "models" / "a.sql").read_text() == "select 1"
    assert not (tmp_path / "models" / "b.sql").exists()


def test_rename_refuses_an_existing_target(tmp_path: Path):
    (tmp_path / "a.sql").write_text("1")
    (tmp_path / "b.sql").write_text("2")
    with pytest.raises(FileOpError, match="b.sql already exists"):
        check_apply(tmp_path, _op("rename", "a.sql", "1", "1", "b.sql"))


def test_undo_refuses_when_edited_since(tmp_path: Path):
    (tmp_path / "a.sql").write_text("old")
    op = _applied(_op("modify", "a.sql", "old", "new"), tmp_path)
    (tmp_path / "a.sql").write_text("newer")
    with pytest.raises(FileOpError, match="changed since it was applied"):
        check_undo(tmp_path, op)


def test_paths_must_stay_in_the_project(tmp_path: Path):
    with pytest.raises(FileOpError, match="outside the project"):
        check_apply(tmp_path, _op("create", "../escape.sql", None, "x"))


def test_of_reads_a_row():
    row = SimpleNamespace(op=None, path="a", new_path=None, original_text=None, proposed_text="x", applied_text=None)
    assert FileOp.of(row).kind == "create"
