"""Write latest.json, the manifest the desktop app's updater reads (plan 32).

Run by `task release` after the build, from the repo root:

    backend/.venv/bin/python backend/scripts/updater_manifest.py \\
        --version 1.4.0 --sig src-tauri/target/release/bundle/macos/wickd.app.tar.gz.sig \\
        --notes-file release-notes.md --out src-tauri/target/release/bundle/latest.json

The app fetches it from https://github.com/EricLamphere/wickd/releases/latest/download/latest.json,
checks the signature against the public key in tauri.conf.json, and downloads the tarball
from the versioned release. The version must match tauri.conf.json, so a manifest can't
point at a different build than the one being released.
"""

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

REPO = "EricLamphere/wickd"
PLATFORM = "darwin-aarch64"
TAURI_CONF = Path(__file__).resolve().parents[2] / "src-tauri" / "tauri.conf.json"


class ManifestError(Exception):
    pass


def tarball_name(version: str) -> str:
    """The updater tarball's name as uploaded to the release."""
    return f"wickd_{version}_aarch64.app.tar.gz"


def tarball_url(version: str) -> str:
    return f"https://github.com/{REPO}/releases/download/v{version}/{tarball_name(version)}"


def configured_version(conf: Path = TAURI_CONF) -> str:
    return str(json.loads(conf.read_text())["version"])


def build_manifest(version: str, signature: str, notes: str, pub_date: datetime) -> dict[str, object]:
    return {
        "version": version,
        "notes": notes.strip(),
        "pub_date": pub_date.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": {
            PLATFORM: {"signature": signature.strip(), "url": tarball_url(version)},
        },
    }


def manifest_for_release(
    version: str, sig_path: Path, notes: str, *, conf: Path = TAURI_CONF, now: datetime | None = None,
) -> dict[str, object]:
    """Validate the inputs and build the manifest; ManifestError explains what's wrong."""
    expected = configured_version(conf)
    if version != expected:
        raise ManifestError(f"version {version} doesn't match tauri.conf.json ({expected})")
    if not sig_path.is_file():
        raise ManifestError(f"signature file not found: {sig_path} (was the build made with the signing key?)")
    signature = sig_path.read_text()
    if not signature.strip():
        raise ManifestError(f"signature file is empty: {sig_path}")
    return build_manifest(version, signature, notes, now or datetime.now(UTC))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--version", required=True)
    parser.add_argument("--sig", required=True, type=Path)
    parser.add_argument("--notes-file", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    notes = args.notes_file.read_text() if args.notes_file else ""
    try:
        manifest = manifest_for_release(args.version, args.sig, notes)
    except ManifestError as exc:
        print(f"updater_manifest: {exc}", file=sys.stderr)
        return 1
    args.out.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
