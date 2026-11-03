"""Running `dct`: the sidecar built on first use (progress on the global `charts_env` event, like
`metricflow_env`), and the environment / arguments every dct command gets.

dct runs with the project's environment (global → profile → project env vars, DBT_TARGET), in
the project directory, so it finds dbt_project.yml, profiles.yml and target/manifest.json the
way dbt does. Usage stats off and the workspace-guard line (non-JSON on stderr) suppressed.
"""

import asyncio
from dataclasses import dataclass
from pathlib import Path

from app.charts import sidecar_env
from app.config import settings
from app.events.bus import Event, bus

ENV_TOPIC = "global"
ENV_EVENT = "charts_env"
GLOBAL_FLAGS = ("--no-send-anonymous-usage-stats", "--no-workspace-guard")
OUTPUT_ROOT = "charts"  # <data_dir>/charts/<project_id>/…

_install_lock = asyncio.Lock()


class ChartsUnavailable(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class DctContext:
    dct: Path
    env: dict[str, str]
    project_path: Path
    target: str | None
    adapter_type: str | None


async def _publish_env(state: str, phase: str, message: str) -> None:
    await bus.publish(Event(topic=ENV_TOPIC, type=ENV_EVENT, data={"state": state, "phase": phase, "message": message}))


async def ensure_dct(extra: str | None) -> Path:
    """The `dct` executable, building the sidecar (or adding an adapter extra) first if needed."""
    async with _install_lock:
        if sidecar_env.status(extra).state == "ready":
            return sidecar_env.dct_path()
        loop = asyncio.get_running_loop()

        def progress(phase: str, message: str) -> None:
            asyncio.run_coroutine_threadsafe(_publish_env("installing", phase, message), loop)

        try:
            path = await asyncio.to_thread(sidecar_env.ensure_sidecar, extra, progress)
        except sidecar_env.SidecarUnavailable as exc:
            await _publish_env("error", "error", str(exc))
            raise ChartsUnavailable("sidecar_failed", str(exc)) from exc
        await _publish_env("ready", "ready", f"dbt Charts {sidecar_env.DCT_VERSION} is ready")
        return path


def output_dir(project_id: int) -> Path:
    return settings.data_dir / OUTPUT_ROOT / str(project_id)


def command_env(project_env: dict[str, str]) -> dict[str, str]:
    return {**project_env, "DCT_NO_WORKSPACE_GUARD": "1", "DO_NOT_TRACK": "1", "PYTHONUNBUFFERED": "1"}


async def dct_context(project_id: int, project_path: Path) -> DctContext:
    """Everything needed to run dct for a project; ChartsUnavailable for an adapter dbt Charts can't read."""
    from app.api.init import load_project_env  # app.api imports the world; keep this module light

    env = command_env(await load_project_env(project_id))
    adapter = sidecar_env.adapter_type(project_path, env)
    if sidecar_env.unsupported_adapter(adapter):
        raise ChartsUnavailable(
            "unsupported_adapter", f"dbt Charts {sidecar_env.DCT_VERSION} can't connect to `{adapter}` warehouses."
        )
    dct = await ensure_dct(sidecar_env.extra_for(adapter))
    return DctContext(dct=dct, env=env, project_path=project_path, target=env.get("DBT_TARGET") or None, adapter_type=adapter)
