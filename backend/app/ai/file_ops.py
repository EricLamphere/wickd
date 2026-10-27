"""Applying and undoing a proposal's file operations (modify / create / delete / rename).

Each operation is checked against disk before anything is written: a file is only
changed while it still holds the text the proposal was made against, and only
restored by Undo while it still holds what was applied. Callers check every file
of a proposal first and write only when all of them pass, so a proposal applies (or
undoes) as a unit.
"""

from dataclasses import dataclass
from pathlib import Path

OPS = ("modify", "create", "delete", "rename")


class FileOpError(Exception):
    """The file isn't in the state the operation needs; message names the path."""


@dataclass(frozen=True)
class FileOp:
    op: str
    path: str  # relative to the project root (posix)
    new_path: str | None
    original: str | None
    proposed: str
    applied: str | None = None

    @classmethod
    def of(cls, row: object) -> "FileOp":
        """From an ai_proposal_files row."""
        return cls(
            op=getattr(row, "op", None) or "modify",
            path=row.path,
            new_path=getattr(row, "new_path", None),
            original=row.original_text,
            proposed=row.proposed_text,
            applied=getattr(row, "applied_text", None),
        )

    @property
    def kind(self) -> str:
        # rows from before file operations existed: a modify without original text is a create
        return "create" if self.op == "modify" and self.original is None else self.op


def resolve(root: Path, relative: str) -> Path:
    base = root.resolve()
    path = (base / relative).resolve()
    if not path.is_relative_to(base):
        raise FileOpError(f"{relative} is outside the project")
    return path


def read(path: Path) -> str | None:
    if not path.exists():
        return None
    with path.open(encoding="utf-8", newline="") as f:
        return f.read()


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write(text)


def _same_file(root: Path, a: str, b: str) -> bool:
    """True when two paths name one file (a case-only rename on a case-insensitive disk)."""
    pa, pb = resolve(root, a), resolve(root, b)
    return pa.exists() and pb.exists() and pa.samefile(pb)


def check_apply(root: Path, op: FileOp) -> None:
    current = read(resolve(root, op.path))
    if op.kind == "create":
        if current is not None:
            raise FileOpError(f"{op.path} already exists")
        return
    if current != op.original:
        what = "was deleted" if current is None else "changed"
        raise FileOpError(f"{op.path} {what} since this was generated — regenerate to review it again")
    if op.kind == "rename":
        if not op.new_path:
            raise FileOpError(f"{op.path}: rename without a target")
        if read(resolve(root, op.new_path)) is not None and not _same_file(root, op.path, op.new_path):
            raise FileOpError(f"{op.new_path} already exists")


def apply(root: Path, op: FileOp) -> str | None:
    """Write the operation; returns the applied text (None for a delete)."""
    path = resolve(root, op.path)
    if op.kind == "delete":
        path.unlink()
        return None
    if op.kind == "rename":
        target = resolve(root, op.new_path or "")
        path.unlink()  # first, so a case-only rename on a case-insensitive disk lands on the new spelling
        write(target, op.proposed)
        return op.proposed
    write(path, op.proposed)
    return op.proposed


def check_undo(root: Path, op: FileOp) -> None:
    if op.kind == "delete":
        if read(resolve(root, op.path)) is not None:
            raise FileOpError(f"{op.path} was created again since the refactor")
        return
    where = op.new_path if op.kind == "rename" else op.path
    if read(resolve(root, where or "")) != op.applied:
        raise FileOpError(f"{where} changed since it was applied")
    if op.kind == "rename" and read(resolve(root, op.path)) is not None and not _same_file(root, op.path, where or ""):
        raise FileOpError(f"{op.path} exists again")


def undo(root: Path, op: FileOp) -> None:
    path = resolve(root, op.path)
    if op.kind == "create":
        path.unlink()
        return
    if op.kind == "rename":
        resolve(root, op.new_path or "").unlink()
    write(path, op.original or "")
