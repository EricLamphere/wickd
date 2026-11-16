"""backend/scripts/updater_manifest.py — the desktop updater's latest.json (plan 32)."""
import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "updater_manifest", Path(__file__).resolve().parents[1] / "scripts" / "updater_manifest.py",
)
assert _SPEC and _SPEC.loader
um = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(um)

NOW = datetime(2026, 11, 20, 17, 0, tzinfo=UTC)


@pytest.fixture
def conf(tmp_path: Path) -> Path:
    path = tmp_path / "tauri.conf.json"
    path.write_text(json.dumps({"version": "1.4.0"}))
    return path


@pytest.fixture
def sig(tmp_path: Path) -> Path:
    path = tmp_path / "wickd.app.tar.gz.sig"
    path.write_text("c2lnbmF0dXJl\n")
    return path


def test_manifest_shape(conf: Path, sig: Path) -> None:
    manifest = um.manifest_for_release("1.4.0", sig, "- Faster DAG\n", conf=conf, now=NOW)
    assert manifest == {
        "version": "1.4.0",
        "notes": "- Faster DAG",
        "pub_date": "2026-11-20T17:00:00Z",
        "platforms": {
            "darwin-aarch64": {
                "signature": "c2lnbmF0dXJl",
                "url": "https://github.com/EricLamphere/wickd/releases/download/v1.4.0/wickd_1.4.0_aarch64.app.tar.gz",
            },
        },
    }


def test_refuses_a_version_that_doesnt_match_the_config(conf: Path, sig: Path) -> None:
    with pytest.raises(um.ManifestError, match="doesn't match"):
        um.manifest_for_release("1.4.1", sig, "", conf=conf, now=NOW)


def test_refuses_a_missing_or_empty_signature(conf: Path, tmp_path: Path) -> None:
    with pytest.raises(um.ManifestError, match="not found"):
        um.manifest_for_release("1.4.0", tmp_path / "nope.sig", "", conf=conf, now=NOW)
    empty = tmp_path / "empty.sig"
    empty.write_text("  \n")
    with pytest.raises(um.ManifestError, match="empty"):
        um.manifest_for_release("1.4.0", empty, "", conf=conf, now=NOW)


def test_real_config_version_is_readable() -> None:
    assert um.configured_version().count(".") == 2


def test_main_writes_the_file(sig: Path, tmp_path: Path) -> None:
    out = tmp_path / "latest.json"
    version = um.configured_version()
    assert um.main(["--version", version, "--sig", str(sig), "--out", str(out)]) == 0
    assert json.loads(out.read_text())["version"] == version
    assert um.main(["--version", "0.0.1", "--sig", str(sig), "--out", str(out)]) == 1
