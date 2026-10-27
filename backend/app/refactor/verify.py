"""After a refactor is applied: run `dbt parse` and record the outcome on the proposal.

The result lands in result_json["verify"] = {status: running | ok | error, output?}
and is announced with `ai_proposal_updated`. A failure is only reported (with
Undo offered in the UI) — never reverted automatically.
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

from app.db.models import AiProposal
from app.dbt.runner import RunRequest, runner
from app.events.bus import Event, bus
from app.logging_setup import get_logger

log = get_logger(__name__)

PARSE_TIMEOUT_S = 300
OUTPUT_LINES = 40


async def _record(proposal_id: int, verify: dict) -> None:
    from app.db import engine as db_engine  # patched in tests, like other background writers

    async with db_engine.SessionLocal() as session:
        proposal = await session.get(AiProposal, proposal_id)
        if proposal is None:
            return
        result = json.loads(proposal.result_json or "{}")
        proposal.result_json = json.dumps({**result, "verify": verify})
        proposal.updated_at = datetime.now(UTC)
        await session.commit()
        await bus.publish(Event(
            topic=f"project:{proposal.project_id}",
            type="ai_proposal_updated",
            data={"proposal_id": proposal.id, "status": proposal.status, "unique_id": proposal.unique_id},
        ))


def _tail(text: str) -> str:
    lines = [line for line in text.splitlines() if line.strip()]
    return "\n".join(lines[-OUTPUT_LINES:])


async def _parse(project_id: int, project_path: Path) -> dict:
    from app.api.init import load_project_env
    from app.api.runs import _load_active_target

    target = await _load_active_target(project_id)
    req = RunRequest(
        project_id=project_id,
        project_path=project_path,
        command="parse",
        extra=("--target", target) if target else (),
        env=await load_project_env(project_id),
    )
    try:
        code, stdout, stderr = await asyncio.wait_for(runner.run(req), PARSE_TIMEOUT_S)
    except TimeoutError:
        return {"status": "error", "output": f"dbt parse didn't finish within {PARSE_TIMEOUT_S}s"}
    except OSError as exc:  # dbt missing from the venv
        return {"status": "error", "output": f"couldn't run dbt parse: {exc}"}
    output = _tail(stdout.decode("utf-8", "replace") + "\n" + stderr.decode("utf-8", "replace"))
    return {"status": "ok" if code == 0 else "error", "output": output}


async def verify_applied(proposal_id: int, project_id: int, project_path: Path) -> None:
    await _record(proposal_id, {"status": "running"})
    try:
        verify = await _parse(project_id, project_path)
    except Exception as exc:  # never leave the check stuck in `running`
        log.exception("refactor_verify_crashed", proposal_id=proposal_id)
        verify = {"status": "error", "output": f"unexpected error: {exc}"}
    log.info("refactor_verified", proposal_id=proposal_id, status=verify["status"])
    await _record(proposal_id, verify)


def start_verify(proposal_id: int, project_id: int, project_path: Path) -> None:
    asyncio.create_task(verify_applied(proposal_id, project_id, project_path))
