import os
import time
from pathlib import Path

import httpx
import pytest

from app.config import settings
from app.dbt import hub

UTILS = {
    "name": "dbt_utils", "namespace": "dbt-labs", "description": "macros",
    "versions": {
        "1.1.1": {"version": "1.1.1", "require_dbt_version": [">=1.3.0", "<2.0.0"], "published_at": "2023-01-01",
                  "_source": {"url": "https://github.com/dbt-labs/dbt-utils/tree/1.1.1/",
                              "readme": "https://raw.githubusercontent.com/dbt-labs/dbt-utils/1.1.1/README.md"}},
        "1.4.0b1": {"version": "1.4.0b1", "require_dbt_version": [">=1.3.0"]},
        "1.3.0": {"version": "1.3.0", "require_dbt_version": [">=1.9.0", "<2.0.0"],
                  "published_at": "1970-01-01T00:00:00", "_source": {}},
        "junk": {"version": "junk"},
    },
}


@pytest.fixture(autouse=True)
def hub_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(hub, "_locks", {})
    yield


def _transport(calls: list[str], *, fail: bool = False) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if fail:
            return httpx.Response(503)
        path = request.url.path
        if path.endswith("/index.json"):
            return httpx.Response(200, json=["dbt-labs/dbt_utils", "dbt-labs/codegen", "calogica/dbt_expectations"])
        if path.endswith("/dbt-labs/dbt_utils.json"):
            return httpx.Response(200, json=UTILS)
        if path.endswith("README.md"):
            return httpx.Response(200, text="# dbt utils")
        return httpx.Response(404)
    return httpx.MockTransport(handler)


def test_parse_package_sorts_and_picks_stable_latest():
    pkg = hub.parse_package(UTILS)
    assert [v.version for v in pkg.versions] == ["1.4.0b1", "1.3.0", "1.1.1"]
    assert pkg.latest == "1.3.0"
    assert pkg.repo_url == "https://github.com/dbt-labs/dbt-utils"
    assert pkg.version("1.3.0").published_at is None  # the epoch placeholder is dropped
    assert pkg.latest_compatible("1.8.0") == "1.1.1"
    assert pkg.latest_compatible("1.10.0") == "1.3.0"
    assert hub.parse_package({"name": "x"}) is None


def test_search_ranks_exact_then_prefix_then_substring():
    index = ["a/dbt_utils_extra", "dbt-labs/dbt_utils", "b/my_dbt_utils", "c/other"]
    assert hub.search(index, "dbt_utils") == ["dbt-labs/dbt_utils", "a/dbt_utils_extra", "b/my_dbt_utils"]
    assert hub.search(index, "") == sorted(index)
    assert hub.search(index, "zzz") == []


def test_git_candidates_and_same_repo():
    assert hub.hub_candidates_for_git("https://github.com/dbt-labs/dbt-utils.git") == [
        "dbt-labs/dbt_utils", "dbt-labs/dbt-utils", "dbt-labs/utils",
    ]
    assert hub.hub_candidates_for_git("https://gitlab.com/a/b.git") == []
    assert hub.same_repo("https://github.com/A/b/tree/1/", "git@github.com:a/b.git")


def test_readme_url_allowed():
    assert hub.readme_url_allowed("https://raw.githubusercontent.com/a/b/1/README.md")
    assert not hub.readme_url_allowed("http://raw.githubusercontent.com/a/b/1/README.md")
    assert not hub.readme_url_allowed("https://169.254.169.254/latest")
    assert not hub.readme_url_allowed(None)


async def test_fetch_caches_on_disk(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    calls: list[str] = []
    monkeypatch.setattr(hub, "transport", _transport(calls))
    assert await hub.fetch_index() == ["dbt-labs/dbt_utils", "dbt-labs/codegen", "calogica/dbt_expectations"]
    assert (await hub.fetch_package("dbt-labs/dbt_utils")).latest == "1.3.0"
    assert await hub.fetch_package("nope/nope") is None
    await hub.fetch_index()
    await hub.fetch_package("dbt-labs/dbt_utils")
    await hub.fetch_package("nope/nope")  # the 404 is cached too
    assert len(calls) == 3
    assert (tmp_path / "hub").is_dir()


async def test_fetch_failure_falls_back_to_stale_cache(monkeypatch: pytest.MonkeyPatch):
    calls: list[str] = []
    monkeypatch.setattr(hub, "transport", _transport(calls))
    await hub.fetch_index()
    old = time.time() - hub.CACHE_SECONDS - 10
    for f in hub.cache_dir().iterdir():
        os.utime(f, (old, old))
    monkeypatch.setattr(hub, "transport", _transport(calls, fail=True))
    assert await hub.fetch_index() is not None
    assert len(calls) == 2


async def test_fetch_failure_without_cache_is_none(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(hub, "transport", _transport([], fail=True))
    assert await hub.fetch_index() is None
    assert await hub.fetch_package("dbt-labs/dbt_utils") is None
    assert await hub.fetch_package("../etc/passwd") is None


async def test_fetch_for_git_and_readme(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(hub, "transport", _transport([]))
    pkg = await hub.fetch_for_git("https://github.com/dbt-labs/dbt-utils.git")
    assert pkg is not None and pkg.full_name == "dbt-labs/dbt_utils"
    assert await hub.fetch_for_git("https://github.com/someone/dbt-utils.git") is None
    assert await hub.fetch_readme("https://raw.githubusercontent.com/dbt-labs/dbt-utils/1.1.1/README.md") == "# dbt utils"
    assert await hub.fetch_readme("https://evil.example.com/README.md") is None
