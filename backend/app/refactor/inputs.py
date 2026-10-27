"""What the refactor engine reads: the project's own SQL/YAML/Markdown files, and
plain-language descriptions of an operation (for titles and confirm cards). Pure."""

from pathlib import Path

from app.dbt.changes import IGNORED_DIRS, resource_dirs_from_project_yml

SUFFIXES = (".sql", ".py", ".yml", ".yaml", ".md")
MAX_FILE_BYTES = 1_000_000
MAX_FILES = 20_000
PROJECT_FILE = "dbt_project.yml"
OPS = ("rename_model", "rename_column", "extract_cte")


class TooManyFiles(Exception):
    """The project has more files than a refactor will read."""


def project_files(project_path: Path) -> dict[str, str]:
    """{posix path relative to the project: text} for files under the resource dirs
    (models, tests, macros, snapshots, analyses, seeds…) plus dbt_project.yml.
    Installed packages, target/ and oversized or undecodable files are skipped."""
    root = project_path.resolve()
    project_yml = root / PROJECT_FILE
    text = project_yml.read_text(encoding="utf-8") if project_yml.is_file() else None
    files: dict[str, str] = {}
    if text is not None:
        files[PROJECT_FILE] = text
    for folder in resource_dirs_from_project_yml(text):
        base = (root / folder).resolve()
        if not base.is_dir() or not base.is_relative_to(root):
            continue
        for path in sorted(base.rglob("*")):
            relative = path.relative_to(root).as_posix()
            if relative in files or not path.is_file() or path.suffix not in SUFFIXES:
                continue
            parts = relative.split("/")
            if parts[0] in IGNORED_DIRS or any(p.startswith(".") for p in parts) or path.stat().st_size > MAX_FILE_BYTES:
                continue
            if len(files) >= MAX_FILES:
                raise TooManyFiles(f"the project has more than {MAX_FILES} files to search")
            try:
                with path.open(encoding="utf-8", newline="") as f:
                    files[relative] = f.read()
            except (UnicodeDecodeError, OSError):
                continue
    return files


def node_name(manifest: dict, unique_id: str) -> str:
    return ((manifest.get("nodes") or {}).get(unique_id) or {}).get("name") or unique_id.split(".")[-1]


def downstream_count(manifest: dict, unique_id: str) -> int:
    return sum(
        1 for node in (manifest.get("nodes") or {}).values()
        if node.get("resource_type") in ("model", "snapshot")
        and unique_id in ((node.get("depends_on") or {}).get("nodes") or [])
    )


def describe(operation: dict, manifest: dict | None = None) -> str:
    """"Rename column `a` → `b` in `stg_x`", plus the downstream count when known."""
    name = operation.get("model") or (node_name(manifest, operation["unique_id"]) if manifest else "")
    new = operation["new_name"]
    if operation["op"] == "rename_model":
        text = f"Rename model `{name}` → `{new}`"
    elif operation["op"] == "rename_column":
        text = f"Rename column `{operation['column']}` → `{new}` in `{name}`"
    else:
        text = f"Extract CTE `{operation['cte']}` from `{name}` into model `{new}`"
    if manifest is not None and operation["op"] != "extract_cte":
        count = downstream_count(manifest, operation["unique_id"])
        if count:
            text += f" ({count} downstream model{'' if count == 1 else 's'})"
    return text
