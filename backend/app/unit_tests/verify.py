"""After a generated (or re-baselined) unit test is accepted, run it.

`dbt test --select <name>,test_type:unit` through the normal run path, so the result
lands in model_statuses / Run History and the side pane shows pass or the diff.
(dbt parses the new YAML as part of the test run.)
"""

from app.db.models import Project
from app.logging_setup import get_logger
from app.unit_tests.generation import KIND as GENERATED_KIND
from app.unit_tests.rebaseline import KIND as REBASELINE_KIND

log = get_logger(__name__)

UNIT_TEST_KINDS = frozenset({GENERATED_KIND, REBASELINE_KIND})


def selector(name: str) -> str:
    return f"{name},test_type:unit"


async def run_after_accept(project: Project, result: dict) -> None:
    from app.api.runs import RunRequestDto, _launch  # runs imports a lot; keep it lazy

    name = (result.get("unit_test") or {}).get("name")
    if not name:
        return
    try:
        await _launch(project, "test", RunRequestDto(select=selector(name)))
    except Exception as exc:  # noqa: BLE001 — accepting already succeeded; the run is a bonus
        log.warning("unit_test_verify_failed", project_id=project.id, name=name, error=str(exc))
