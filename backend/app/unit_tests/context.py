"""What generating a unit test needs to know about a model (plan 19).

Pure helpers (manifest → inputs, file, name, format) plus the two dbt calls the
generator makes: compiling the model and running a read-only inline query.
"""

import asyncio
import json
import re
from pathlib import Path

from app.ai.errors import ProposalError
from app.dbt.runner import RunRequest, runner
from app.dbt.schema_yaml import RESOURCE_KEYS, DocumentTarget, SchemaYamlError, _resolve_schema_file
from app.dbt.show_parser import parse_show_json
from app.logging_setup import get_logger

log = get_logger(__name__)

MIN_DBT_VERSION = (1, 8)
COMPILE_TIMEOUT_S = 120
SHOW_TIMEOUT_S = 90
EXPECT_LIMIT = 200
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_SLUG = re.compile(r"[^a-z0-9]+")


class UnitTestError(ProposalError):
    """The unit test can't be generated (shown to the user as is)."""


def dbt_version_ok(version: str | None) -> bool:
    try:
        major, minor = (version or "").split(".")[:2]
        return (int(major), int(re.match(r"\d+", minor).group())) >= MIN_DBT_VERSION  # type: ignore[union-attr]
    except (ValueError, AttributeError):
        return True  # unknown: let dbt decide


def input_expression(parent: dict) -> str | None:
    if parent.get("resource_type") == "source":
        return f"source('{parent.get('source_name')}', '{parent.get('name')}')"
    if parent.get("resource_type") in ("model", "seed", "snapshot"):
        return f"ref('{parent.get('name')}')"
    return None


def model_inputs(manifest: dict, unique_id: str) -> list[dict]:
    """The model's refs and sources: [{key, relation, unique_id, ephemeral}] in depends_on order."""
    node = (manifest.get("nodes") or {}).get(unique_id) or {}
    parents = (node.get("depends_on") or {}).get("nodes") or []
    out: list[dict] = []
    for uid in parents:
        parent = (manifest.get("nodes") or {}).get(uid) or (manifest.get("sources") or {}).get(uid)
        if not isinstance(parent, dict):
            continue
        key = input_expression(parent)
        if key is None or any(i["key"] == key for i in out):
            continue
        ephemeral = (parent.get("config") or {}).get("materialized") == "ephemeral"
        out.append({"key": key, "relation": parent.get("relation_name"), "unique_id": uid, "ephemeral": ephemeral})
    return out


def check_model(manifest: dict, unique_id: str) -> dict:
    """The model's manifest node, or UnitTestError saying why it can't be unit tested."""
    node = (manifest.get("nodes") or {}).get(unique_id)
    if not isinstance(node, dict) or node.get("resource_type") != "model":
        raise UnitTestError("unit tests can only be generated for models")
    version = (manifest.get("metadata") or {}).get("dbt_version")
    if not dbt_version_ok(version):
        raise UnitTestError(f"unit tests need dbt 1.8 or later (this project runs {version})")
    if (node.get("config") or {}).get("materialized") == "ephemeral":
        raise UnitTestError("dbt can't unit test ephemeral models")
    inputs = model_inputs(manifest, unique_id)
    if not inputs:
        raise UnitTestError("the model has no refs or sources to mock")
    ephemeral = [i["key"] for i in inputs if i["ephemeral"]]
    if ephemeral:
        raise UnitTestError(
            f"{', '.join(ephemeral)} is ephemeral; unit tests need sql fixtures for those, which wickd can't draft yet"
        )
    return node


def unit_tests_for(manifest: dict, model_name: str) -> list[dict]:
    return [
        u for u in (manifest.get("unit_tests") or {}).values()
        if isinstance(u, dict) and u.get("model") == model_name
    ]


def fixture_format(manifest: dict) -> str:
    """csv when the project's unit tests mostly use it, else dict."""
    counts = {"dict": 0, "csv": 0}
    for test in (manifest.get("unit_tests") or {}).values():
        for given in (test or {}).get("given") or []:
            fmt = (given or {}).get("format") or "dict"
            if fmt in counts:
                counts[fmt] += 1
    return "csv" if counts["csv"] > counts["dict"] else "dict"


def unit_test_name(model: str, focus: str | None, existing: set[str]) -> str:
    part = _SLUG.sub("_", focus.split(":", 1)[-1].lower()).strip("_") if focus else "logic"
    base = f"{model}_{part or 'logic'}"
    name, n = base, 2
    while name in existing:
        name, n = f"{base}_{n}", n + 1
    return name


def target_file(project_path: Path, manifest: dict, node: dict) -> str:
    """Where a new unit test goes by default (relative path): next to the model's other
    unit tests, else in its schema YAML. (A file the user chose: files.resolve_file().)"""
    for test in unit_tests_for(manifest, node["name"]):
        if test.get("original_file_path"):
            return test["original_file_path"]
    target = DocumentTarget(
        name=node["name"],
        resource_type="model",
        original_file_path=node["original_file_path"],
        patch_path=node.get("patch_path"),
    )
    root = project_path.resolve()
    try:
        path = _resolve_schema_file(root, target, RESOURCE_KEYS["model"])
    except SchemaYamlError as exc:
        raise UnitTestError(str(exc)) from exc
    return path.relative_to(root).as_posix()


def parse_compiled(stdout: str) -> str | None:
    """The SQL from `dbt compile --output json` ({"node", "compiled"})."""
    clean = _ANSI.sub("", stdout)
    start = clean.find('{\n  "node"')
    candidates = [clean[start:]] if start >= 0 else []
    candidates += [line for line in clean.splitlines() if line.lstrip().startswith('{"node"')]
    decoder = json.JSONDecoder()
    for text in candidates:
        try:
            data, _ = decoder.raw_decode(text.strip())
        except ValueError:
            continue
        if isinstance(data, dict) and isinstance(data.get("compiled"), str):
            return data["compiled"]
    return None


def compiled_on_disk(project_path: Path, node: dict) -> str | None:
    """The model's SQL as dbt last compiled it (target/compiled/<package>/<path>), or None.
    The manifest often lacks `compiled_code`: commands that only parse rewrite it without."""
    from app.semantic.service import target_dir  # semantic imports a lot; keep it lazy

    package, path = node.get("package_name"), node.get("original_file_path")
    if not package or not path:
        return None
    base = (target_dir(project_path) / "compiled").resolve()
    file = (base / package / path).resolve()
    if not file.is_relative_to(base) or not file.is_file():
        return None
    try:
        return file.read_text(encoding="utf-8") or None
    except (OSError, UnicodeDecodeError):
        return None


def _target_args(env: dict[str, str]) -> tuple[str, ...]:
    target = env.get("DBT_TARGET")
    return ("--target", target) if target else ()


async def compile_model(
    project_id: int, project_path: Path, name: str, env: dict[str, str], full_refresh: bool
) -> str:
    """Compiled SQL (incremental models with --full-refresh: unit tests default to that branch)."""
    extra = ("--output", "json", "--no-use-colors") + (("--full-refresh",) if full_refresh else ())
    req = RunRequest(
        project_id=project_id, project_path=project_path, command="compile",
        select=name, extra=extra + _target_args(env), env=env,
    )
    try:
        async with asyncio.timeout(COMPILE_TIMEOUT_S):
            code, stdout, stderr = await runner.run(req)
    except (TimeoutError, OSError) as exc:
        raise UnitTestError(f"compiling {name} failed: {exc}") from exc
    sql = parse_compiled(stdout.decode(errors="replace"))
    if code != 0 or not sql:
        tail = (stderr or stdout).decode(errors="replace").strip().splitlines()[-3:]
        raise UnitTestError(f"compiling {name} failed: {' '.join(tail) or 'no SQL returned'}")
    return sql


def raw(sql: str) -> str:
    """Keep dbt's Jinja from touching already-compiled SQL."""
    return "{% raw %}" + sql.replace("{% endraw %}", "") + "{% endraw %}"


async def show_inline(
    project_id: int, project_path: Path, env: dict[str, str], sql: str, limit: int
) -> tuple[list[str], list[list]]:
    """Run a read-only query through `dbt show --inline`. Raises UnitTestError on failure."""
    req = RunRequest(
        project_id=project_id, project_path=project_path, command="show",
        extra=("--inline", raw(sql), "--limit", str(limit), "--output", "json", "--no-use-colors")
        + _target_args(env),
        env=env,
    )
    try:
        async with asyncio.timeout(SHOW_TIMEOUT_S):
            code, stdout, stderr = await runner.run(req)
    except (TimeoutError, OSError) as exc:
        raise UnitTestError(f"the query failed: {exc}") from exc
    text = stdout.decode(errors="replace")
    if code != 0:
        output = text + "\n" + stderr.decode(errors="replace")
        log.warning("unit_test_query_failed", error=output[-2000:], sql=sql[:4000])
        raise UnitTestError(f"the query failed: {query_error(output)}")
    return parse_show_json(text)


_SPECIFIC_ERROR = re.compile(r"\b[A-Z][A-Za-z ]*Error: \S")
_GENERIC_ERROR = re.compile(r"^(Runtime|Database|Compilation) Error( in .*)?$")


def query_error(output: str) -> str:
    """The useful part of dbt's error output: the warehouse's own message (e.g.
    `Parser Error: syntax error at or near "AS"`), not dbt's "Runtime Error" header."""
    lines = [_ANSI.sub("", ln).strip() for ln in output.splitlines()]
    lines = [ln for ln in lines if ln]
    specific = next((ln for ln in lines if _SPECIFIC_ERROR.search(ln)), None)
    if specific:
        return specific[:300]
    useful = [ln for ln in lines if not _GENERIC_ERROR.match(ln) and "Encountered an error" not in ln]
    return (useful[-1] if useful else "unknown error")[:300]
