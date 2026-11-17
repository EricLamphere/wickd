"""Join a project's package files, its installed packages and Hub data into the rows the
Packages tab shows (requested / locked / installed / latest / compatibility).

Pure: callers pass the Hub packages they fetched. Unit-tested in test_packages.py.
"""
from dataclasses import dataclass, field
from pathlib import Path

from app.dbt.hub import HubPackage
from app.dbt.package_versions import is_exact, is_newer, range_accepts, tag_version
from app.dbt.packages import (
    InstalledPackage,
    PackageSpec,
    ProjectPackages,
    display_name,
    lock_entry,
    locked_version,
    match_installed,
)

EDITABLE_SOURCES = frozenset({"hub", "git", "private"})


@dataclass(frozen=True)
class PackageRow:
    key: str
    name: str
    source: str  # hub | git | local | tarball | private | unknown | dependency (transitive)
    direct: bool
    requested: str | None
    locked: str | None
    installed: str | None
    project_name: str | None  # the installed folder's dbt project name
    require_dbt_version: tuple[str, ...]
    compatible: bool | None  # its require-dbt-version accepts the installed dbt-core
    hub_name: str | None
    latest: str | None
    latest_compatible: str | None
    upgrade_to: str | None  # the value to write (a version, or a git tag) when newer is available
    latest_blocked: bool  # a newer release exists that this dbt-core can't run
    editable: bool
    notes: tuple[str, ...] = field(default=())


def hub_name_for(spec: PackageSpec) -> str | None:
    return spec.key if spec.source == "hub" else None


def installed_version(spec: PackageSpec, pkg: InstalledPackage | None, locked: str | None) -> str | None:
    """The release installed, when the package folder exists. A package's own dbt_project.yml
    `version:` is often never bumped (dbt_utils 1.4.1 says 0.1.0), so the lock file's version
    (hub) or the pinned tag (git) wins; dbt_project.yml is the fallback (no lock: dbt < 1.7)."""
    if pkg is None:
        return None
    if spec.source == "hub" and locked:
        return locked
    if spec.source in ("git", "private"):
        tag = tag_version(spec.requested[0] if spec.requested else None)
        if tag:
            return tag[1]
    return pkg.version


def _current(spec: PackageSpec, installed: str | None, locked: str | None) -> str | None:
    """The version a package is on, for "is newer available" comparisons."""
    if installed:
        return installed
    if spec.source in ("git", "private"):
        tag = tag_version(spec.requested[0] if spec.requested else None)
        return tag[1] if tag else None
    if locked:
        return locked
    return spec.requested[0] if is_exact(spec.requested) else None


def _requested_text(spec: PackageSpec) -> str | None:
    return ", ".join(spec.requested) if spec.requested else None


def _upgrade_value(spec: PackageSpec, version: str) -> str:
    if spec.source in ("git", "private"):
        tag = tag_version(spec.requested[0] if spec.requested else None)
        return f"{tag[0]}{version}" if tag else version
    return version


def _version_checks_apply(spec: PackageSpec) -> bool:
    """Hub packages, and git packages pinned to a release tag."""
    if spec.source == "hub":
        return True
    return spec.source in ("git", "private") and tag_version(spec.requested[0] if spec.requested else None) is not None


def _notes(spec: PackageSpec, installed: str | None, locked: str | None, lock_present: bool) -> tuple[str, ...]:
    notes: list[str] = []
    if installed is None:
        notes.append("Not installed: run dbt deps")
    if spec.source in ("git", "private") and not spec.requested:
        notes.append("Not pinned to a revision")
    elif spec.source in ("git", "private") and not _version_checks_apply(spec):
        notes.append("Pinned to a branch or commit: no version checks")
    if lock_present and locked is None and spec.source != "local":
        notes.append("Not in package-lock.yml: run dbt deps")
    return tuple(notes)


def build_row(
    spec: PackageSpec, packages: ProjectPackages, root: Path, dbt_version: str | None, hub: HubPackage | None,
) -> PackageRow:
    pkg = match_installed(spec, root, packages.installed)
    locked = locked_version(lock_entry(spec, packages.lock))
    installed = installed_version(spec, pkg, locked)
    checks = _version_checks_apply(spec)
    hub = hub if checks else None
    current = _current(spec, installed, locked)
    if pkg is not None:
        requires = pkg.require_dbt_version
    else:
        hv = hub.version(current) if hub else None
        requires = hv.require_dbt_version if hv else ()
    compatible = range_accepts(requires, dbt_version) if (pkg is not None or hub is not None) else None
    latest = hub.latest if hub else None
    best = hub.latest_compatible(dbt_version) if hub else None
    upgrade = best if best and is_newer(best, current) else None
    return PackageRow(
        key=spec.key,
        name=display_name(spec),
        source=spec.source,
        direct=True,
        requested=_requested_text(spec),
        locked=locked,
        installed=installed,
        project_name=pkg.name if pkg else None,
        require_dbt_version=requires,
        compatible=compatible,
        hub_name=hub.full_name if hub else hub_name_for(spec),
        latest=latest,
        latest_compatible=best,
        upgrade_to=_upgrade_value(spec, upgrade) if upgrade else None,
        latest_blocked=bool(latest and best != latest and is_newer(latest, current)),
        editable=spec.source in EDITABLE_SOURCES,
        notes=_notes(spec, installed, locked, packages.lock_present),
    )


def _transitive(packages: ProjectPackages, root: Path, dbt_version: str | None, matched: set[str]) -> list[PackageRow]:
    rows: list[PackageRow] = []
    for dir_name, pkg in packages.installed.items():
        if dir_name in matched:
            continue
        entry = next((e for e in packages.lock if e.name == pkg.name or (
            e.source == "hub" and e.key.rsplit("/", 1)[-1] == pkg.name)), None)
        rows.append(PackageRow(
            key=f"dependency:{dir_name}", name=entry.key if entry and entry.source == "hub" else pkg.name,
            source="dependency", direct=False, requested=None, locked=locked_version(entry),
            installed=locked_version(entry) if entry and entry.source == "hub" else pkg.version,
            project_name=pkg.name, require_dbt_version=pkg.require_dbt_version,
            compatible=range_accepts(pkg.require_dbt_version, dbt_version),
            hub_name=entry.key if entry and entry.source == "hub" else None, latest=None, latest_compatible=None,
            upgrade_to=None, latest_blocked=False, editable=False, notes=("Installed as a dependency of another package",),
        ))
    return rows


def build_rows(
    packages: ProjectPackages, root: Path, dbt_version: str | None, hub: dict[str, HubPackage | None],
) -> list[PackageRow]:
    """Direct packages in file order, then packages installed only as dependencies.
    `hub`: spec key → its Hub package (None / missing = unknown)."""
    rows = [build_row(spec, packages, root, dbt_version, hub.get(spec.key)) for spec in packages.specs]
    matched = {
        pkg.dir_name for spec in packages.specs if (pkg := match_installed(spec, root, packages.installed)) is not None
    }
    return rows + _transitive(packages, root, dbt_version, matched)


def incompatible(rows: list[PackageRow]) -> list[PackageRow]:
    return [r for r in rows if r.compatible is False]
