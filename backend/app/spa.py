"""Serves the built frontend (frontend/dist) from the backend — the desktop app's UI.

Cache headers matter here: the desktop window loads the same origin
(http://127.0.0.1:<fixed port>) across app versions. Without Cache-Control,
WKWebView heuristically treats the old index.html as fresh (it has a
Last-Modified date) and keeps loading the previous version's bundles after an
update until the user reloads by hand. So index.html and other unhashed files
are always revalidated (a cheap 304 when unchanged), while Vite's
content-hashed /assets/* files are cached for good — a new build renames them.
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

REVALIDATE = "no-cache"
HASHED_ASSET_CACHE = "public, max-age=31536000, immutable"


class _HashedAssets(StaticFiles):
    """StaticFiles for Vite's content-hashed bundles, marked immutable."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = HASHED_ASSET_CACHE
        return response


def _file_in(root: Path, rel: str) -> Path | None:
    """`root / rel` if it is a file inside `root`, else None (no traversal)."""
    if not rel:
        return None
    candidate = (root / rel).resolve()
    if candidate.is_file() and candidate.is_relative_to(root):
        return candidate
    return None


def mount_spa(app: FastAPI, dist: Path) -> bool:
    """Mount /assets and the SPA fallback for `dist`. False when `dist` is missing."""
    if not dist.exists():
        return False
    root = dist.resolve()
    assets = root / "assets"
    if assets.exists():
        app.mount("/assets", _HashedAssets(directory=assets), name="assets")
    index_file = root / "index.html"
    headers = {"Cache-Control": REVALIDATE}

    @app.get("/{full_path:path}", include_in_schema=False, name="spa_fallback")
    async def spa_fallback(full_path: str) -> FileResponse:
        return FileResponse(_file_in(root, full_path) or index_file, headers=headers)

    return True
