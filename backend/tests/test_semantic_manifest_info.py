"""_read_manifest_info() while dbt is rewriting manifest.json (every `dbt show` does): a half-written
file is retried, then the last good read is used instead of reporting no semantic layer."""

import json
from pathlib import Path

import pytest

from app.semantic import service


def _manifest(adapter: str = "athena") -> bytes:
    return json.dumps({"metadata": {"adapter_type": adapter, "dbt_version": "1.10.0"}, "metrics": {"m": {}}}).encode()


@pytest.fixture(autouse=True)
def _clear_cache():
    service._info_cache.clear()
    yield
    service._info_cache.clear()


def test_half_written_manifest_falls_back_to_last_good_read(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(service, "UNREADABLE_RETRY_S", 0.0)
    (tmp_path / "manifest.json").write_bytes(_manifest())
    assert service._read_manifest_info(tmp_path).adapter_type == "athena"
    (tmp_path / "manifest.json").write_bytes(_manifest()[:40])  # dbt mid-write
    info = service._read_manifest_info(tmp_path)
    assert info.adapter_type == "athena" and info.counts["metrics"] == 1


def test_half_written_manifest_is_retried(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(service, "UNREADABLE_RETRY_S", 0.0)
    path = tmp_path / "manifest.json"
    path.write_bytes(_manifest()[:40])
    reads = {"n": 0}
    real = Path.read_bytes

    def flaky(self: Path) -> bytes:
        if self == path:
            reads["n"] += 1
            if reads["n"] == 2:  # dbt finished writing
                path.write_bytes(_manifest("snowflake"))
        return real(self)

    monkeypatch.setattr(Path, "read_bytes", flaky)
    assert service._read_manifest_info(tmp_path).adapter_type == "snowflake"


def test_unreadable_without_a_previous_read_reports_nothing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(service, "UNREADABLE_RETRY_S", 0.0)
    (tmp_path / "manifest.json").write_bytes(b"{not json")
    info = service._read_manifest_info(tmp_path)
    assert info.adapter_type is None and not any(info.counts.values())
