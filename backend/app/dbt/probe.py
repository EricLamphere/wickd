import asyncio
import json
from dataclasses import dataclass
from pathlib import Path

from app.dbt.runner import RunRequest, runner
from app.dbt.show_parser import parse_show_json
from app.logging_setup import get_logger

log = get_logger(__name__)

PROBE_TIMEOUT_SECONDS = 30
# A batch reads metadata only, but each relation is still a warehouse round trip
BATCH_SECONDS_PER_MODEL = 2
# Prefixes the JSON line a batch probe prints; parse_batch_probe_output() looks for it
BATCH_MARKER = "WICKD_PROBE_COLUMNS:"
NO_COLUMNS_ERROR = "no columns returned — table may be empty or schema not materialized"
NOT_BUILT_ERROR = "not built in the warehouse yet"


@dataclass(frozen=True)
class ProbeResult:
    columns: tuple[str, ...]
    error: str | None  # set when the probe failed or returned no columns
    # Warehouse data types, same order as columns; empty when the probe can't read
    # them (probe_warehouse_columns' `dbt show` only returns names)
    types: tuple[str, ...] = ()
    # The relation doesn't exist (only the batch probe can tell; error is set too)
    not_built: bool = False


async def probe_warehouse_columns(
    project_id: int,
    project_path: Path,
    node_name: str,
    env: dict[str, str],
    target: str | None,
) -> ProbeResult:
    """Read a built node's actual column names via `dbt show --limit 1`."""
    inline_sql = f"select * from {{{{ ref('{node_name}') }}}}"
    target_args: tuple[str, ...] = ("--target", target) if target else ()
    req = RunRequest(
        project_id=project_id,
        project_path=project_path,
        command="show",
        extra=("--inline", inline_sql, "--limit", "1", "--output", "json") + target_args,
        env=env,
    )

    try:
        async with asyncio.timeout(PROBE_TIMEOUT_SECONDS):
            _, stdout_bytes, stderr_bytes = await runner.run(req)
    except TimeoutError:
        return ProbeResult(columns=(), error=f"probe timed out after {PROBE_TIMEOUT_SECONDS}s")
    except Exception as exc:  # noqa: BLE001 — error is logged/reported below
        return ProbeResult(columns=(), error=str(exc))

    cols, _ = parse_show_json(stdout_bytes.decode(errors="replace"))
    if not cols:
        # Some dbt versions write JSON output to stderr
        cols, _ = parse_show_json(stderr_bytes.decode(errors="replace"))
    if not cols:
        return ProbeResult(columns=(), error=NO_COLUMNS_ERROR)
    return ProbeResult(columns=tuple(cols), error=None)


def batch_timeout_seconds(count: int) -> int:
    return PROBE_TIMEOUT_SECONDS + BATCH_SECONDS_PER_MODEL * count


def build_batch_probe_sql(node_names: tuple[str, ...]) -> str:
    """Inline Jinja that prints every node's warehouse columns in one dbt invocation.

    ref() runs unguarded so dbt records each dependency at parse time (a ref the
    parser never saw fails at compile); the metadata lookups only run at execute.
    """
    return (
        f"{{%- set wickd_names = {json.dumps(list(node_names))} -%}}\n"
        "{%- set wickd_rels = {} -%}\n"
        "{%- for n in wickd_names -%}{%- do wickd_rels.update({n: ref(n)}) -%}{%- endfor -%}\n"
        "{% if execute %}\n"
        "{%- set wickd_cols = {} -%}\n"
        "{%- for n in wickd_names -%}\n"
        "{%- set rel = load_relation(wickd_rels[n]) -%}\n"
        "{%- if rel is none -%}{%- do wickd_cols.update({n: none}) -%}{%- else -%}\n"
        "{%- set pairs = [] -%}\n"
        "{%- for c in adapter.get_columns_in_relation(rel) -%}"
        "{%- do pairs.append([c.name, c.data_type]) -%}"
        "{%- endfor -%}\n"
        "{%- do wickd_cols.update({n: pairs}) -%}\n"
        "{%- endif -%}\n"
        "{%- endfor -%}\n"
        f"{{%- do print('{BATCH_MARKER}' ~ tojson(wickd_cols)) -%}}\n"
        "{% endif %}\n"
        "select 1 as wickd_probe"
    )


def parse_batch_probe_output(text: str) -> dict[str, tuple[tuple[str, str], ...] | None] | None:
    """(column, data type) pairs per node from a batch probe's output (None for a
    node whose relation doesn't exist), or None if it never printed them or
    printed something malformed."""
    for line in text.splitlines():
        _, sep, payload = line.partition(BATCH_MARKER)
        if not sep:
            continue
        try:
            data = json.loads(payload)
        except ValueError:
            return None
        if not isinstance(data, dict) or not all(
            cols is None or (isinstance(cols, list) and all(_is_pair(c) for c in cols))
            for cols in data.values()
        ):
            return None
        return {
            str(name): None if cols is None
            else tuple((str(col), str(dtype or "")) for col, dtype in cols)
            for name, cols in data.items()
        }
    return None


async def probe_many_warehouse_columns(
    project_id: int,
    project_path: Path,
    node_names: tuple[str, ...],
    env: dict[str, str],
    target: str | None,
) -> dict[str, ProbeResult] | None:
    """Read several built nodes' column names with one `dbt show` (adapter metadata, no table scan).

    Returns None when the batch as a whole failed (one bad relation fails the whole
    compile), so the caller can fall back to probe_warehouse_columns() per node.
    """
    if not node_names:
        return {}
    target_args: tuple[str, ...] = ("--target", target) if target else ()
    req = RunRequest(
        project_id=project_id,
        project_path=project_path,
        command="show",
        extra=(
            "--inline", build_batch_probe_sql(node_names),
            "--limit", "1", "--output", "json",
        ) + target_args,
        env=env,
    )

    try:
        async with asyncio.timeout(batch_timeout_seconds(len(node_names))):
            rc, stdout_bytes, stderr_bytes = await runner.run(req)
    except Exception as exc:  # noqa: BLE001 — error is logged/reported below
        log.warning("batch_probe_failed", project=project_id, count=len(node_names), error=repr(exc))
        return None
    if rc != 0:
        log.warning(
            "batch_probe_failed", project=project_id, count=len(node_names),
            rc=rc, stderr=stderr_bytes.decode(errors="replace")[-500:],
        )
        return None

    columns = parse_batch_probe_output(stdout_bytes.decode(errors="replace"))
    if columns is None:
        columns = parse_batch_probe_output(stderr_bytes.decode(errors="replace"))
    if columns is None or any(name not in columns for name in node_names):
        log.warning("batch_probe_unparsed", project=project_id, count=len(node_names))
        return None
    return {name: _probe_result(columns[name]) for name in node_names}


def _is_pair(value: object) -> bool:
    return isinstance(value, list) and len(value) == 2


def _probe_result(pairs: tuple[tuple[str, str], ...] | None) -> ProbeResult:
    if pairs is None:
        return ProbeResult(columns=(), error=NOT_BUILT_ERROR, not_built=True)
    return ProbeResult(
        columns=tuple(col for col, _ in pairs),
        error=None if pairs else NO_COLUMNS_ERROR,
        types=tuple(dtype for _, dtype in pairs),
    )
