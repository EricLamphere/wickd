"""dbt-core pins in requirements files that would undo a dbt-core change. Pure text in → text out.

A `dbt-core` line in the global requirements file or a project's REQUIREMENTS_PATH
reinstalls its version on the next global setup / init, so the version dialog offers
to rewrite it: `==` stays `==`; any other spec (a range, `~=`, none) becomes `==<v>`
only when the user asks (`replace_ranges`).
"""

import re
from dataclasses import dataclass

# name, optional [extras], the rest (specifier + markers / comment)
_LINE = re.compile(
    r"^(?P<indent>\s*)(?P<name>dbt[-_.]core)(?P<extras>\s*\[[^\]]*\])?(?P<spec>[^;#]*)(?P<tail>[;#].*)?$",
    re.IGNORECASE,
)
_EXACT = re.compile(r"^\s*===?\s*(?P<version>[\w.+!-]+)\s*$")


@dataclass(frozen=True)
class Pin:
    line: int  # 1-based
    text: str  # the whole line as written
    spec: str  # e.g. "==1.10.2", ">=1.9,<1.11", "" for unpinned
    exact: bool  # spec is ==X

    @property
    def pinned_version(self) -> str | None:
        m = _EXACT.match(self.spec)
        return m.group("version") if m else None


def find_pins(text: str) -> list[Pin]:
    pins = []
    for i, raw in enumerate(text.splitlines(), start=1):
        m = _LINE.match(raw)
        if not m or raw.lstrip().startswith("#"):
            continue
        spec = m.group("spec").strip()
        pins.append(Pin(line=i, text=raw, spec=spec, exact=bool(_EXACT.match(spec))))
    return pins


def would_undo(pin: Pin, version: str) -> bool:
    """True when installing from this line would not keep `version`."""
    from packaging.specifiers import InvalidSpecifier, SpecifierSet
    from packaging.version import InvalidVersion, Version

    if not pin.spec:
        return False  # unpinned: pip leaves the installed version alone
    try:
        return Version(version) not in SpecifierSet(pin.spec.replace(" ", ""))
    except (InvalidSpecifier, InvalidVersion):
        return True


def rewrite_pins(text: str, version: str, *, replace_ranges: bool) -> tuple[str, list[int]]:
    """`text` with each dbt-core pin that would undo `version` set to `==version`.

    Exact pins are always rewritten; ranges and other specs only with `replace_ranges`.
    Returns the new text and the 1-based lines changed. Extras, markers, comments and
    the file's line endings are kept.
    """
    lines = text.splitlines(keepends=True)
    changed = []
    for pin in find_pins(text):
        if not would_undo(pin, version) or (not pin.exact and not replace_ranges):
            continue
        raw = lines[pin.line - 1]
        ending = raw[len(raw.rstrip("\r\n")):]
        m = _LINE.match(raw.rstrip("\r\n"))
        assert m is not None
        tail = m.group("tail") or ""
        spacer = " " if tail else ""
        lines[pin.line - 1] = (
            f"{m.group('indent')}{m.group('name')}{m.group('extras') or ''}=={version}{spacer}{tail}{ending}"
        )
        changed.append(pin.line)
    return "".join(lines), changed
