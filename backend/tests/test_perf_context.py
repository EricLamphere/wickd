"""Ask Wicky why a node is slow: run timings + recent git changes to its files."""

import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.ai.perf_context import _node_files, parse_log, performance_info, recent_changes
from app.db.engine import get_session
from app.db.models import InvocationModelResult, RunInvocation
from app.main import app

UID = "model.proj.orders"


def _row(uid: str, inv_id: int, seconds: float | None, **kw) -> InvocationModelResult:
    return InvocationModelResult(
        invocation_id=inv_id, project_id=1, unique_id=uid, name=uid.split(".")[-1], kind="model",
        status="success", execution_time=seconds, **kw,
    )


def _inv(inv_id: int, day: int) -> RunInvocation:
    return RunInvocation(
        id=inv_id, project_id=1, command="build", target="dev", threads=4,
        started_at=datetime(2026, 10, day, tzinfo=UTC),
    )


def test_performance_info_newest_first_with_median_and_upstream():
    rows = [
        (_row(UID, 2, 120.0, rows_affected=10, adapter_response_json='{"code": "SUCCESS"}'), _inv(2, 26)),
        (_row(UID, 1, 12.0, adapter_response_json="not json"), _inv(1, 20)),
    ]
    parents = ["model.proj.stg_orders", "model.proj.never_ran"]
    info = performance_info(UID, rows, parents, [_row(parents[0], 1, 1.0), _row(parents[0], 2, 3.0)])
    assert info["latest_s"] == 120.0 and info["median_s"] == 66.0
    assert info["runs"][0] == {
        "ran_at": "2026-10-26T00:00:00+00:00", "command": "build", "target": "dev", "status": "success",
        "execution_time": 120.0, "rows_affected": 10, "bytes_processed": None,
        "adapter_response": {"code": "SUCCESS"}, "threads": 4,
    }
    assert info["runs"][1]["adapter_response"] is None
    assert info["upstream"] == [{"unique_id": parents[0], "median_s": 2.0}]


def test_performance_info_without_runs():
    info = performance_info(UID, [], [], [])
    assert info["runs"] == [] and info["latest_s"] is None and info["median_s"] is None


def test_node_files_sql_and_schema_yaml():
    manifest = {"nodes": {UID: {"original_file_path": "models/orders.sql", "patch_path": "proj://models/schema.yml"}}}
    assert _node_files(manifest, UID) == ["models/orders.sql", "models/schema.yml"]
    assert _node_files({"nodes": {}}, UID) == []


def test_parse_log_splits_commits():
    out = "\x1eabc\x1f2026-10-25\x1fA\x1fadd window\n\ndiff --git a b\n+x\n\x1edef\x1f2026-10-01\x1fB\x1finit\n"
    commits = parse_log(out)
    assert [c["sha"] for c in commits] == ["abc", "def"]
    assert commits[0]["subject"] == "add window" and "+x" in commits[0]["diff"]
    assert parse_log("") == []


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


async def test_recent_changes_reads_commits_and_uncommitted_edits(tmp_path: Path):
    repo = tmp_path / "repo"
    project = repo / "proj"
    (project / "models").mkdir(parents=True)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "T")
    sql = project / "models" / "orders.sql"
    sql.write_text("select 1\n")
    (project / "models" / "other.sql").write_text("select 2\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "init")
    sql.write_text("select 1, row_number() over () as rn\n")
    _git(repo, "commit", "-qam", "add window")
    sql.write_text("select 1 from big cross join big2\n")

    since = datetime.now(UTC) - timedelta(days=1)
    result = await recent_changes(1, project, ["models/orders.sql"], since)
    assert [c["subject"] for c in result["changes"]] == ["add window", "init"]
    assert "row_number()" in result["changes"][0]["diff"]
    assert "cross join" in result["uncommitted_diff"]


async def test_recent_changes_outside_a_repo(tmp_path: Path):
    result = await recent_changes(1, tmp_path, ["models/orders.sql"], datetime.now(UTC))
    assert result == {"changes": [], "uncommitted_diff": None}


async def test_node_performance_info_queries_runs_and_parents(tmp_path: Path):
    from app.ai.perf_context import node_performance_info
    from app.db.models import Project

    gen = app.dependency_overrides[get_session]()
    session = await gen.__anext__()
    try:
        project = Project(name="proj", path=str(tmp_path), platform="local")
        session.add(project)
        await session.flush()
        parent = "model.proj.stg_orders"
        for inv_id, day, own, up in ((1, 20, 12.0, 1.0), (2, 26, 120.0, 3.0)):
            inv = _inv(inv_id, day)
            inv.project_id = project.id
            session.add(inv)
            await session.flush()
            for uid, secs in ((UID, own), (parent, up)):
                row = _row(uid, inv_id, secs)
                row.project_id = project.id
                session.add(row)
        await session.commit()
        manifest = {"nodes": {UID: {"original_file_path": "models/orders.sql"}},
                    "parent_map": {UID: [parent, "test.proj.x"]}}
        info = await node_performance_info(session, project.id, tmp_path, manifest, UID)
    finally:
        await gen.aclose()
    assert [r["execution_time"] for r in info["runs"]] == [120.0, 12.0]
    assert info["upstream"] == [{"unique_id": parent, "median_s": 2.0}]
    assert info["changes"] == [] and info["uncommitted_diff"] is None  # tmp_path isn't a repo
