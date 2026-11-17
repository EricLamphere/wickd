"""Version logic for dbt packages: `require-dbt-version` ranges, hub version ranges,
and picking the newest release a dbt-core accepts.

Pure; unit-tested in test_package_versions.py.
"""
import re
from collections.abc import Iterable, Sequence

from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version

# `>=1.3.0`, `< 2.0.0`, `1.3.0` (bare = exact), `=1.3.0`
_CLAUSE = re.compile(r"^\s*(>=|<=|==|!=|>|<|=)?\s*v?([0-9][0-9A-Za-z.+-]*)\s*$")
# a git revision that names a release tag, e.g. `1.1.1` or `v0.9.0`
_TAG = re.compile(r"^(v?)(\d+\.\d+(?:\.\d+)?(?:[-.]?[A-Za-z0-9.]+)?)$")


def parse_version(raw: str | None) -> Version | None:
    if not raw:
        return None
    try:
        return Version(str(raw).strip().lstrip("v"))
    except InvalidVersion:
        return None


def as_clauses(value: object) -> tuple[str, ...]:
    """A `require-dbt-version` / hub `version` value (string, list, or missing) as clauses."""
    if value is None or value == "":
        return ()
    if isinstance(value, str):
        parts = [p for p in re.split(r"\s*,\s*", value) if p.strip()]
        return tuple(p.strip() for p in parts)
    if isinstance(value, (list, tuple)):
        return tuple(str(v).strip() for v in value if v is not None and str(v).strip())
    return (str(value).strip(),)


def specifier(clauses: Iterable[str]) -> SpecifierSet | None:
    """dbt's range syntax as a SpecifierSet; None when a clause can't be read."""
    parts: list[str] = []
    for clause in clauses:
        m = _CLAUSE.match(clause)
        if not m:
            return None
        op = m.group(1) or "=="
        parts.append(f"{'==' if op == '=' else op}{m.group(2)}")
    try:
        return SpecifierSet(",".join(parts))
    except InvalidSpecifier:
        return None


def range_accepts(clauses: Sequence[str], version: str | None) -> bool | None:
    """Whether `version` satisfies a range; None when there's no range or no version to
    compare, or either can't be parsed (an empty range accepts everything: True)."""
    v = parse_version(version)
    if v is None:
        return None
    if not clauses:
        return True
    spec = specifier(clauses)
    if spec is None:
        return None
    return spec.contains(v, prereleases=True)


def is_exact(clauses: Sequence[str]) -> bool:
    """A single pinned version (`1.1.1`, `==1.1.1`) rather than a range."""
    if len(clauses) != 1:
        return False
    m = _CLAUSE.match(clauses[0])
    return bool(m) and (m.group(1) in (None, "=", "=="))


def tag_version(revision: str | None) -> tuple[str, str] | None:
    """(prefix, version) when a git revision is a release tag (`v1.2.0` → ("v", "1.2.0"))."""
    if not revision:
        return None
    m = _TAG.match(revision.strip())
    if not m or parse_version(m.group(2)) is None:
        return None
    return m.group(1), m.group(2)


def newest(versions: Iterable[str], *, stable: bool = True) -> str | None:
    best: tuple[Version, str] | None = None
    for raw in versions:
        v = parse_version(raw)
        if v is None or (stable and (v.is_prerelease or v.is_devrelease)):
            continue
        if best is None or v > best[0]:
            best = (v, raw)
    return best[1] if best else None


def latest_compatible(requires: dict[str, Sequence[str]], dbt_version: str | None) -> str | None:
    """The newest stable version whose `require_dbt_version` accepts `dbt_version`
    (`requires`: version → its range). None when nothing does or dbt's version is unknown."""
    if parse_version(dbt_version) is None:
        return None
    return newest(v for v, clauses in requires.items() if range_accepts(clauses, dbt_version) is True)


def is_newer(candidate: str | None, current: str | None) -> bool:
    a, b = parse_version(candidate), parse_version(current)
    return a is not None and b is not None and a > b
