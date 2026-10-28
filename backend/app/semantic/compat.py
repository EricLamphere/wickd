"""Can MetricFlow run with this dbt-core × Python × YAML spec? Pure, unit-tested.

Two ways to run it (plan 07):
- the sidecar (always used): reads semantic manifests from dbt 1.7–1.12, both specs;
  the latest YAML spec needs dbt-core 1.12 to parse at all.
- the optional `mf` CLI in the dbt venv: needs a dbt-metricflow release whose
  dbt-core and Python ranges contain the installed ones (compat_data.py).
"""

from dataclasses import dataclass, field

from packaging.specifiers import SpecifierSet
from packaging.version import InvalidVersion, Version

from app.semantic.compat_data import DBT_CORE_LATEST_PATCHES, DBT_METRICFLOW_RELEASES

OLDEST_SUPPORTED = Version("1.7.0")
LATEST_SPEC_MIN = Version("1.12.0")
# Newest dbt-core minor the pinned engine was tested against (metricflow-bench).
NEWEST_TESTED_MINOR = (1, 12)


@dataclass(frozen=True)
class CompatResult:
    ok: bool
    reason_code: str | None = None  # too_old | latest_spec_needs_1_12 | no_cli_release | unknown_version
    reason: str | None = None
    warning: str | None = None
    cli_release: str | None = None  # dbt-metricflow version matching the installed dbt-core (want_cli)
    compatible_dbt_versions: tuple[str, ...] = field(default_factory=tuple)


def _version(raw: str | None) -> Version | None:
    try:
        return Version(raw) if raw else None
    except InvalidVersion:
        return None


def _minor(v: Version) -> tuple[int, int]:
    return (v.major, v.minor)


def _python_tuple(raw: str | None) -> tuple[int, int] | None:
    v = _version(raw)
    return _minor(v) if v else None


def cli_release_for(dbt_core: str, python: str | None) -> dict | None:
    """The newest dbt-metricflow release that installs alongside this dbt-core and Python."""
    core = _version(dbt_core)
    py = _python_tuple(python)
    if core is None:
        return None
    for release in reversed(DBT_METRICFLOW_RELEASES):
        if core not in SpecifierSet(release["dbt_core"]):
            continue
        if py is not None:
            low = _python_tuple(release["python_min"])
            high = _python_tuple(release["python_max_exclusive"])
            if (low and py < low) or (high and py >= high):
                continue
        return release
    return None


def _sidecar_problem(core: Version, uses_latest_spec: bool) -> tuple[str, str] | None:
    if core < OLDEST_SUPPORTED:
        reason = (f"wickd supports MetricFlow with dbt-core {OLDEST_SUPPORTED.base_version} or newer; "
                  f"{core} uses an older semantic manifest format.")
        return ("too_old", reason)
    if uses_latest_spec and core < LATEST_SPEC_MIN:
        reason = ("This project uses the latest semantic-layer YAML, which needs "
                  f"dbt-core {LATEST_SPEC_MIN.major}.{LATEST_SPEC_MIN.minor} or newer.")
        return ("latest_spec_needs_1_12", reason)
    return None


def _cli_problem(core: Version, python: str | None) -> tuple[str, str] | None:
    if cli_release_for(str(core), python) is not None:
        return None
    gaps = [r["dbt_core"] for r in DBT_METRICFLOW_RELEASES]
    detail = f" with Python {python}" if python and any(core in SpecifierSet(g) for g in gaps) else ""
    return ("no_cli_release", f"MetricFlow's CLI (dbt-metricflow) has no release for dbt-core {core}{detail}.")


def _ok_for(core: Version, python: str | None, uses_latest_spec: bool, want_cli: bool) -> bool:
    if _sidecar_problem(core, uses_latest_spec):
        return False
    return not (want_cli and _cli_problem(core, python))


def compatible_versions(python: str | None, *, uses_latest_spec: bool, want_cli: bool) -> tuple[str, ...]:
    """The latest patch of every dbt-core minor that would work, oldest first."""
    out = []
    for raw in DBT_CORE_LATEST_PATCHES.values():
        v = Version(raw)
        if _ok_for(v, python, uses_latest_spec, want_cli):
            out.append(raw)
    return tuple(sorted(out, key=Version))


def check(dbt_core: str | None, python: str | None, *, uses_latest_spec: bool, want_cli: bool = False) -> CompatResult:
    candidates = compatible_versions(python, uses_latest_spec=uses_latest_spec, want_cli=want_cli)
    core = _version(dbt_core)
    if core is None:
        return CompatResult(False, "unknown_version", "dbt-core isn't installed, or its version couldn't be read.",
                            compatible_dbt_versions=candidates)
    problem = _sidecar_problem(core, uses_latest_spec) or (want_cli and _cli_problem(core, python)) or None
    if problem:
        code, reason = problem
        return CompatResult(False, code, reason, compatible_dbt_versions=tuple(c for c in candidates if c != str(core)))
    warning = None
    if _minor(core) > NEWEST_TESTED_MINOR:
        warning = (f"dbt-core {core} is newer than wickd's MetricFlow was tested with "
                   f"({NEWEST_TESTED_MINOR[0]}.{NEWEST_TESTED_MINOR[1]}); some features may not load.")
    release = cli_release_for(str(core), python) if want_cli else None
    return CompatResult(True, warning=warning, cli_release=release["dbt_metricflow"] if release else None,
                        compatible_dbt_versions=candidates)


def recommend(current: str | None, candidates: tuple[str, ...] | list[str]) -> str | None:
    """Closest compatible version: same minor if there is one, else the nearest newer, else the nearest older."""
    if not candidates:
        return None
    versions = sorted(Version(c) for c in candidates)
    core = _version(current)
    if core is None:
        return str(versions[-1])
    same = [v for v in versions if _minor(v) == _minor(core)]
    if same:
        return str(same[-1])
    newer = [v for v in versions if v > core]
    return str(newer[0] if newer else versions[-1])

