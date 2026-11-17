"""Package manager (plan 23): a project's dbt packages with versions and dbt-core
compatibility, dbt Hub search, edits to packages.yml as Base proposals (kind `packages`),
and `dbt deps`.
"""
import asyncio
import json
import re
from dataclasses import asdict
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.ai_dtos import AiProposalDto, proposal_dto
from app.api.ai_proposals import _publish
from app.db.engine import get_session
from app.db.models import AiProposal, AiProposalFile, Project
from app.dbt import hub
from app.dbt.hub import HubPackage
from app.dbt.installed_version import installed_dbt_version
from app.dbt.package_rows import PackageRow, build_rows, incompatible
from app.dbt.package_versions import parse_version, range_accepts
from app.dbt.packages import (
    PackagesError,
    PackageSpec,
    ProjectPackages,
    find_packages_file,
    read_project_packages,
    redact,
)
from app.dbt.packages_yaml import PackageChange, apply_changes
from app.logging_setup import get_logger

router = APIRouter(prefix="/api/projects", tags=["packages"])
hub_router = APIRouter(prefix="/api/packages", tags=["packages"])
log = get_logger(__name__)

PACKAGES_KIND = "packages"
DEFAULT_FILE = "packages.yml"
# `dbt deps --upgrade` (re-resolve ranges and rewrite the lock) arrived with the lock file in 1.7
UPGRADE_FLAG_SINCE = parse_version("1.7.0")
_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")


# ── DTOs ─────────────────────────────────────────────────────────────────────


class PackageRowDto(BaseModel):
    key: str
    name: str
    source: str
    direct: bool
    requested: str | None
    locked: str | None
    installed: str | None
    project_name: str | None
    require_dbt_version: list[str]
    compatible: bool | None
    hub_name: str | None
    latest: str | None
    latest_compatible: str | None
    upgrade_to: str | None
    latest_blocked: bool
    editable: bool
    notes: list[str]


class LockEntryDto(BaseModel):
    key: str
    source: str
    version: str | None


class ProjectPackagesDto(BaseModel):
    file: str | None
    lock_present: bool
    install_path: str
    dbt_version: str | None
    hub_unreachable: bool  # some Hub lookups failed: latest versions show as unknown
    rows: list[PackageRowDto]
    lock: list[LockEntryDto]
    errors: list[str]


class ChangeDto(BaseModel):
    op: Literal["add", "set_version", "remove"]
    key: str = Field(min_length=1, max_length=512)
    version: str | None = Field(default=None, max_length=64)


class ProposeDto(BaseModel):
    changes: list[ChangeDto] = Field(min_length=1, max_length=100)


class DepsDto(BaseModel):
    upgrade: bool = False


class DepsResponseDto(BaseModel):
    accepted: bool
    command: str


class HubSearchDto(BaseModel):
    reachable: bool
    results: list[str]


class HubVersionDto(BaseModel):
    version: str
    require_dbt_version: list[str]
    compatible: bool | None
    published_at: str | None


class HubPackageDto(BaseModel):
    namespace: str
    name: str
    full_name: str
    description: str
    latest: str | None
    latest_compatible: str | None
    dbt_version: str | None
    repo_url: str | None
    versions: list[HubVersionDto]


class HubReadmeDto(BaseModel):
    text: str | None


class CompatPackageDto(BaseModel):
    name: str
    installed: str | None
    require_dbt_version: list[str]


class ProjectCompatDto(BaseModel):
    project_id: int
    name: str
    incompatible: list[CompatPackageDto]


class CompatDto(BaseModel):
    dbt_version: str | None
    projects: list[ProjectCompatDto]


# ── Helpers ──────────────────────────────────────────────────────────────────


async def _project(session: AsyncSession, project_id: int) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


async def _hub_for(spec: PackageSpec) -> HubPackage | None:
    if spec.source == "hub":
        return await hub.fetch_package(spec.key)
    if spec.source == "git" and spec.requested:
        return await hub.fetch_for_git(spec.key)
    return None



async def _hub_lookups(packages: ProjectPackages) -> tuple[dict[str, HubPackage | None], bool]:
    """Hub data per spec key, and whether any hub package's lookup failed."""
    specs = list(packages.specs)
    found = await asyncio.gather(*(_hub_for(s) for s in specs))
    lookups = dict(zip((s.key for s in specs), found, strict=True))
    unreachable = any(s.source == "hub" and lookups[s.key] is None for s in specs)
    return lookups, unreachable


def _row_dto(row: PackageRow) -> PackageRowDto:
    data = asdict(row)
    return PackageRowDto(**{**data, "require_dbt_version": list(row.require_dbt_version), "notes": list(row.notes)})


def _lock_dtos(packages: ProjectPackages) -> list[LockEntryDto]:
    return [
        LockEntryDto(key=redact(e.key), source=e.source, version=", ".join(e.requested) if e.requested else None)
        for e in packages.lock
    ]


async def local_rows(project: Project, dbt_version: str | None) -> tuple[ProjectPackages, list[PackageRow]]:
    """Rows from local files only (no Hub), for health and the home cards."""
    root = Path(project.path)
    packages = await asyncio.to_thread(read_project_packages, root)
    return packages, build_rows(packages, root, dbt_version, {})


def _validate_change(change: ChangeDto) -> PackageChange:
    if change.op == "add" and not hub.valid_name(change.key):
        raise HTTPException(status_code=400, detail=f"{change.key!r} isn't a dbt Hub package name (namespace/name)")
    if change.op in ("add", "set_version") and not (change.version and _VERSION.match(change.version)):
        raise HTTPException(status_code=400, detail=f"{change.version!r} isn't a version")
    return PackageChange(op=change.op, key=change.key, version=change.version)


def _title(changes: list[PackageChange]) -> str:
    if len(changes) > 1:
        return f"Update {len(changes)} packages"
    c = changes[0]
    name = redact(c.key)
    return {"add": f"Add {name} {c.version}", "remove": f"Remove {name}"}.get(c.op, f"Change {name} to {c.version}")


# ── Project packages ─────────────────────────────────────────────────────────


@router.get("/{project_id}/packages", response_model=ProjectPackagesDto)
async def get_packages(project_id: int, session: AsyncSession = Depends(get_session)) -> ProjectPackagesDto:
    project = await _project(session, project_id)
    root = Path(project.path)
    packages, dbt_version = await asyncio.gather(asyncio.to_thread(read_project_packages, root), installed_dbt_version())
    lookups, unreachable = await _hub_lookups(packages)
    rows = build_rows(packages, root, dbt_version, lookups)
    return ProjectPackagesDto(
        file=packages.file, lock_present=packages.lock_present, install_path=packages.install_path,
        dbt_version=dbt_version, hub_unreachable=unreachable, rows=[_row_dto(r) for r in rows],
        lock=_lock_dtos(packages), errors=list(packages.errors),
    )


@router.post("/{project_id}/packages/propose", response_model=AiProposalDto)
async def propose_packages(
    project_id: int, dto: ProposeDto, session: AsyncSession = Depends(get_session),
) -> AiProposalDto:
    """packages.yml (or dependencies.yml) with these changes, as a proposal to review:
    nothing is written until it's accepted; then `dbt deps` installs."""
    project = await _project(session, project_id)
    root = Path(project.path)
    changes = [_validate_change(c) for c in dto.changes]
    target = await asyncio.to_thread(find_packages_file, root) or root / DEFAULT_FILE
    original = target.read_text(encoding="utf-8") if target.is_file() else None
    try:
        proposed = apply_changes(original, target.name, changes)
    except PackagesError as exc:
        raise HTTPException(status_code=422, detail={"error": "yaml_edit_failed", "message": str(exc)}) from exc
    changed = proposed != (original or "")
    summary = {
        "path": target.name,
        "changes": [{"op": c.op, "key": redact(c.key), "version": c.version} for c in changes],
        "versions_changed": any(c.op == "set_version" for c in changes),
    }
    proposal = AiProposal(
        project_id=project_id, kind=PACKAGES_KIND, unique_id=None, title=_title(changes),
        result_json=json.dumps({"summary": summary}), status="ready" if changed else "empty",
        error_message=None if changed else f"{target.name} already has these versions.",
    )
    session.add(proposal)
    await session.flush()
    if changed:
        session.add(AiProposalFile(
            proposal_id=proposal.id, path=target.name, op="modify" if original is not None else "create",
            original_text=original, proposed_text=proposed,
        ))
    await session.commit()
    await session.refresh(proposal, attribute_names=["files"])
    await _publish(proposal)
    log.info("packages_proposed", project_id=project_id, changes=len(changes), path=target.name)
    return proposal_dto(proposal)


@router.post("/{project_id}/packages/deps", response_model=DepsResponseDto)
async def run_deps(project_id: int, dto: DepsDto, session: AsyncSession = Depends(get_session)) -> DepsResponseDto:
    """`dbt deps` (with `--upgrade` when asked and this dbt-core has a lock file) through the
    runner, so its output shows in the run log; run_finished (command `deps`) signals it's done."""
    from app.api.runs import _launch_custom
    from app.dbt.custom_command import parse_custom_command

    project = await _project(session, project_id)
    version = parse_version(await installed_dbt_version())
    upgrade = dto.upgrade and version is not None and UPGRADE_FLAG_SINCE is not None and version >= UPGRADE_FLAG_SINCE
    command = "deps --upgrade" if upgrade else "deps"
    _launch_custom(project, parse_custom_command(command))
    log.info("packages_deps_started", project_id=project_id, upgrade=upgrade)
    return DepsResponseDto(accepted=True, command=f"dbt {command}")


# ── dbt Hub ──────────────────────────────────────────────────────────────────


@hub_router.get("/hub/search", response_model=HubSearchDto)
async def hub_search(q: str = "") -> HubSearchDto:
    index = await hub.fetch_index()
    if index is None:
        return HubSearchDto(reachable=False, results=[])
    return HubSearchDto(reachable=True, results=hub.search(index, q[:100]))


async def _hub_package(namespace: str, name: str) -> HubPackage:
    full = f"{namespace}/{name}"
    if not hub.valid_name(full):
        raise HTTPException(status_code=400, detail="invalid package name")
    pkg = await hub.fetch_package(full)
    if pkg is None:
        raise HTTPException(status_code=404, detail=f"{full} isn't on dbt Hub, or the Hub can't be reached")
    return pkg


@hub_router.get("/hub/{namespace}/{name}", response_model=HubPackageDto)
async def hub_package(namespace: str, name: str) -> HubPackageDto:
    pkg = await _hub_package(namespace, name)
    dbt_version = await installed_dbt_version()
    return HubPackageDto(
        namespace=pkg.namespace, name=pkg.name, full_name=pkg.full_name, description=pkg.description,
        latest=pkg.latest, latest_compatible=pkg.latest_compatible(dbt_version), dbt_version=dbt_version,
        repo_url=pkg.repo_url,
        versions=[
            HubVersionDto(version=v.version, require_dbt_version=list(v.require_dbt_version),
                          compatible=range_accepts(v.require_dbt_version, dbt_version), published_at=v.published_at)
            for v in pkg.versions
        ],
    )


@hub_router.get("/hub/{namespace}/{name}/readme", response_model=HubReadmeDto)
async def hub_readme(namespace: str, name: str, version: str | None = None) -> HubReadmeDto:
    pkg = await _hub_package(namespace, name)
    hv = pkg.version(version or pkg.latest) or (pkg.versions[0] if pkg.versions else None)
    if hv is None or not hv.readme_url:
        return HubReadmeDto(text=None)
    return HubReadmeDto(text=await hub.fetch_readme(hv.readme_url))


# ── Compatibility across projects ────────────────────────────────────────────


@hub_router.get("/compat", response_model=CompatDto)
async def packages_compat(dbt_version: str | None = None, session: AsyncSession = Depends(get_session)) -> CompatDto:
    """Installed packages whose require-dbt-version rejects `dbt_version` (default: the
    installed dbt-core), per project; for the home cards and before changing dbt-core."""
    if dbt_version is not None and parse_version(dbt_version) is None:
        raise HTTPException(status_code=400, detail=f"{dbt_version!r} isn't a version")
    version = dbt_version or await installed_dbt_version()
    projects = (await session.execute(select(Project).where(Project.ignored.is_(False)))).scalars().all()
    out: list[ProjectCompatDto] = []
    for project in projects:
        _, rows = await local_rows(project, version)
        bad = incompatible(rows)
        if bad:
            out.append(ProjectCompatDto(project_id=project.id, name=project.name, incompatible=[
                CompatPackageDto(name=r.name, installed=r.installed, require_dbt_version=list(r.require_dbt_version))
                for r in bad
            ]))
    return CompatDto(dbt_version=version, projects=out)
