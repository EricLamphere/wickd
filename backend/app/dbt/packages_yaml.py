"""Edit `packages.yml` / `dependencies.yml`: add a package, change a version, remove one.

Like the schema YAML writers, the file is never re-serialised: ruamel.yaml only parses
it to find line positions, the change is spliced into the original text in its own
indentation, and the result is re-parsed and checked before it's offered. Comments and
everything else in the file stay as they were. Unit-tested in test_packages_yaml.py.
"""
import re
from dataclasses import dataclass, replace

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.error import YAMLError

from app.dbt.packages import VERSION_KEYS, PackagesError, PackageSpec, parse_entries

_INDENT = 2
_SAFE_PLAIN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._/+-]*$")
_TRAILING_COMMENT = re.compile(r"\s+#.*$")


@dataclass(frozen=True)
class PackageChange:
    op: str  # add | set_version | remove
    key: str  # hub name (add), else the entry's key
    version: str | None = None


def _rt_load(text: str, filename: str) -> CommentedMap | None:
    try:
        data = YAML(typ="rt").load(text) if text.strip() else None
    except YAMLError as exc:
        raise PackagesError(f"{filename} isn't valid YAML: {exc}") from exc
    if data is not None and not isinstance(data, CommentedMap):
        raise PackagesError(f"{filename} should be a mapping with a `packages:` list")
    return data


def render_scalar(value: str) -> str:
    """`value` as YAML that reads back as the same string (quoted when it would parse as a
    number, bool, … e.g. `1.10`)."""
    if _SAFE_PLAIN.match(value):
        try:
            if YAML(typ="safe", pure=True).load(f"v: {value}") == {"v": value}:
                return value
        except YAMLError:
            pass
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _is_blank_or_comment(line: str) -> bool:
    s = line.strip()
    return not s or s.startswith("#")


def _block_end(lines: list[str], start: int, column: int) -> int:
    """End (exclusive) of the block starting at `start`: following lines indented past
    `column`, without trailing blank/comment lines."""
    end = start + 1
    while end < len(lines) and (_is_blank_or_comment(lines[end]) or _indent(lines[end]) > column):
        end += 1
    while end > start + 1 and _is_blank_or_comment(lines[end - 1]):
        end -= 1
    return end


def _entry_key(entry: object) -> str | None:
    if not isinstance(entry, dict):
        return None
    for k in ("package", "git", "private", "local", "tarball"):
        if entry.get(k):
            return str(entry[k])
    return None


@dataclass(frozen=True)
class _Located:
    root: CommentedMap
    seq: CommentedSeq | None
    lines: list[str]


def _locate(text: str, filename: str) -> _Located:
    root = _rt_load(text, filename)
    if root is None:
        return _Located(CommentedMap(), None, text.splitlines(keepends=True))
    seq = root.get("packages")
    if seq is not None and not isinstance(seq, CommentedSeq):
        raise PackagesError(f"`packages:` in {filename} should be a list")
    if isinstance(seq, CommentedSeq) and seq.fa.flow_style():
        raise PackagesError(f"`packages:` in {filename} is written inline ([...]); wickd can only edit a block list")
    return _Located(root, seq, text.splitlines(keepends=True))


def _item_index(loc: _Located, key: str, filename: str) -> int:
    for i, entry in enumerate(loc.seq or []):
        if _entry_key(entry) == key:
            return i
    raise PackagesError(f"{key} isn't in {filename}")


def _dash_column(loc: _Located, i: int) -> int:
    line, col = loc.seq.lc.item(i)  # type: ignore[union-attr]
    text = loc.lines[line]
    dash = text.rfind("-", 0, col + 1)
    if dash < 0:
        raise PackagesError("couldn't locate the package entry")
    return dash


def _ensure_newline(lines: list[str]) -> list[str]:
    if lines and not lines[-1].endswith("\n"):
        return [*lines[:-1], lines[-1] + "\n"]
    return lines


def _entry_lines(dash_col: int, content_col: int, key: str, version: str) -> list[str]:
    dash = " " * dash_col + "-" + " " * (content_col - dash_col - 1)
    return [f"{dash}package: {render_scalar(key)}\n", f"{' ' * content_col}version: {render_scalar(version)}\n"]


def add_package(text: str | None, filename: str, key: str, version: str) -> str:
    """`text` (None = a new file) with a hub package appended to `packages:`."""
    if not text or not text.strip():
        return "packages:\n" + "".join(_entry_lines(_INDENT, _INDENT + 2, key, version))
    loc = _locate(text, filename)
    if any(_entry_key(e) == key for e in loc.seq or []):
        raise PackagesError(f"{key} is already in {filename}")
    lines = _ensure_newline(loc.lines)
    if not loc.seq:  # no `packages:` key, `packages:` (null) or `packages: []`
        if "packages" in loc.root:
            line = loc.root.lc.key("packages")[0]
            head = lines[line][: _indent(lines[line])]
            entry = _entry_lines(len(head) + _INDENT, len(head) + _INDENT + 2, key, version)
            return "".join([*lines[:line], f"{head}packages:\n", *entry, *lines[line + 1:]])
        entry = _entry_lines(_INDENT, _INDENT + 2, key, version)
        return "".join([*lines, "packages:\n", *entry])
    last = len(loc.seq) - 1
    dash_col = _dash_column(loc, last)
    content_col = loc.seq.lc.item(last)[1]
    end = _block_end(lines, loc.seq.lc.item(last)[0], dash_col)
    return "".join([*lines[:end], *_entry_lines(dash_col, content_col, key, version), *lines[end:]])


def set_version(text: str, filename: str, key: str, source: str, version: str) -> str:
    """The entry's `version:` (hub) / `revision:` (git, private) set to `version`."""
    field = VERSION_KEYS.get(source)
    if field is None:
        raise PackagesError(f"a {source} package has no version to change")
    loc = _locate(text, filename)
    i = _item_index(loc, key, filename)
    entry = loc.seq[i]  # type: ignore[index]
    lines = _ensure_newline(loc.lines)
    rendered = render_scalar(version)
    if field in entry:
        line, col = entry.lc.key(field)
        end = _block_end(lines, line, col)
        comment = _TRAILING_COMMENT.search(lines[line].rstrip("\n")) if end == line + 1 else None
        new = f"{lines[line][:col]}{field}: {rendered}{comment.group(0) if comment else ''}\n"
        return "".join([*lines[:line], new, *lines[end:]])
    anchor = next(k for k in ("package", "git", "private") if k in entry)
    line, col = entry.lc.key(anchor)
    end = _block_end(lines, line, col)
    return "".join([*lines[:end], f"{' ' * col}{field}: {rendered}\n", *lines[end:]])


def remove_package(text: str, filename: str, key: str) -> str:
    loc = _locate(text, filename)
    i = _item_index(loc, key, filename)
    lines = _ensure_newline(loc.lines)
    start = loc.seq.lc.item(i)[0]  # type: ignore[union-attr]
    end = _block_end(lines, start, _dash_column(loc, i))
    if len(loc.seq) == 1:  # keep a valid, empty list
        line = loc.root.lc.key("packages")[0]
        comment = _TRAILING_COMMENT.search(lines[line].rstrip("\n"))
        head = f"{lines[line][: _indent(lines[line])]}packages: []{comment.group(0) if comment else ''}\n"
        return "".join([*lines[:line], head, *lines[line + 1: start], *lines[end:]])
    return "".join([*lines[:start], *lines[end:]])


def _expected(specs: tuple[PackageSpec, ...], change: PackageChange) -> tuple[PackageSpec, ...]:
    if change.op == "add":
        return (*specs, PackageSpec("hub", change.key, (change.version or "",)))
    if change.op == "remove":
        return tuple(s for s in specs if s.key != change.key)
    return tuple(replace(s, requested=(change.version or "",)) if s.key == change.key else s for s in specs)


def _projection(specs: tuple[PackageSpec, ...]) -> list[tuple[str, str, tuple[str, ...]]]:
    return [(s.source, s.key, s.requested) for s in specs]


def apply_change(text: str | None, filename: str, change: PackageChange) -> str:
    """`text` with one change made, verified by re-parsing."""
    before = parse_entries(text, filename) if text else ()
    if change.op == "add":
        if not change.version:
            raise PackagesError("pick a version to add")
        out = add_package(text, filename, change.key, change.version)
    elif change.op == "remove":
        out = remove_package(text or "", filename, change.key)
    elif change.op == "set_version":
        if not change.version:
            raise PackagesError("pick a version")
        spec = next((s for s in before if s.key == change.key), None)
        if spec is None:
            raise PackagesError(f"{change.key} isn't in {filename}")
        out = set_version(text or "", filename, change.key, spec.source, change.version)
    else:
        raise PackagesError(f"unknown change {change.op!r}")
    after = parse_entries(out, filename)
    if _projection(after) != _projection(_expected(before, change)):
        raise PackagesError(f"editing {filename} didn't give the expected result; edit it by hand instead")
    return out


def apply_changes(text: str | None, filename: str, changes: list[PackageChange]) -> str:
    out = text
    for change in changes:
        out = apply_change(out, filename, change)
    return out or ""
