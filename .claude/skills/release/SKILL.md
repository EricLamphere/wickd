---
name: release
description: Cut a new wickd desktop release — bump the version everywhere it lives, then run `task release` to build the production app and publish the GitHub release. Use when the user asks to release, ship, or publish a new version of wickd.
argument-hint: "[patch|minor|major|X.Y.Z]  (default: patch)"
---

# Release wickd

Arguments: `$ARGUMENTS` — `patch` (default when empty), `minor`, `major`, or an explicit `X.Y.Z`.

Invoking this skill is the user's go-ahead to publish, including the one commit and push `task release` makes: the version bump in the six files below. That is the only exception to the user's no-commit rule. Never commit or push anything else, including with this skill's own git commands, and never force-push.

## 1. Preflight

Run these and stop with a clear message if any fail:

- `gh auth status` — must be logged in (the release is created with `gh`).
- `.env.signing` must exist at the repo root with `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` set (template: `.env.signing.example`). Check that the keys are non-empty without printing their values — never echo the password.
- `security find-identity -v -p codesigning` must list the `APPLE_SIGNING_IDENTITY` value (the Developer ID Application certificate is installed).
- Read the current version from `src-tauri/tauri.conf.json` (`"version"`). This is the source of truth.
- Compute the new version from the argument (semver: `patch` → X.Y.Z+1, `minor` → X.Y+1.0, `major` → X+1.0.0; an explicit version must be valid semver and greater than the current one).
- `gh release view v<new>` must fail (no existing release with that tag).
- `git branch --show-current` must be `main`, and after `git fetch origin main`, `HEAD` must equal `origin/main`. Otherwise stop and ask the user to push or pull: the release pushes `main`, and that push must publish only the release commit.
- `git status --short` — if there are uncommitted changes, list them for the user as a heads-up, but continue. They'd be in the build but not in the release commit or tag, so say that.
- Refresh the MetricFlow compatibility table: `cd backend && .venv/bin/python scripts/metricflow_compat.py` (PyPI metadata → `app/semantic/compat_data.py`). If it changed, run `.venv/bin/pytest tests/test_semantic_compat.py -q` and tell the user the diff (new dbt-core patches or dbt-metricflow lines) so they can commit it before releasing. Bumping the pinned engine (`ENGINE_VERSION` in `app/semantic/sidecar_env.py`) is a separate, deliberate change: rerun the metricflow-bench kit in wickd-pro first.

Tell the user in one line: `Releasing wickd <old> → <new>`.

## 2. Bump the version in every file

The version lives in exactly these places. Change only the wickd version field itself — never a dependency that happens to share the same version string.

| File | What to change |
|------|----------------|
| `src-tauri/tauri.conf.json` | top-level `"version"` |
| `src-tauri/Cargo.toml` | `version` under `[package]` |
| `src-tauri/Cargo.lock` | the `version` line directly under `name = "wickd"` in its `[[package]]` block (other crates can have the same version — don't touch them) |
| `frontend/package.json` | top-level `"version"` |
| `frontend/package-lock.json` | the root `"version"` (line ~3) and `packages[""].version` (line ~9) only |
| `backend/pyproject.toml` | `version` under `[project]` |

Use the Edit tool with enough surrounding context to make each match unique. For the two lockfiles, include the neighboring `name` line in `old_string`.

Then verify — every row should print the new version:

```bash
grep -m1 '"version"' src-tauri/tauri.conf.json
grep -m1 '^version' src-tauri/Cargo.toml
grep -A1 '^name = "wickd"$' src-tauri/Cargo.lock
grep -m1 '"version"' frontend/package.json
sed -n '1,10p' frontend/package-lock.json | grep '"version"'
grep -m1 '^version' backend/pyproject.toml
```

If any file doesn't show the new version, fix it before continuing.

## 3. Build and publish

Run `task release` from the repo root **in the background** (`run_in_background: true`) — the production build takes several minutes, well past the foreground timeout. It:

1. refuses if a release for this version already exists,
2. runs `task package:production` (builds the Pro + Polar-production app, Developer-ID signed — backend binaries included — and notarized by Tauri, and installs it to `/Applications`),
3. notarizes and staples the `.dmg`, then checks both with `spctl` — if notarization is rejected, get the reason with `xcrun notarytool log <submission-id>` (credentials from `.env.signing`),
4. commits only the six version files as `chore: release <new>` and pushes `main`,
5. creates GitHub release `v<new>` with its tag on that commit, with both `wickd_<new>_aarch64.dmg` and `wickd_aarch64.dmg` (the stable name the lamphere-labs site's Download buttons link to).

Wait for the completion notification; don't poll. If it fails, show the relevant tail of the output, diagnose, and do not retry blindly — a failure after the release was created must not create a second one. A build or notarization failure leaves the bump uncommitted and nothing pushed. If the push is rejected (for example `main` moved during the build), stop and tell the user: never force-push, and don't create the release from an unpushed commit.

## 4. Verify

```bash
gh release view v<new> --json tagName,url,assets -q '.tagName, .url, (.assets[].name)'
curl -sIL -o /dev/null -w '%{http_code} %{url_effective}\n' \
  https://github.com/EricLamphere/wickd/releases/latest/download/wickd_aarch64.dmg
git fetch --tags origin
git rev-parse HEAD origin/main "v<new>^{commit}"
git show --stat --format='%h %s' HEAD
```

The release should list both dmg files, and the curl should end in `200` with `filename=wickd_aarch64.dmg` in the final URL. All three commit hashes should match, and the commit should change only the six version files.

## 5. Report

Tell the user:

- the new version and the release URL,
- that both dmg files are attached and the site's Download buttons now serve `<new>`,
- that the release commit is pushed to `main` and the `v<new>` tag points at it (give the short hash), so there's nothing for them to commit or move,
- any uncommitted changes that went into the build but aren't in the tag.
