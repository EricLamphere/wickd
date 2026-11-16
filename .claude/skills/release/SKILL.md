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
- `.env.signing` must also set `TAURI_SIGNING_PRIVATE_KEY` (path to the updater key, `~/.tauri/wickd.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the key file must exist (check without printing the password). Without it installed apps can't update to this release (plan 32).
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

## 3. Release notes

Draft 3–6 short, user-facing bullets from `git log <previous tag>..HEAD --oneline` (previous tag: `gh release view --json tagName -q .tagName`). Write what a user notices ("Metric monitors can alert when data stops arriving"), not commit subjects, PR numbers or refactors. Show them to the user and wait for approval or edits. Then write them as Markdown to `<scratchpad>/release-notes-<new>.md`. They become the GitHub release body and the "What's new" text in installed apps' update bar (`latest.json`).

## 4. Build and publish

Run `task release NOTES_FILE=<that notes file>` from the repo root **in the background** (`run_in_background: true`) — the production build takes several minutes, well past the foreground timeout. It:

1. refuses if a release for this version already exists,
2. runs `task package:production` (builds the Pro + Polar-production app, Developer-ID signed — backend binaries included — and notarized by Tauri, and installs it to `/Applications`),
3. notarizes and staples the `.dmg`, then checks both with `spctl` — if notarization is rejected, get the reason with `xcrun notarytool log <submission-id>` (credentials from `.env.signing`),
4. commits only the six version files as `chore: release <new>` and pushes `main`,
5. checks that the updater tarball holds the stapled app, then writes `latest.json` (`backend/scripts/updater_manifest.py`),
6. creates GitHub release `v<new>` **as a draft**, with its tag on that commit and these assets: `wickd_<new>_aarch64.dmg`, `wickd_aarch64.dmg` (the stable name the lamphere-labs site's Download buttons link to), `wickd_<new>_aarch64.app.tar.gz` (the updater tarball) and `latest.json`. Then it publishes the draft, so "latest" only moves once every asset is there.

Wait for the completion notification; don't poll. If it fails, show the relevant tail of the output, diagnose, and do not retry blindly — a failure after the release was created must not create a second one. A build or notarization failure leaves the bump uncommitted and nothing pushed. If the push is rejected (for example `main` moved during the build), stop and tell the user: never force-push, and don't create the release from an unpushed commit.

## 5. Verify

```bash
gh release view v<new> --json tagName,url,isDraft,assets -q '.tagName, .url, .isDraft, (.assets[].name)'
curl -sIL -o /dev/null -w '%{http_code} %{url_effective}\n' \
  https://github.com/EricLamphere/wickd/releases/latest/download/wickd_aarch64.dmg
curl -sL https://github.com/EricLamphere/wickd/releases/latest/download/latest.json | jq -r .version
git fetch --tags origin
git rev-parse HEAD origin/main "v<new>^{commit}"
git show --stat --format='%h %s' HEAD
```

The release should not be a draft and should list both dmg files, the `.app.tar.gz` and `latest.json`; the `latest.json` curl must print `<new>`. The dmg curl should end in `200` with `filename=wickd_aarch64.dmg` in the final URL. All three commit hashes should match, and the commit should change only the six version files.

## 6. Report

Tell the user:

- the new version and the release URL,
- that both dmg files are attached and the site's Download buttons now serve `<new>`,
- that the release commit is pushed to `main` and the `v<new>` tag points at it (give the short hash), so there's nothing for them to commit or move,
- any uncommitted changes that went into the build but aren't in the tag.
