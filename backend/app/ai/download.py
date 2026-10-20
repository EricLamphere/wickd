"""Download local model weights into <data_dir>/models with resume + checksum.

Files land as `<name>.part` while downloading and are only renamed to their
final name once the SHA-256 matches the catalog, so a file at the final path
is always a complete, verified model. Progress is published on the `global`
bus topic (model downloads aren't tied to a project).
"""

import asyncio
import hashlib
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.ai.catalog import ModelSpec
from app.config import settings
from app.events.bus import Event, bus
from app.logging_setup import get_logger

log = get_logger(__name__)

TOPIC = "global"
CHUNK_BYTES = 1024 * 1024
HASH_CHUNK_BYTES = 8 * 1024 * 1024
PROGRESS_INTERVAL_S = 0.5


class DownloadError(Exception):
    """The download failed or the file didn't match its checksum."""


@dataclass(frozen=True)
class DownloadStatus:
    downloaded: bool  # verified file present at the final path
    downloading: bool
    bytes_done: int
    bytes_total: int
    error: str | None


def models_dir() -> Path:
    return settings.data_dir / "models"


def model_path(spec: ModelSpec) -> Path:
    return models_dir() / spec.filename


def _part_path(spec: ModelSpec) -> Path:
    return models_dir() / f"{spec.filename}.part"


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(HASH_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


class ModelDownloader:
    """One download per model at a time; state lives in memory + on disk."""

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._transport = transport
        self._tasks: dict[str, asyncio.Task] = {}
        self._progress: dict[str, int] = {}
        self._errors: dict[str, str] = {}

    def status(self, spec: ModelSpec) -> DownloadStatus:
        # start() refuses to run once the final file exists, so it always wins
        if model_path(spec).exists():
            return DownloadStatus(True, False, spec.size_bytes, spec.size_bytes, None)
        done = self._progress.get(spec.id, _file_size(_part_path(spec)))
        return DownloadStatus(
            False, spec.id in self._tasks, done, spec.size_bytes, self._errors.get(spec.id)
        )

    def is_downloading(self, spec: ModelSpec) -> bool:
        return spec.id in self._tasks

    def start(self, spec: ModelSpec) -> None:
        if spec.id in self._tasks or model_path(spec).exists():
            return
        self._errors.pop(spec.id, None)
        task = asyncio.create_task(self._run(spec))
        self._tasks[spec.id] = task
        task.add_done_callback(lambda _t: self._tasks.pop(spec.id, None))

    async def cancel(self, spec: ModelSpec) -> None:
        task = self._tasks.get(spec.id)
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    def delete(self, spec: ModelSpec) -> None:
        for path in (model_path(spec), _part_path(spec)):
            path.unlink(missing_ok=True)
        self._progress.pop(spec.id, None)
        self._errors.pop(spec.id, None)

    async def _run(self, spec: ModelSpec) -> None:
        await self._publish(spec, "downloading")
        try:
            await self._download(spec)
            await self._publish(spec, "verifying")
            await asyncio.to_thread(self._verify_and_finish, spec)
        except asyncio.CancelledError:
            log.info("ai_model_download_cancelled", model=spec.id)
            await self._publish(spec, "cancelled")
            raise
        except (DownloadError, httpx.HTTPError, OSError) as exc:
            message = str(exc) or exc.__class__.__name__
            self._errors[spec.id] = message
            log.warning("ai_model_download_failed", model=spec.id, error=message)
            await self._publish(spec, "error", error=message)
            return
        finally:
            self._progress.pop(spec.id, None)
        log.info("ai_model_downloaded", model=spec.id)
        await self._publish(spec, "done")

    async def _download(self, spec: ModelSpec) -> None:
        part = _part_path(spec)
        part.parent.mkdir(parents=True, exist_ok=True)
        offset = _file_size(part)
        if offset >= spec.size_bytes:
            return  # fully downloaded earlier; only verification is left
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        timeout = httpx.Timeout(30.0, read=60.0)
        async with httpx.AsyncClient(
            transport=self._transport, follow_redirects=True, timeout=timeout
        ) as client, client.stream("GET", spec.url, headers=headers) as response:
            if response.status_code == 200:
                offset = 0  # server ignored the Range header — start over
            elif response.status_code != 206:
                raise DownloadError(f"download failed: HTTP {response.status_code}")
            await self._write_stream(spec, response, part, offset)

    async def _write_stream(
        self, spec: ModelSpec, response: httpx.Response, part: Path, offset: int
    ) -> None:
        done = offset
        last_publish = 0.0
        with part.open("ab" if offset else "wb") as f:
            async for chunk in response.aiter_bytes(CHUNK_BYTES):
                f.write(chunk)
                done += len(chunk)
                self._progress[spec.id] = done
                now = time.monotonic()
                if now - last_publish >= PROGRESS_INTERVAL_S:
                    last_publish = now
                    await self._publish(spec, "downloading")

    def _verify_and_finish(self, spec: ModelSpec) -> None:
        part = _part_path(spec)
        actual = _sha256(part)
        if actual != spec.sha256:
            part.unlink(missing_ok=True)  # corrupt — a retry must start from scratch
            raise DownloadError("downloaded file failed its checksum; please try again")
        part.rename(model_path(spec))

    async def _publish(self, spec: ModelSpec, state: str, error: str | None = None) -> None:
        status = self.status(spec)
        await bus.publish(Event(
            topic=TOPIC,
            type="ai_model_download",
            data={
                "model_id": spec.id,
                "state": state,
                "bytes_done": status.bytes_done,
                "bytes_total": status.bytes_total,
                "error": error,
            },
        ))


downloader = ModelDownloader()
