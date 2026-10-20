import asyncio

from httpx import ASGITransport, AsyncClient

from app.main import app
from app.projects import service


async def test_settings_answers_during_startup_scan_and_projects_wait_for_it() -> None:
    release = asyncio.Event()
    scan_finished = False

    async def slow_scan() -> None:
        nonlocal scan_finished
        await release.wait()
        scan_finished = True

    service.begin_startup_scan(slow_scan())
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            settings_resp = await asyncio.wait_for(client.get("/api/settings"), timeout=2.0)
            assert settings_resp.status_code == 200

            projects_req = asyncio.ensure_future(client.get("/api/projects"))
            await asyncio.sleep(0.05)
            assert not projects_req.done()  # blocked on the in-flight scan

            release.set()
            projects_resp = await asyncio.wait_for(projects_req, timeout=2.0)
            assert projects_resp.status_code == 200
            assert scan_finished
    finally:
        release.set()
        service._startup_scan = None
