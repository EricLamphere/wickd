# Contributing to wickd

Thanks for helping out. This guide covers setting up a dev environment, the project's conventions, and how the desktop app is built and released. For what wickd is and how to download it, see the [README](README.md).

## Getting set up

**Prerequisites:** Python 3.11+, Node.js 20+, [Task](https://taskfile.dev) (`brew install go-task`). Building the desktop app also needs Rust and the Tauri CLI (`cargo install tauri-cli`).

```bash
task install                    # create backend/.venv, pip install, npm install
task install PYTHON=python3.12  # or pin a specific Python interpreter
task start                      # backend on :8001 + Vite on :5173, hot reload; auto-installs missing/stale deps
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` to the backend on `:8001`.

On first launch a banner asks for your dbt projects folder (**WICKD_PROJECTS_PATH**). Set it in the UI, or with an environment variable:

```bash
export WICKD_PROJECTS_PATH=$HOME/dbt-projects
task start
```

## Everyday commands

| Command | What it does |
|---|---|
| `task start` | Run the app in the browser with hot reload |
| `task start:pro` | Same, with Pro features loaded from a sibling `../wickd-pro` checkout (maintainers; `PRO_DIR=<path>` to override). Licensing uses `backend/.env`'s Polar settings |
| `task test` | Backend tests + frontend type-check and build |
| `task test:backend` | `pytest --cov=app` only |
| `task test:frontend` | Vitest unit tests, then `tsc` + `vite build` |
| `task lint` | `ruff` on the backend and ESLint on the frontend (`task lint:backend` / `task lint:frontend` for one side) |
| `task db:reset` | Delete the local SQLite database |
| `task reset` | Full reset: wipe the DB, delete the venv, reinstall |
| `task package:app` | Build the desktop app (free features) and install it to `/Applications` |

Run a single backend test file with `cd backend && .venv/bin/pytest tests/test_x.py -xvs`.

## How the code is organized

- **[docs/architecture.md](docs/architecture.md)** — stack, repository layout, database schema, API routes, events, and the key flows. Start here.
- **[docs/how-to/](docs/how-to/README.md)** — user-facing guides for each part of the app.
- **[CLAUDE.md](CLAUDE.md)** and **[.claude/rules/](.claude/rules/)** — the project's conventions in detail. They're written for AI coding assistants but are just as useful for people.

**Stack:** FastAPI, async SQLAlchemy + SQLite (aiosqlite), sse-starlette, watchfiles, and ptyprocess on the backend; React 18, TypeScript, Vite, Tailwind, TanStack Query, @xyflow/react + dagre, Monaco, and xterm.js on the frontend; Tauri for the desktop shell.

The rules that matter most:

- **dbt and git run as subprocesses only**, through the `runner` / `git_runner` singletons, which serialize commands per project. Never `import dbt`.
- **Frontend API calls go through the typed helpers in `frontend/src/lib/api.ts`**, never raw `fetch()`.
- **Server changes reach the UI over SSE** (`useProjectEvents` and friends in `lib/sse.ts`), which invalidates TanStack Query caches. Don't poll.
- **Database migrations are idempotent DDL** in `backend/app/db/migrations.py`, run on startup. There's no Alembic.
- **Tabular data uses the shared `DataTable` component.**

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WICKD_PROJECTS_PATH` | _(none)_ | Root directory scanned for dbt projects (overridable in the UI) |
| `WICKD_GLOBAL_REQUIREMENTS_PATH` | _(none)_ | `requirements.txt` installed into the dbt venv on every project open |
| `WICKD_DATA_DIR` | `<repo>/data` (dev) / `~/Library/Application Support/com.lampherelabs.wickd` (desktop app) | App storage (SQLite DB, dbt venv, docs, logs). Set automatically — not configurable in the UI |
| `WICKD_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `WICKD_AI_MODEL` | `qwen3.5-4b` | Bundled local model for AI features (Pro); set in Global Settings or the AI tab |
| `WICKD_AI_ENDPOINT_URL` / `WICKD_AI_ENDPOINT_MODEL` | _(none)_ | OpenAI-compatible server (and model name) to use instead of the bundled model; Global Settings |
| `WICKD_LLAMA_SERVER_PATH` | _(bundled copy, then `PATH`)_ | llama-server binary for local AI. `task ai:runtime` fetches the pinned build for dev |
| `POLAR_USE_SANDBOX` | `true` | Which Polar environment (sandbox/production) license checks talk to |
| `POLAR_SANDBOX_ORGANIZATION_ID` / `POLAR_PRODUCTION_ORGANIZATION_ID` | _(none)_ | Polar org id used to validate license keys (not a secret) |
| `POLAR_SANDBOX_API_KEY` / `POLAR_PRODUCTION_API_KEY` | _(none)_ | Polar API key — **secret**, set in `backend/.env` only, never commit |
| `POLAR_SANDBOX_CHECKOUT_URL` / `POLAR_PRODUCTION_CHECKOUT_URL` | _(none)_ | Checkout link behind the in-app **Upgrade to Pro** button |
| `POLAR_SANDBOX_ORGANIZATION_SLUG` / `POLAR_PRODUCTION_ORGANIZATION_SLUG` | `lamphere-labs` | Builds the Polar customer portal link (`https://[sandbox.]polar.sh/<slug>/portal`) shown for lost license keys and device seats; set to empty to hide it |

You don't need any of the Polar variables to work on wickd. Without them, Pro features simply stay locked.

Per-project settings are stored in `project_env_vars` and injected into every dbt subprocess:

| Key | Set by | Description | Default |
|---|---|---|---|
| `INIT_SCRIPT_PATH` | Environment tab | Directory (relative to the project root) scanned for `.sh` init scripts | `wickd/init` |
| `REQUIREMENTS_PATH` | Environment tab | Project-specific `requirements.txt`, installed after the global one | _(none)_ |
| `WORKSPACE_PATH` | Environment tab | Directory (relative to the project root) for SQL Workspace files | `wickd/workspace` |
| `dbt_target` | Target dropdown | Active dbt target, passed as `--target` on every invocation | _(profiles.yml default)_ |
| _(any key)_ | Init scripts | Any `export KEY=value` in a custom init script is captured automatically | — |

## wickd Pro and the open-core split

Pro features (column-level lineage and AI) are gated by a license check in this repo, but the proprietary parts live in a separate private package, `wickd-pro`. `backend/app/dbt/column_lineage.py` and `backend/app/ai/pro.py` are thin public shims that raise `ColumnLineageUnavailable` / `AiUnavailable` when the package isn't installed. The AI model runtime, downloads, API and review UI live here.

**You don't need `wickd-pro` to contribute.** Everything else builds and runs without it. Pro features just show as unavailable, exactly as they do for a free user.

## Building the desktop app

The desktop app is a Tauri shell around the PyInstaller-bundled backend and the built frontend.

| Task | Builds | Who it's for |
|---|---|---|
| `task package:app` | Free features, no licensing config | Anyone — the one to use when contributing |
| `task package:sandbox:base` | Free features, Polar sandbox | Maintainers (needs `backend/.env.sandbox`) |
| `task package:sandbox:pro` | Pro features, Polar sandbox | Maintainers (needs `wickd-pro` + `backend/.env.sandbox`) |
| `task package:production` | Pro features, Polar production | Maintainers — the real release build |

Each one builds the app and installs it to `/Applications/wickd.app`. The build output (`.app` and `.dmg`) lands in `src-tauri/target/release/bundle/`. Local builds are ad-hoc signed, which is fine for running on your own Mac.

The app icon's source is `src-tauri/icons/icon.svg`. After editing it, regenerate the bundled sizes with `cargo tauri icon src-tauri/icons/icon.svg -o /tmp/wickd-icons` and copy `32x32.png`, `128x128.png`, `128x128@2x.png` and `icon.icns` into `src-tauri/icons/` (the only files `tauri.conf.json` uses).

Inside the app (header, loading screen, setup wizard) and in browser tabs, wickd uses the *mark*: the icon's flame without the tile, from `frontend/public/` — `wickd-mark.svg` for dark backgrounds, `wickd-mark-light.svg` for light ones (`components/WickdIcon.tsx` picks by theme), and `favicon.svg`, which switches between the two with `prefers-color-scheme`. Keep them in sync with `icon.svg` when the flame changes; the lamphere-labs site uses copies of the same three files in `assets/img/`.

## Releasing (maintainers)

Releases are Developer ID signed and notarized by Apple.

1. Put your Apple credentials in `.env.signing` (gitignored; copy `.env.signing.example`). You need a **Developer ID Application** certificate in your keychain and an app-specific password.
2. Run `/release` in Claude Code, which bumps the version everywhere and runs the release, or bump the version yourself and run `task release`.

`task release` builds with `package:production`, signs the backend binaries and the app, notarizes and staples the `.dmg`, checks it with `spctl`, and creates GitHub release `v<version>`. It uploads the `.dmg` twice: with its versioned name, and as `wickd_aarch64.dmg`, which the website's Download buttons link to via `releases/latest/download/`.

## Submitting changes

- Branch off `main` and open a pull request.
- Use conventional commit messages: `feat: …`, `fix: …`, `refactor: …`, `docs: …`, `test: …`, `chore: …`.
- Add or update tests for behavior changes, and make sure `task test` and `task lint` pass.
- CI ([`.github/workflows/tests.yml`](.github/workflows/tests.yml)) runs the same checks on every pull request and every push to `main`: backend tests on Python 3.11 and 3.12, ruff, and the frontend's ESLint, unit tests and build. Pro features are not installed in CI, so tests must pass without `wickd-pro`.
- Update the docs your change affects: `docs/architecture.md` for routes, tables, and flows, the relevant `docs/how-to/` guide for user-facing changes, and the README's feature list for new features.
