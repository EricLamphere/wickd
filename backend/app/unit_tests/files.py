"""Which YAML file a generated unit test is written to (plan 19).

The user can keep the default (beside the model's other unit tests, else its schema
YAML — context.target_file()), pick any existing YAML file, or name a new one. A bare
name goes in the model's folder; `.yml` is added when there's no YAML suffix. The file
must be inside one of the project's model paths, or dbt would never read it.
"""

from pathlib import Path, PurePosixPath

import yaml

from app.dbt.schema_yaml import YAML_SUFFIXES, SchemaYamlError, _inside
from app.unit_tests.context import UnitTestError, target_file, unit_tests_for

DEFAULT_MODEL_PATHS = ("models",)
IGNORED_DIRS = frozenset({"target", "dbt_packages", "dbt_modules", "logs", ".git", "node_modules"})
MAX_LISTED_FILES = 500
MAX_NAME_LENGTH = 255


def model_paths(project_path: Path) -> tuple[str, ...]:
    """dbt_project.yml's `model-paths` (dbt's default `models`)."""
    try:
        data = yaml.safe_load((project_path / "dbt_project.yml").read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        data = None
    paths = data.get("model-paths") if isinstance(data, dict) else None
    found = tuple(p.strip("/") for p in paths if isinstance(p, str) and p.strip("/")) if isinstance(paths, list) else ()
    return found or DEFAULT_MODEL_PATHS


def resolve_file(project_path: Path, raw: str, model_file: str) -> str:
    """The project-relative YAML path for what the user typed, or UnitTestError."""
    text = raw.strip().replace("\\", "/")
    if not text:
        raise UnitTestError("enter a file name")
    if len(text) > MAX_NAME_LENGTH or text.startswith("/") or "\x00" in text:
        raise UnitTestError("enter a file path inside the project")
    path = PurePosixPath(text)
    if len(path.parts) == 1:  # a bare name: beside the model
        path = PurePosixPath(model_file).parent / path
    if path.suffix not in YAML_SUFFIXES:
        path = path.with_name(path.name + ".yml")
    root = project_path.resolve()
    try:
        resolved = _inside(root, str(path))
    except SchemaYamlError as exc:
        raise UnitTestError(str(exc)) from exc
    relative = resolved.relative_to(root).as_posix()
    if not any(relative == d or relative.startswith(f"{d}/") for d in model_paths(project_path)):
        dirs = ", ".join(f"{d}/" for d in model_paths(project_path))
        raise UnitTestError(f"{relative} isn't in the project's model paths ({dirs}), so dbt wouldn't read it")
    if resolved.exists() and not resolved.is_file():
        raise UnitTestError(f"{relative} is a folder")
    return relative


def project_yaml_files(project_path: Path) -> list[str]:
    """YAML files under the model paths (sorted, capped), build output and packages excluded."""
    root = project_path.resolve()
    found: list[str] = []
    for directory in model_paths(project_path):
        base = root / directory
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if path.suffix not in YAML_SUFFIXES or not path.is_file():
                continue
            relative = path.relative_to(root)
            if any(part in IGNORED_DIRS for part in relative.parts):
                continue
            found.append(relative.as_posix())
    return sorted(set(found))[:MAX_LISTED_FILES]


def file_options(project_path: Path, manifest: dict, node: dict) -> dict:
    """{default, existing, files, model_dir}: where a new unit test would go by default, the
    files already holding this model's unit tests, and the YAML files that can be picked."""
    existing = sorted({
        u["original_file_path"] for u in unit_tests_for(manifest, node["name"]) if u.get("original_file_path")
    })
    return {
        "default": target_file(project_path, manifest, node),
        "existing": existing,
        "files": project_yaml_files(project_path),
        "model_dir": str(PurePosixPath(node["original_file_path"]).parent),
    }
