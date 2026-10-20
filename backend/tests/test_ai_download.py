import asyncio
import hashlib
from dataclasses import replace

import httpx
import pytest

from app.ai import download as download_module
from app.ai.catalog import MODELS
from app.ai.download import ModelDownloader, model_path
from app.config import settings
from app.events.bus import bus

PAYLOAD = b"weights" * 1000


@pytest.fixture
def spec(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    return replace(
        MODELS[0],
        url="https://models.test/m.gguf",
        sha256=hashlib.sha256(PAYLOAD).hexdigest(),
        size_bytes=len(PAYLOAD),
    )


def _server(requests: list[httpx.Request], *, honour_range: bool = True):
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        rng = request.headers.get("Range")
        if rng and honour_range:
            start = int(rng.removeprefix("bytes=").rstrip("-"))
            return httpx.Response(206, content=PAYLOAD[start:])
        return httpx.Response(200, content=PAYLOAD)

    return httpx.MockTransport(handler)


async def _run(d: ModelDownloader, spec) -> list[dict]:
    queue = await bus.subscribe(download_module.TOPIC)
    try:
        d.start(spec)
        task = d._tasks[spec.id]
        await asyncio.wait_for(asyncio.shield(task), timeout=5)
        events = []
        while not queue.empty():
            events.append(queue.get_nowait().data)
        return events
    finally:
        await bus.unsubscribe(download_module.TOPIC, queue)


async def test_downloads_and_verifies(spec):
    requests: list[httpx.Request] = []
    d = ModelDownloader(transport=_server(requests))
    events = await _run(d, spec)
    assert model_path(spec).read_bytes() == PAYLOAD
    assert d.status(spec).downloaded
    assert events[-1]["state"] == "done"
    assert "Range" not in requests[0].headers


async def test_resumes_partial_download(spec):
    part = model_path(spec).with_name(spec.filename + ".part")
    part.parent.mkdir(parents=True)
    part.write_bytes(PAYLOAD[:100])
    requests: list[httpx.Request] = []
    d = ModelDownloader(transport=_server(requests))
    await _run(d, spec)
    assert requests[0].headers["Range"] == "bytes=100-"
    assert model_path(spec).read_bytes() == PAYLOAD


async def test_restarts_when_server_ignores_range(spec):
    part = model_path(spec).with_name(spec.filename + ".part")
    part.parent.mkdir(parents=True)
    part.write_bytes(b"garbage")
    d = ModelDownloader(transport=_server([], honour_range=False))
    await _run(d, spec)
    assert model_path(spec).read_bytes() == PAYLOAD


async def test_checksum_mismatch_deletes_part_and_reports_error(spec):
    bad = replace(spec, sha256="0" * 64)
    d = ModelDownloader(transport=_server([]))
    events = await _run(d, bad)
    assert not model_path(bad).exists()
    assert not model_path(bad).with_name(bad.filename + ".part").exists()
    status = d.status(bad)
    assert not status.downloaded and "checksum" in (status.error or "")
    assert events[-1]["state"] == "error"


async def test_http_error_is_reported(spec):
    d = ModelDownloader(transport=httpx.MockTransport(lambda r: httpx.Response(404)))
    await _run(d, spec)
    assert "HTTP 404" in (d.status(spec).error or "")


async def test_delete_removes_files(spec):
    d = ModelDownloader(transport=_server([]))
    await _run(d, spec)
    d.delete(spec)
    assert not model_path(spec).exists()
    assert not d.status(spec).downloaded
