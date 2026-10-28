"""Which semantic-layer YAML spec a project uses, read from its YAML files (no parse needed).

- legacy: a top-level `semantic_models:` key in schema YAML
- latest (dbt 1.12+): `semantic_model:` under a `models:` entry, metrics under the model
A top-level `metrics:` key says nothing: the latest spec keeps it for metrics that
span models (ratio, derived).
Detected before parsing because dbt < 1.12 can't parse the latest spec at all (it
fails with "'Dimension' is undefined").
"""

from collections.abc import Iterable
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

from app.logging_setup import get_logger

log = get_logger(__name__)

MAX_FILES = 2000
LATEST_SPEC_PARSE_ERRORS = ("'Dimension' is undefined", "'Metric' is undefined", "'Entity' is undefined")


def spec_of(doc: object) -> set[str]:
    """{'legacy'} / {'latest'} / both / neither for one parsed YAML document."""
    found: set[str] = set()
    if not isinstance(doc, dict):
        return found
    if doc.get("semantic_models"):
        found.add("legacy")
    models = doc.get("models")
    if isinstance(models, list) and any(isinstance(m, dict) and "semantic_model" in m for m in models):
        found.add("latest")
    return found


def classify(found: set[str]) -> str:
    if found == {"legacy", "latest"}:
        return "mixed"
    return next(iter(found)) if found else "none"


def _yaml_files(project_path: Path, dirs: Iterable[str]) -> Iterable[Path]:
    count = 0
    for d in dirs:
        root = project_path / d
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if path.suffix in (".yml", ".yaml") and path.is_file():
                count += 1
                if count > MAX_FILES:
                    return
                yield path


def detect_spec(project_path: Path, model_dirs: Iterable[str] = ("models",)) -> str:
    """legacy | latest | mixed | none for the project's schema YAML."""
    yaml = YAML(typ="safe", pure=True)
    found: set[str] = set()
    for path in _yaml_files(project_path, model_dirs):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if "semantic_model" not in text:
            continue
        try:
            for doc in yaml.load_all(text):
                found |= spec_of(doc)
        except YAMLError as exc:
            log.debug("semantic_spec_yaml_unreadable", path=str(path), error=str(exc))
    return classify(found)


def is_latest_spec_parse_error(output: str) -> bool:
    return any(marker in output for marker in LATEST_SPEC_PARSE_ERRORS)
