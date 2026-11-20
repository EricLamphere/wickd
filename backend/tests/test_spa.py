"""The packaged app's UI must never be served stale after an update.

The desktop window loads the same origin (http://127.0.0.1:<fixed port>) across
versions, so without explicit Cache-Control WKWebView heuristically reuses the old
index.html (and with it the old bundles) until a manual reload.
"""

from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.spa import HASHED_ASSET_CACHE, REVALIDATE, mount_spa


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<html>app</html>")
    (root / "favicon.svg").write_text("<svg/>")
    (root / "assets" / "index-abc123.js").write_text("console.log(1)")
    return root


@pytest.fixture
async def spa_client(dist: Path):
    app = FastAPI()
    mount_spa(app, dist)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        yield c


@pytest.mark.parametrize("path", ["/", "/projects/3/models", "/index.html"])
async def test_index_is_always_revalidated(spa_client, path):
    res = await spa_client.get(path)
    assert res.status_code == 200
    assert res.text == "<html>app</html>"
    assert res.headers["cache-control"] == REVALIDATE


async def test_unhashed_root_files_are_revalidated(spa_client):
    res = await spa_client.get("/favicon.svg")
    assert res.status_code == 200
    assert res.headers["cache-control"] == REVALIDATE


async def test_hashed_assets_are_cached_for_good(spa_client):
    res = await spa_client.get("/assets/index-abc123.js")
    assert res.status_code == 200
    assert res.headers["cache-control"] == HASHED_ASSET_CACHE


async def test_missing_asset_is_404_not_index(spa_client):
    res = await spa_client.get("/assets/index-old999.js")
    assert res.status_code == 404


async def test_path_traversal_falls_back_to_index(spa_client, dist):
    (dist.parent / "secret.txt").write_text("nope")
    res = await spa_client.get("/..%2Fsecret.txt")
    assert "nope" not in res.text


def test_missing_dist_mounts_nothing(tmp_path):
    app = FastAPI()
    mount_spa(app, tmp_path / "nope")
    assert not [r for r in app.routes if getattr(r, "name", "") == "spa_fallback"]
