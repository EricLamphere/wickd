from pathlib import Path

import pytest

from app.files.ops import (
    FileConflictError,
    FileOpError,
    copy_name,
    copy_paths,
    is_text_file,
    move_paths,
    plan_move,
    upload_target,
)


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    (tmp_path / "models" / "staging").mkdir(parents=True)
    (tmp_path / "models" / "marts").mkdir()
    (tmp_path / "models" / "staging" / "stg_a.sql").write_text("select 1")
    (tmp_path / "models" / "staging" / "stg_b.sql").write_text("select 2")
    (tmp_path / "models" / "marts" / "orders.sql").write_text("select 3")
    return tmp_path


def test_move_file_into_folder(tree: Path) -> None:
    src = tree / "models" / "staging" / "stg_a.sql"
    moved = move_paths([src], tree / "models" / "marts")
    assert [m.dst for m in moved] == [tree / "models" / "marts" / "stg_a.sql"]
    assert not src.exists()
    assert (tree / "models" / "marts" / "stg_a.sql").read_text() == "select 1"


def test_move_folder_into_folder(tree: Path) -> None:
    move_paths([tree / "models" / "staging"], tree / "models" / "marts")
    assert (tree / "models" / "marts" / "staging" / "stg_b.sql").exists()


def test_move_into_same_parent_is_a_noop(tree: Path) -> None:
    assert move_paths([tree / "models" / "staging" / "stg_a.sql"], tree / "models" / "staging") == []


def test_move_folder_into_itself_is_refused(tree: Path) -> None:
    with pytest.raises(FileOpError, match="into itself"):
        plan_move([tree / "models"], tree / "models" / "staging")


def test_move_conflict_moves_nothing(tree: Path) -> None:
    (tree / "models" / "marts" / "stg_b.sql").write_text("existing")
    a = tree / "models" / "staging" / "stg_a.sql"
    b = tree / "models" / "staging" / "stg_b.sql"
    with pytest.raises(FileConflictError) as exc:
        move_paths([a, b], tree / "models" / "marts")
    assert exc.value.names == ["stg_b.sql"]
    assert a.exists() and b.exists()


def test_move_drops_paths_inside_a_moved_folder(tree: Path) -> None:
    staging = tree / "models" / "staging"
    moved = move_paths([staging, staging / "stg_a.sql"], tree / "models" / "marts")
    assert [m.src for m in moved] == [staging]


def test_move_missing_source(tree: Path) -> None:
    with pytest.raises(FileOpError, match="no longer exists"):
        plan_move([tree / "nope.sql"], tree / "models")


def test_move_to_a_file_is_refused(tree: Path) -> None:
    with pytest.raises(FileOpError, match="not a folder"):
        plan_move([tree / "models" / "marts"], tree / "models" / "staging" / "stg_a.sql")


@pytest.mark.parametrize(
    ("name", "taken", "is_dir", "expected"),
    [
        ("orders.sql", set(), False, "orders.sql"),
        ("orders.sql", {"orders.sql"}, False, "orders copy.sql"),
        ("orders.sql", {"orders.sql", "orders copy.sql"}, False, "orders copy 2.sql"),
        (".gitignore", {".gitignore"}, False, ".gitignore copy"),
        ("staging", {"staging"}, True, "staging copy"),
        ("v1.2", {"v1.2"}, True, "v1.2 copy"),
    ],
)
def test_copy_name(name: str, taken: set[str], is_dir: bool, expected: str) -> None:
    assert copy_name(name, taken, is_dir) == expected


def test_copy_in_place_duplicates(tree: Path) -> None:
    src = tree / "models" / "marts" / "orders.sql"
    done = copy_paths([src], tree / "models" / "marts")
    assert done[0].dst.name == "orders copy.sql"
    assert src.exists()


def test_copy_folder(tree: Path) -> None:
    copy_paths([tree / "models" / "staging"], tree / "models" / "marts")
    assert (tree / "models" / "marts" / "staging" / "stg_a.sql").exists()
    assert (tree / "models" / "staging" / "stg_a.sql").exists()


def test_copy_folder_into_itself_is_refused(tree: Path) -> None:
    with pytest.raises(FileOpError, match="into itself"):
        copy_paths([tree / "models"], tree / "models" / "marts")


def test_upload_target_keeps_folders(tree: Path) -> None:
    assert upload_target(tree, "seeds/raw/a.csv") == tree / "seeds" / "raw" / "a.csv"


@pytest.mark.parametrize("bad", ["", "../x.sql", "a/../../x", "/"])
def test_upload_target_rejects_traversal(tree: Path, bad: str) -> None:
    with pytest.raises(FileOpError):
        upload_target(tree, bad)


def test_is_text_file(tmp_path: Path) -> None:
    (tmp_path / "Makefile").write_text("all:\n\techo hi\n")
    (tmp_path / "db.duckdb").write_bytes(b"DUCK\x00\x01\x02")
    (tmp_path / "x.sql").write_bytes(b"\x00")
    assert is_text_file(tmp_path / "Makefile", {".sql"})
    assert not is_text_file(tmp_path / "db.duckdb", {".sql"})
    assert is_text_file(tmp_path / "x.sql", {".sql"})  # known extension wins
