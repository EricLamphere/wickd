"""A project's dbt Charts boards: the YAML / Markdown files under `charts/` (pure, no dct needed).

dct's rules (dbt_charts/core/project.py, 0.10): a board is a `.yml` / `.yaml` / `.md` /
`.markdown` file under `charts/` whose basename doesn't start with `_` (partials, `extends:`
layers) and isn't `meta.yml` (folder defaults). The board's URL path is its path without the
suffix (`charts/team/ops.yml` → `team/ops`), an `index.*` board standing for its folder.
`partials/` and `templates/` hold fragments, not boards.

A board that doesn't parse is still listed, with its error, so the UI can say why it can't be
shown. Cached by every file's (path, mtime, size), so an edit re-reads the folder.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import yaml

CHARTS_DIR = "charts"
YAML_SUFFIXES = (".yml", ".yaml")
MARKDOWN_SUFFIXES = (".md", ".markdown")
BOARD_SUFFIXES = YAML_SUFFIXES + MARKDOWN_SUFFIXES
META_FILENAMES = frozenset({"meta.yml", "meta.yaml"})
FRAGMENT_DIRS = frozenset({"partials", "templates"})
MAX_BOARDS = 500
MAX_BOARD_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class Board:
    id: str  # path under charts/ without the suffix, posix ("team/ops")
    path: str  # relative to the project root, posix ("charts/team/ops.yml")
    url_path: str  # what `dct serve` serves it at, without slashes ("team/ops", "team" for team/index.yml)
    title: str
    chart_count: int
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id, "path": self.path, "url_path": self.url_path, "title": self.title,
            "chart_count": self.chart_count, "error": self.error,
        }


_cache: dict[str, tuple[tuple, tuple[Board, ...]]] = {}


def charts_dir(project_path: Path) -> Path:
    return project_path / CHARTS_DIR


def is_board_file(relative: PurePosixPath) -> bool:
    """`relative` is under charts/ (e.g. `team/ops.yml`)."""
    name = relative.name
    if relative.suffix.lower() not in BOARD_SUFFIXES or name.startswith(("_", ".")) or name.lower() in META_FILENAMES:
        return False
    return not any(part in FRAGMENT_DIRS or part.startswith(".") for part in relative.parts[:-1])


def _board_files(root: Path) -> Iterator[Path]:
    for path in sorted(root.rglob("*")):
        if path.is_file() and is_board_file(PurePosixPath(path.relative_to(root).as_posix())):
            yield path


def _url_path(board_id: str) -> str:
    parts = PurePosixPath(board_id).parts
    if parts and parts[-1] == "index":
        parts = parts[:-1]
    return "/".join(parts)


def _title_from_stem(board_id: str) -> str:
    return PurePosixPath(board_id).name.replace("_", " ").replace("-", " ").strip().capitalize() or board_id


def _front_matter(text: str) -> dict | None:
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end < 0:
        return None
    data = yaml.safe_load(text[3:end])
    return data if isinstance(data, dict) else None


def _first_heading(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip() or None
    return None


def read_board(project_path: Path, file: Path) -> Board:
    """One board's summary; never raises (an unreadable board carries its error)."""
    root = charts_dir(project_path)
    relative = PurePosixPath(file.relative_to(root).as_posix())
    board_id = str(relative.with_suffix(""))
    path = f"{CHARTS_DIR}/{relative}"
    fallback = _title_from_stem(board_id)

    def failed(error: str) -> Board:
        return Board(board_id, path, _url_path(board_id), fallback, 0, error)

    try:
        if file.stat().st_size > MAX_BOARD_BYTES:
            return failed("the file is larger than 2 MB")
        text = file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return failed(f"can't read the file: {exc}")
    try:
        if relative.suffix.lower() in MARKDOWN_SUFFIXES:
            front = _front_matter(text) or {}
            title = front.get("title") if isinstance(front.get("title"), str) else None
            charts = front.get("charts") if isinstance(front.get("charts"), dict) else {}
            return Board(board_id, path, _url_path(board_id), title or _first_heading(text) or fallback, len(charts))
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        where = f" (line {mark.line + 1})" if mark is not None else ""
        return failed(f"invalid YAML{where}: {getattr(exc, 'problem', None) or exc}")
    if not isinstance(data, dict):
        return failed("a board is a YAML mapping (title, queries, charts, a layout)")
    title = data.get("title")
    charts = data.get("charts")
    return Board(
        board_id, path, _url_path(board_id), title.strip() if isinstance(title, str) and title.strip() else fallback,
        len(charts) if isinstance(charts, dict) else 0,
    )


def _fingerprint(files: list[Path]) -> tuple:
    out = []
    for f in files:
        try:
            stat = f.stat()
        except OSError:
            continue
        out.append((str(f), stat.st_mtime_ns, stat.st_size))
    return tuple(out)


def find_boards(project_path: Path) -> tuple[Board, ...]:
    """Every board under `<project>/charts/`, sorted by path; () when there's no charts folder."""
    root = charts_dir(project_path)
    if not root.is_dir():
        return ()
    files = list(_board_files(root))[:MAX_BOARDS]
    key = _fingerprint(files)
    hit = _cache.get(str(project_path))
    if hit is not None and hit[0] == key:
        return hit[1]
    boards = tuple(read_board(project_path, f) for f in files)
    _cache[str(project_path)] = (key, boards)
    return boards


def find_board(project_path: Path, board_id: str) -> Board | None:
    return next((b for b in find_boards(project_path) if b.id == board_id), None)


def has_boards(project_path: Path) -> bool:
    root = charts_dir(project_path)
    return root.is_dir() and next(_board_files(root), None) is not None
