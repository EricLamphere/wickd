"""Change the dbt venv's dbt-core version on the user's say-so (the MetricFlow version dialog).

plan():   `pip install --dry-run --report -` for dbt-core==<v> plus the installed adapters
          (unpinned, so pip picks matching ones) and, for the `mf` CLI, dbt-metricflow.
          Returns the package diff or pip's resolution error, plus requirement pins
          that would undo the change on the next global setup / init.
apply():  rewrites those pins if asked, then installs through the global-setup stream.
verify(): after the install, `dbt --version`, `dbt parse` and the compatibility check.

One dbt venv serves every project, so callers guard against in-flight work first.
"""

import asyncio
import json
from dataclasses import asdict, dataclass
from pathlib import Path

from packaging.version import InvalidVersion, Version
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dbt.venv import existing_bin
from app.logging_setup import get_logger
from app.semantic.pins import find_pins, rewrite_pins, would_undo

log = get_logger(__name__)

DRY_RUN_TIMEOUT_S = 120.0
# dbt packages that come with dbt-core rather than being adapters the user chose.
_CORE_PACKAGES = {
    "dbt-core", "dbt-adapters", "dbt-common", "dbt-extractor", "dbt-semantic-interfaces",
    "dbt-protos", "dbt-metricflow", "dbt-protos-python", "dbt-artifacts-parser",
}


class DbtChangeError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class PackageChange:
    name: str
    before: str | None
    after: str
    change: str  # upgrade | downgrade | install


@dataclass(frozen=True)
class PinRef:
    source: str  # global | project
    path: str
    line: int
    text: str
    spec: str
    exact: bool


def _norm(name: str) -> str:
    return name.lower().replace("_", "-").replace(".", "-")


def adapter_packages(installed: dict[str, str]) -> list[str]:
    """Adapter packages (dbt-snowflake, dbt-duckdb …) among the installed ones."""
    return sorted(n for n in installed if n.startswith("dbt-") and n not in _CORE_PACKAGES)


def install_args(version: str, adapters: list[str], *, want_cli: bool) -> list[str]:
    return [f"dbt-core=={version}", *adapters, *(["dbt-metricflow"] if want_cli else [])]


def diff_report(report: dict, installed: dict[str, str]) -> list[PackageChange]:
    """Package changes from a `pip install --report` document."""
    changes = []
    for item in report.get("install") or []:
        meta = item.get("metadata") or {}
        name, after = _norm(str(meta.get("name") or "")), str(meta.get("version") or "")
        if not name or not after:
            continue
        before = installed.get(name)
        if before == after:
            continue
        try:
            kind = "install" if before is None else ("upgrade" if Version(after) > Version(before) else "downgrade")
        except InvalidVersion:
            kind = "upgrade"
        changes.append(PackageChange(name, before, after, kind))
    return sorted(changes, key=lambda c: (c.name != "dbt-core", c.name))


def resolution_error(stderr: str) -> str:
    lines = [line for line in stderr.strip().splitlines() if line.strip()]
    useful = [line for line in lines if "ERROR" in line or "conflict" in line.lower() or "requires" in line.lower()]
    return "\n".join((useful or lines)[-12:]) or "pip couldn't resolve this version."


async def _pip(*args: str, timeout: float = DRY_RUN_TIMEOUT_S) -> tuple[int, str, str]:
    python = existing_bin("python")
    if python is None:
        raise DbtChangeError("no_dbt_venv", "dbt's Python environment doesn't exist yet — run global setup first.")
    proc = await asyncio.create_subprocess_exec(
        str(python), "-m", "pip", *args, "--disable-pip-version-check",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        raise DbtChangeError("timeout", f"pip took longer than {timeout:.0f}s (is the network reachable?)") from None
    return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")


async def installed_packages() -> dict[str, str]:
    code, out, err = await _pip("list", "--format", "json")
    if code != 0:
        raise DbtChangeError("pip_failed", resolution_error(err))
    try:
        rows = json.loads(out)
    except json.JSONDecodeError as exc:
        raise DbtChangeError("pip_failed", f"couldn't read pip list: {exc}") from exc
    return {_norm(r["name"]): str(r["version"]) for r in rows if isinstance(r, dict) and r.get("name")}


async def _requirement_files(session: AsyncSession, project_id: int, project_path: Path) -> list[tuple[str, Path]]:
    from app.api.init import _get_global_requirements_path, _resolve_requirements_path
    from app.db.models import ProjectEnvVar

    files: list[tuple[str, Path]] = []
    global_path = await _get_global_requirements_path(session)
    if global_path:
        files.append(("global", Path(global_path).expanduser()))
    row = (await session.execute(
        select(ProjectEnvVar).where(ProjectEnvVar.project_id == project_id, ProjectEnvVar.key == "REQUIREMENTS_PATH")
    )).scalar_one_or_none()
    if row is not None and row.value.strip():
        files.append(("project", _resolve_requirements_path(row.value, project_path)))
    return files


async def undoing_pins(session: AsyncSession, project_id: int, project_path: Path, version: str) -> list[PinRef]:
    refs = []
    for source, path in await _requirement_files(session, project_id, project_path):
        try:
            text = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
        except OSError:
            continue
        for pin in find_pins(text):
            if would_undo(pin, version):
                refs.append(PinRef(source, str(path), pin.line, pin.text.strip(), pin.spec, pin.exact))
    return refs


async def plan(session: AsyncSession, project_id: int, project_path: Path, version: str, *, want_cli: bool) -> dict:
    installed = await installed_packages()
    adapters = adapter_packages(installed)
    args = install_args(version, adapters, want_cli=want_cli)
    code, out, err = await _pip("install", "--dry-run", "--quiet", "--report", "-", *args)
    pins = await undoing_pins(session, project_id, project_path, version)
    base = {
        "version": version,
        "previous_version": installed.get("dbt-core"),
        "install": args,
        "pins": [asdict(p) for p in pins],
    }
    if code != 0:
        return {**base, "ok": False, "error": resolution_error(err), "changes": []}
    try:
        report = json.loads(out[out.index("{"):])
    except (ValueError, json.JSONDecodeError):
        return {**base, "ok": False, "error": "pip's dry-run report couldn't be read.", "changes": []}
    return {**base, "ok": True, "error": None, "changes": [asdict(c) for c in diff_report(report, installed)]}


async def update_pins(
    session: AsyncSession, project_id: int, project_path: Path, version: str, *, replace_ranges: bool
) -> list[dict]:
    """Rewrite the requirement pins that would undo `version`. Returns what changed."""
    updated = []
    for source, path in await _requirement_files(session, project_id, project_path):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        new_text, lines = rewrite_pins(text, version, replace_ranges=replace_ranges)
        if lines:
            await asyncio.to_thread(path.write_text, new_text, encoding="utf-8")
            updated.append({"source": source, "path": str(path), "lines": lines})
            log.info("metricflow_pins_updated", path=str(path), lines=lines, version=version)
    return updated
