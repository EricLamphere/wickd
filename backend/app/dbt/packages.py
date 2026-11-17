"""Read a dbt project's packages: what `packages.yml` / `dependencies.yml` asks for, what
`package-lock.yml` resolved, and what `dbt deps` installed under `dbt_packages/`.

Pure apart from reading files under the project; unit-tested in test_packages.py.
Hub lookups (latest versions) live in app/dbt/hub.py; the API joins both.
"""
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

from app.dbt.package_versions import as_clauses

PACKAGE_FILES = ("packages.yml", "dependencies.yml")
LOCK_FILE = "package-lock.yml"
DEFAULT_INSTALL_PATH = "dbt_packages"
SOURCES = ("hub", "git", "local", "tarball", "private")
# the key whose value pins a package, per source
VERSION_KEYS = {"hub": "version", "git": "revision", "private": "revision"}

_CREDENTIALS = re.compile(r"(https?://)[^/@]+@")
_JINJA = re.compile(r"\{\{.*?\}\}")


class PackagesError(Exception):
    """A packages or lock file can't be parsed."""


@dataclass(frozen=True)
class PackageSpec:
    """One entry of packages.yml / dependencies.yml."""
    source: str  # hub | git | local | tarball | private | unknown
    key: str  # identity within the file: hub name, git URL, local path, …
    requested: tuple[str, ...]  # version clauses (hub) or the revision (git/private); () = unpinned
    name: str | None = None  # explicit `name:` (tarball, and dbt 1.8+ lock entries)
    subdirectory: str | None = None


@dataclass(frozen=True)
class InstalledPackage:
    dir_name: str
    name: str  # dbt_project.yml `name`
    version: str | None
    require_dbt_version: tuple[str, ...]


@dataclass(frozen=True)
class ProjectPackages:
    file: str | None  # which file lists them (relative to the project); None = neither exists
    specs: tuple[PackageSpec, ...]
    lock: tuple[PackageSpec, ...]  # resolved entries (direct + transitive); () without a lock file
    lock_present: bool
    installed: dict[str, InstalledPackage]  # by dir name
    install_path: str
    errors: tuple[str, ...] = field(default=())


def redact(url: str) -> str:
    """A URL safe to show or log: no `user:token@`, and Jinja (env_var secrets) elided."""
    return _JINJA.sub("{{ … }}", _CREDENTIALS.sub(r"\1***@", url))


def _yaml() -> YAML:
    return YAML(typ="safe", pure=True)


def load_yaml(text: str, filename: str) -> Any:
    try:
        return _yaml().load(text) if text.strip() else None
    except YAMLError as exc:
        raise PackagesError(f"{filename} isn't valid YAML: {exc}") from exc


def spec_from_entry(entry: Any) -> PackageSpec:
    """A packages.yml / lock entry (a mapping) as a PackageSpec."""
    if not isinstance(entry, dict):
        return PackageSpec(source="unknown", key=str(entry), requested=())
    name = str(entry["name"]) if entry.get("name") else None
    sub = str(entry["subdirectory"]) if entry.get("subdirectory") else None
    if entry.get("package"):
        return PackageSpec("hub", str(entry["package"]), as_clauses(entry.get("version")), name)
    for source in ("git", "private"):
        if entry.get(source):
            revision = entry.get("revision")
            return PackageSpec(source, str(entry[source]), (str(revision),) if revision else (), name, sub)
    if entry.get("local"):
        return PackageSpec("local", str(entry["local"]), (), name)
    if entry.get("tarball"):
        return PackageSpec("tarball", str(entry["tarball"]), (), name)
    return PackageSpec(source="unknown", key=str(entry), requested=(), name=name)


def parse_entries(text: str, filename: str) -> tuple[PackageSpec, ...]:
    """The `packages:` list of a packages / dependencies / lock file."""
    data = load_yaml(text, filename)
    if data is None:
        return ()
    if not isinstance(data, dict):
        raise PackagesError(f"{filename} should be a mapping with a `packages:` list")
    entries = data.get("packages") or []
    if not isinstance(entries, list):
        raise PackagesError(f"`packages:` in {filename} should be a list")
    return tuple(spec_from_entry(e) for e in entries)


def find_packages_file(root: Path) -> Path | None:
    """packages.yml, else dependencies.yml when it lists packages (dbt allows only one)."""
    packages = root / "packages.yml"
    if packages.is_file():
        return packages
    deps = root / "dependencies.yml"
    if deps.is_file():
        try:
            data = load_yaml(deps.read_text(encoding="utf-8"), deps.name)
        except (PackagesError, OSError):
            return deps
        if isinstance(data, dict) and data.get("packages"):
            return deps
    return None


def install_path(root: Path) -> str:
    """dbt_project.yml's `packages-install-path` (default dbt_packages)."""
    project_file = root / "dbt_project.yml"
    try:
        data = load_yaml(project_file.read_text(encoding="utf-8"), project_file.name)
    except (OSError, PackagesError):
        return DEFAULT_INSTALL_PATH
    value = data.get("packages-install-path") if isinstance(data, dict) else None
    return str(value) if isinstance(value, str) and value.strip() else DEFAULT_INSTALL_PATH


def read_project_file(folder: Path) -> InstalledPackage | None:
    """A package folder's dbt_project.yml name / version / require-dbt-version."""
    project_file = folder / "dbt_project.yml"
    try:
        data = load_yaml(project_file.read_text(encoding="utf-8"), project_file.name)
    except (OSError, PackagesError):
        return None
    if not isinstance(data, dict):
        return None
    version = data.get("version")
    return InstalledPackage(
        dir_name=folder.name,
        name=str(data.get("name") or folder.name),
        version=str(version) if version is not None else None,
        require_dbt_version=as_clauses(data.get("require-dbt-version")),
    )


def installed_packages(root: Path, path: str) -> dict[str, InstalledPackage]:
    folder = (root / path)
    if not folder.is_dir():
        return {}
    out: dict[str, InstalledPackage] = {}
    for child in sorted(folder.iterdir()):
        if child.is_dir():
            pkg = read_project_file(child)
            if pkg is not None:
                out[child.name] = pkg
    return out


def read_project_packages(root: Path) -> ProjectPackages:
    """Everything local about a project's packages; parse errors are collected, not raised."""
    errors: list[str] = []
    pkg_file = find_packages_file(root)
    specs: tuple[PackageSpec, ...] = ()
    if pkg_file is not None:
        try:
            specs = parse_entries(pkg_file.read_text(encoding="utf-8"), pkg_file.name)
        except (PackagesError, OSError) as exc:
            errors.append(str(exc))
    lock_file = root / LOCK_FILE
    lock: tuple[PackageSpec, ...] = ()
    if lock_file.is_file():
        try:
            lock = parse_entries(lock_file.read_text(encoding="utf-8"), LOCK_FILE)
        except (PackagesError, OSError) as exc:
            errors.append(str(exc))
    path = install_path(root)
    return ProjectPackages(
        file=pkg_file.name if pkg_file else None,
        specs=specs,
        lock=lock,
        lock_present=lock_file.is_file(),
        installed=installed_packages(root, path),
        install_path=path,
        errors=tuple(errors),
    )


def _repo_name(url: str) -> str:
    tail = url.rstrip("/").rsplit("/", 1)[-1].rsplit(":", 1)[-1]
    return tail.removesuffix(".git")


def candidate_dirs(spec: PackageSpec, root: Path) -> list[str]:
    """Folder names `dbt deps` may have installed this package under, most likely first."""
    out: list[str] = []
    if spec.name:
        out.append(spec.name)
    if spec.source == "hub":
        out.append(spec.key.rsplit("/", 1)[-1])
    elif spec.source in ("git", "private"):
        base = spec.subdirectory.rstrip("/").rsplit("/", 1)[-1] if spec.subdirectory else _repo_name(spec.key)
        out += [base, base.replace("-", "_")]
        for prefix in ("dbt-", "dbt_"):
            if base.startswith(prefix):
                out.append(base[len(prefix):].replace("-", "_"))
    elif spec.source == "local":
        local = read_project_file((root / spec.key).resolve())
        if local is not None:
            out.append(local.name)
        out.append(Path(spec.key).name)
    return list(dict.fromkeys(out))


def match_installed(spec: PackageSpec, root: Path, installed: dict[str, InstalledPackage]) -> InstalledPackage | None:
    by_name = {p.name: p for p in installed.values()}
    for candidate in candidate_dirs(spec, root):
        hit = installed.get(candidate) or by_name.get(candidate)
        if hit is not None:
            return hit
    return None


def lock_entry(spec: PackageSpec, lock: tuple[PackageSpec, ...]) -> PackageSpec | None:
    return next((e for e in lock if e.source == spec.source and e.key == spec.key), None)


def locked_version(entry: PackageSpec | None) -> str | None:
    if entry is None or not entry.requested:
        return None
    return entry.requested[0] if len(entry.requested) == 1 else ", ".join(entry.requested)


def display_name(spec: PackageSpec) -> str:
    if spec.source in ("git", "tarball"):
        return redact(spec.key)
    return spec.key
