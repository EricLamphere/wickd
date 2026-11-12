# wickd

Local web UI for managing dbt projects. No auth, single user, runs on localhost only.
Backend on `:8001`, frontend on `:5173`.

This repo is the public/free product. Column-level lineage's actual tracing
algorithm lives in a separate private repo (`wickd-pro`, expected as a
sibling checkout), and the marketing site lives in another separate private
repo (`lamphere-labs`). See
[.claude/rules/related-repos.md](.claude/rules/related-repos.md) before
working on Pro features or updating screenshots/gallery content.

## Stack

| Layer | Tech |
|-------|------|
| Backend | Python 3.11+, FastAPI, SQLAlchemy async (aiosqlite), sse-starlette, structlog |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, React Router v6, TanStack Query |
| DAG | @xyflow/react + dagre layout |
| Editor | Monaco (@monaco-editor/react) |
| Terminal | xterm.js + ptyprocess (dbt init PTY) |
| DB | SQLite via aiosqlite |
| Deploy | Taskfile (task start) |

## Directory Map

**[docs/codemap.md](docs/codemap.md) describes every module, file by file. Search it (for example, `grep -n "column_lineage" docs/codemap.md`) before working in an unfamiliar area.**

```
backend/app/
  api/          FastAPI routers, one file per resource
  db/           SQLAlchemy models, session dependency, DDL-on-startup migrations
  dbt/          runner singleton, manifest parsing, YAML splicers, Pro shims
  ai/           local AI (Pro): model download/runtime, proposals, Wicky
  semantic/     MetricFlow sidecar, metric queries, dashboards, monitors
  charts/       dbt Charts boards   data_diff/   data diff (Pro)
  health/       check summaries     propagation/, refactor/, test_targets/, performance/  Pro features
  licensing/    Polar entitlements  events/      bus + SSE
  scheduling/   cron, rules, shared ticker loop   runs/  scheduled runs (plan 27)
  projects/     discovery + search  git/         GitRunner singleton
  files/        file operations     watcher/     shared file watcher

frontend/src/
  lib/          api.ts (all API helpers), sse.ts, shared hooks
  components/   shared UI (DataTable, RichTable, charts, dialogs)
  routes/Home.tsx
  routes/Project/  one folder or file per page; components/ (Wicky, SidePane, BottomPane, health); lib/
```

## Database Tables

All 28 in `backend/app/db/models.py`:
- `projects` — discovered dbt projects (includes `init_script_path: str` per-project init dir; `ignored: bool` to hide from list; `last_init_status: str` (idle/running/success/error), `last_init_started_at`, `last_init_finished_at`, `last_init_failed_step` — persisted init pipeline status shown on the homepage and Initialization page; `metricflow_mode: str` '' = global default, auto, off — semantic layer; `schedules_paused: bool` Runs → Schedule's Pause all)
- `init_steps` — ordered init pipeline steps per project (includes `script_path` for linked external scripts; `removed: bool` = removed from the pipeline with its init-dir script kept (hidden, never run, so the disk sync doesn't re-add it); `last_status: str` (idle/running/success/error), `last_started_at`, `last_finished_at`, `last_log: str` (capped at 200 lines) — persisted per-step run status)
- `model_statuses` — per-node run status (idle/pending/running/success/error/warn/stale); `kind` model / test / unit_test (`parent_model_id` = the tested model)
- `run_invocations` — historical run records; `custom_args` (JSON list, nullable) holds the user-entered args of a custom dbt command so rerun replays them exactly; `state_json` (nullable) the slim build settings a run used (plan 18: state source/sha/target, state, defer, favor_state), replayed on rerun; `threads`, `elapsed_time` from run_results.json (NULL before timing capture); `trigger` manual/schedule/rerun and `schedule_id` (FK run_schedules, SET NULL) — plan 27
- `invocation_model_results` — per-node results per invocation (last 20 per node kept; `kind` model / test / unit_test): `execution_time`, `status`, `message`, plus timing from run_results.json — `started_at`/`completed_at` (execute window), `thread_id`, `rows_affected`, `bytes_processed`, `adapter_response_json` (capped ~2 KB); timing columns NULL for older runs
- `env_profiles` — named environment profiles per project
- `profile_env_vars` — key/value vars belonging to a profile
- `project_env_vars` — project-level env vars (not profile-scoped); includes `dbt_target` for active target; `REQUIREMENTS_PATH` for per-project requirements; `WORKSPACE_PATH` for SQL workspace dir (default `wickd/workspace`); `DASHBOARDS_PATH` for metric dashboard files (default `wickd/dashboards`); `DOCS_PATH` for Docs → Pages Markdown (default `docs`, else the repo root's `docs/`); `DIFF_BASE_TARGET` for metric compare's "before" target and data diff's prod side (Pro)
- `app_settings` — global app config (key/value); keys: `dbt_projects_path`, `global_requirements_path`, `dbt_core_version`, `log_level`, `theme`, `python_path`, `setup_completed`, `ai_model`, `ai_endpoint_url`, `ai_endpoint_model`, `metricflow_mode` (auto/off), `combined_docs_profile_id` (home page profile for combined docs)
- `global_env_vars` — default env vars (key unique) for every project and for global setup's pip install; precedence (low → high) is process env → global env vars → active profile → project env vars (`app/envvars.py` `layer_env()`, used by `load_project_env()`)
- `global_profiles` — named env var sets shared across all projects
- `global_profile_vars` — key/value vars belonging to a global profile
- `drift_snapshots` — schema drift scan results per project; stores status (running/done/error), progress counters, results_json (array of per-model column diffs, incl. `not_built` and `yaml_path`) and `skipped_json` ({materialization: count} of models not checked)
- `freshness_snapshots` — source freshness scan results per project; stores status (running/done/error), target, started_at, finished_at, results_json (array of per-source freshness results), and error_message
- `column_lineage_snapshots` — backgrounded column-level lineage scan results per project; stores status (running/done/error), total_models/checked_models progress counters, results_json (map of downstream unique_id → column → list of upstream `{node, column}` refs), `row_dependencies_json` (unique_id → upstream `{node, column}` refs it filters/joins/groups on), error_message, `manifest_mtime` and `lineage_version` (1 = projection only, 2 = with row dependencies, 3 = each results_json ref also has a transform `kind`: identity/rename/cast/derived, used by lineage propagation; 4 = also `join_keys_json`: per model `{join_pairs: [{left, right, type}], grain: {columns, via} | null}`, used by test suggestions), `fingerprint_json` (per-node content fingerprint of the traced manifest: the latest done snapshot is the cache, stale only when content changed, never on manifest mtime; `app/dbt/lineage_freshness.py`; '' = predates change tracking, reads stale), `job_keys_json` (uid → hash of the job's inputs; a refresh re-traces only changed jobs)
- `ai_conversations` / `ai_messages` — Wicky chats per project (wickd Pro AI); messages store `role` (user/assistant/action/query), `payload_json` (query SQL + results), `content`, the `unique_id` in context and, for `action` messages (quick actions run from the chat), `proposal_id`
- `ai_proposals` / `ai_proposal_files` — AI-generated (or refactor) file changes awaiting review (`kind` document/document_stub/tests/unit_test/unit_test_rebaseline/propagate/refactor/semantic/exposure/saved_query/charts_board; `status` generating/ready/applied/rejected/dismissed/error/empty/undone — empty = nothing needed changing; `result_json` keeps the generated descriptions for chat history; dismissing keeps the row; per file `op` (modify/create/delete/rename), `new_path` (rename target), `original_text` (null = new file), `proposed_text`, `applied_text` (what accepting wrote; Undo restores only while the file still holds it), `status` pending/accepted/rejected/undone); accept re-checks the file is unchanged
- `semantic_check_snapshots` — Health → Semantic Layer runs per project: status (running/done/error), started_at/finished_at, results_json (`{errors, warnings, future_errors: [issue], warehouse: [{metric, ok, error}] | null}`), error_message, `manifest_hash` (sha1 of semantic_manifest.json at the start; the summary flags it stale once the content differs — every dbt command rewrites the file, so mtime isn't used)
- `metric_query_results` — Metrics page result cache (`app/semantic/query_cache.py`): one row per (`project_id`, `target`, `env_fingerprint`, `sql_hash`) — the fingerprint hashes the env vars wickd layers in (global → profile → project + DBT_TARGET, plus the profiles.yml dbt reads; never the values), the SQL hash changes with definitions; `profile_name`, `metrics_json`, `group_by_json`, `columns_json`, `rows_json` (≤ 5000), `truncated`, `ran_at`, `elapsed_ms`; last 100 per project
- `metric_monitors` — metrics watched for anomalies (Pro; plan 10), per project: `metric`, `grain` (day/week/month), `dimension` (nullable; slices = its top 10 values in `slices_json`, recomputed weekly via `slices_refreshed_at`), `sensitivity` (low/normal/high), `lookback` (periods), `enabled`, `target` (pinned dbt target, NULL = active), `last_result_json` / `last_checked_at` (latest detection summary), `position` (Monitors tab order, drag to reorder via PUT …/order), `schedule` (auto-check override: NULL = the project's MONITOR_INTERVAL_HOURS / MONITOR_SCHEDULE, `off`, or a cron expression); at most 25 per project
- `metric_monitor_points` — a monitor's history: (`monitor_id`, `target`, `slice` ('' unsliced), `period` YYYY-MM-DD) unique; `value`, `previous_value` (set only for a restatement: the replaced value had been stored after its period ended), `suppressed` ("mark as expected"), `observed_at`; trimmed to the lookback
- `metric_monitor_runs` — one monitor check: `target`, `status` running/done/error, `trigger` build/manual/interval, `monitors_json`, `results_json` (per monitor summary + flagged points), `error_message`, timestamps
- `contract_check_snapshots` — contract checks (Pro, plan 05) per project: `scope` (working/branch), `base`, `base_sha` (commit compared with), `types` (column types probed), `status` running/done/error, `phase` while running, `target`, `results_json` (per changed model from wickd_pro.contracts, plus `dbt_state_contract` = null until plan 18), `notes_json`, `lineage_used`, `error_message`, timestamps; written by `api/contracts.py`
- `data_diff_snapshots` — data diffs (Pro, plan 06): one row per model per diff (last 5 kept per model): `unique_id`, `name`, `scope`/`base_ref`, `dev_target`/`prod_target` (DIFF_BASE_TARGET), `dev_relation`/`prod_relation`, `mode` (joined = one connection reads both, separate = each side on its own connection), `key_json` + `key_source` (user/contract/unique_test/unique_combination/detected), `columns_json`, `where_sql`, `built`, `status` running/done/error, `phase`, `results_json` (wickd_pro.data_diff result), `error_message`, timestamps; written by `app/data_diff/job.py`
- `test_gap_ignores` — Test gaps rows the user ignored (Health → Test Gaps → Ignored), per project: `key` (row key `<unique_id>::<column>` or `<unique_id>::(a, b)`, unique per project), `unique_id`, `name`, `label` (kept to list the row once the gap is gone), `created_at`; hidden from GET /test-gaps and its count until unignored (`app/test_targets/ignores.py`)
- `run_schedules` — scheduled runs (plan 27, `app/runs/scheduler.py`): `name`, `command` (raw text, re-parsed on save and fire), `interval_hours` | `cron` (both NULL = off), `target` (NULL = active at fire time), `catch_up`, `busy_wait_minutes` (default 30), `enabled`, `position`, `armed_at` (due-ness counts from max(last_fired_at, armed_at)), `last_fired_at`, `last_status`, `last_invocation_id`, `last_event_id`
- `run_schedule_events` — one fire of a schedule (last 50 kept): `at`, `trigger` schedule/manual, `outcome` pending/running/success/error/cancelled/missed/skipped_busy/invalid, `invocation_id`, `message`
- `license_state` — single-row (id=1) cached Polar entitlement state for this installation: `license_key`, `activation_id`, `device_id`, `entitled`, `status`, `checked_at`, `customer_id` (Polar customer id, captured from `validate()`; required to cancel a subscription), `license_key_id` (Polar's internal id for the key, required to look up activation count), `limit_activations` (max devices allowed on this key) — see `app/licensing/entitlements.py`

## Critical Architecture Rules

### Git Execution — SUBPROCESS ONLY (GitRunner)

```python
# CORRECT — always go through git_runner
from app.git.runner import git_runner, GitRequest
req = GitRequest(project_id=id, repo_root=repo_path, args=("status", "--porcelain=v2", "--branch", "-z"))
rc, output = await git_runner.run(req)          # short ops (status, diff, stage, commit, …)
async for kind, line in git_runner.stream(req): # long ops (push, pull)
    ...  # bus publishes git_started/git_log/git_finished automatically

# Find repo root (walks upward from project_path)
from app.git.repo import find_repo_root
repo = find_repo_root(Path(project.path))  # returns None if not a git repo
```

- `git_runner` (`app.git.runner.git_runner`) is a **module-level singleton** — never instantiate another
- Each `project_id` gets its own `asyncio.Lock` — git ops are serialized per project
- **Never** `import git` or use GitPython — shell out only; same rule as dbt
- `find_repo_root()` walks upward from the project path, so projects inside a mono-repo are handled correctly
- After mutating ops (stage/unstage/commit/checkout/push/pull): call `_publish_status_changed(project_id)` to emit `git_status_changed`

### dbt Execution — SUBPROCESS ONLY

```python
# CORRECT — always go through runner
from app.dbt.runner import runner, RunRequest
req = RunRequest(project_id=id, project_path=path, command="run", select="my_model")
async for kind, line in runner.stream(req):
    ...  # bus already publishes run_started/run_log/run_finished

# WRONG — never do this
import dbt  # dbt Python library not installed
```

- `runner` (`app.dbt.runner.runner`) is a **module-level singleton** — never instantiate another
- Each `project_id` gets its own `asyncio.Lock` — runs are serialized per project, never bypass the lock
- `runner.stream(req)` is an async generator; it publishes `run_started`, `run_log`, `run_finished` to the bus automatically
- `RunRequest.extra` tuple accepts additional CLI args; dbt target is passed here when set via `/api/projects/{id}/dbt-target`
- After a run: call `_persist_results_after_run(project)` (see `api/runs.py`) to write `model_statuses` and publish `statuses_changed`
- Canonical pattern: `api/runs.py` → `_run_dbt_and_persist()`

### Event Bus

```python
from app.events.bus import bus, Event

# Publish
await bus.publish(Event(topic="project:42", type="my_event", data={"key": "val"}))

# Subscribe (always unsubscribe in finally)
queue = await bus.subscribe("project:42")
try:
    event = await queue.get()
finally:
    await bus.unsubscribe("project:42", queue)
```

- `bus` is a **module singleton** — never instantiate EventBus
- **NOT reset between requests or tests** — subscriber leaks persist across the process lifetime
- Topics: `project:{id}` (all project events) | `init:{session_id}` (dbt init PTY output only) | `terminal:{session_id}` (bash terminal PTY output only)
- SSE helpers (`events/sse.py`) handle subscribe/unsubscribe — prefer them for endpoints
- `sse_response(topic)` — standard stream with 15s keepalive
- `sse_response_with_replay(topic, replay_chunks, already_finished, return_code)` — PTY sessions only (late-subscriber catch-up)

### Event Types

| Type | Topic | Meaning |
|------|-------|---------|
| `run_started` | project | dbt command started; payload `command`, `label` (command + subcommand words, e.g. `source freshness`), `select`, `started_at`, `trigger` (manual/schedule/rerun), `schedule_id`, `invocation_id` (Runs page row, null when not recorded), `command_line` (the command as typed, no `--profiles-dir`) |
| `run_log` | project | one line of stdout/stderr; frontend parses to update RunPanel DAG |
| `run_finished` | project | dbt process exited |
| `run_error` | project | dbt executable not found |
| `statuses_changed` | project | model_statuses updated in DB |
| `graph_changed` | project | manifest.json changed on disk |
| `files_changed` | project | .sql/.yml changed on disk |
| `compile_started` | project | compilation starting |
| `compile_finished` | project | compilation done |
| `docs_generating` | project | dbt docs generate started |
| `docs_generated` | project | docs generation finished |
| `init_pipeline_started` | project | init pipeline beginning |
| `init_step` | project | one init step completed |
| `init_pipeline_finished` | project | all init steps done |
| `init_output` | init | PTY terminal chunk (dbt init interactive) |
| `init_finished` | init | PTY process exited (dbt init interactive) |
| `terminal_output` | terminal | PTY terminal chunk (bash terminal) |
| `terminal_finished` | terminal | PTY process exited (bash terminal) |
| `git_status_changed` | project | git index/branch changed — frontend re-fetches git status |
| `git_started` | project | git push/pull started |
| `git_log` | project | one line of git push/pull output |
| `git_finished` | project | git push/pull exited |
| `git_error` | project | git executable not found on PATH |
| `health_check_started` | project | dbt debug run started |
| `health_check_finished` | project | dbt debug run finished; payload includes structured check results |
| `drift_started` | project | schema drift scan started |
| `drift_progress` | project | a probe batch started, or one model checked; payload includes `checked`, `total`, `batch_start`/`batch_end` |
| `drift_finished` | project | schema drift scan finished (also after a single-model recheck; payload has `recheck`) |
| `freshness_started` | project | source freshness scan started; payload includes `snapshot_id` |
| `freshness_finished` | project | source freshness scan finished; payload includes `snapshot_id`, `ok`, `pass_count`, `warn_count`, `error_count` |
| `column_lineage_started` | project | backgrounded column lineage scan started; payload includes `snapshot_id`, `total`, `reused` (models carried over unchanged) |
| `column_lineage_progress` | project | one model's lineage traced; payload includes `snapshot_id`, `checked`, `total`, `current` (model name) |
| `column_lineage_finished` | project | column lineage scan finished; payload includes `snapshot_id`, `ok` |
| `ai_proposal_updated` | project | AI proposal created / changed status; payload `proposal_id`, `status` (incl. `dismissed`), `unique_id` |
| `ai_query_updated` | project | Query data query status changed; payload `message_id`, `status` (waiting/running/done/error) |
| `ai_proposal_progress` | project | AI proposal generating (throttled ~4/s); payload `proposal_id`, `unique_id`, `phase` (columns/sampling/writing/checking), `text` (model's JSON answer so far); Test gaps batch: `unique_id` null, plus `done`/`total`/`current` per model |
| `semantic_check_started` | project | Health semantic layer check started; payload `snapshot_id`, `warehouse` |
| `semantic_check_finished` | project | check finished; payload `snapshot_id`, `ok`, `errors`, `warnings` |
| `metric_monitor_started` | project | metric monitor check started; payload `run_id`, `count`, `trigger` |
| `metric_monitor_progress` | project | check step; payload `run_id`, `step` (slices/querying/detecting), `total` |
| `metric_monitor_finished` | project | check finished; payload `run_id`, `ok`, `counts` by status |
| `contract_check_started` | project | contract check (Pro) started; payload `snapshot_id`, `scope`, `types` |
| `contract_check_progress` | project | payload `snapshot_id`, `phase` (compiling_head/compiling_base/types/checking) |
| `contract_check_finished` | project | payload `snapshot_id`, `scope`, `ok`, `errors`, `warnings` |
| `data_diff_started` | project | data diff (Pro) started; payload `snapshot_ids`, `count` |
| `data_diff_progress` | project | payload `snapshot_ids`, `phase` (building/resolving/probing/comparing), `round`/`pending` while comparing |
| `data_diff_finished` | project | payload `snapshot_ids`, `ok`, `counts` (done/error/different) or `cancelled` |
| `dashboards_changed` | project | dashboard file created/saved/deleted or changed on disk; payload `slug` |
| `docs_pages_changed` | project + global | a Markdown page or image in the docs folder changed; payload `paths` (global copy adds `project_id`, for combined docs' Pages tab) |
| `charts_changed` | project | a dbt Charts board file under `charts/` (or `dbt_charts.yml`) changed on disk |
| `charts_build_started` | project | static board build started; payload `board` |
| `charts_build_finished` | project | static board build finished; payload `board`, `ok`, `error` |
| `run_schedules_changed` | project | a scheduled run's settings or last outcome changed (plan 27); payload `schedule_id`, `outcome`, `name`, `invocation_id` |
| `workspace_log` | global | home page Project Logs line (combined docs runs only); payload `line` |
| `api_log` | project + global | one API request log line; payload `line` |
| `metricflow_env` | global | MetricFlow sidecar setup; payload `state` (installing/ready/error), `phase`, `message` |
| `charts_env` | global | dbt Charts sidecar setup; payload `state` (installing/ready/error), `phase`, `message` |
| `ai_model_download` | global | AI model download progress; payload `model_id`, `state`, `bytes_done`, `bytes_total`, `error` |

### Init Pipeline System

**Init Pipeline** — runs pip install + dbt deps + custom shell scripts in sequence
- Entry: `POST /api/projects/{id}/open`
- Built-in base steps (in order): `base: pip install`, `base: dbt deps`
- Scripts in `{project_path}/{init_script_path}/*.sh` (default `wickd/init/`; managed by `dbt/init_scripts.py`)
- Per-project `init_script_path` column in `projects` table
- Linked external scripts tracked with absolute `script_path` in `init_steps` table
- `_sync_steps_from_disk()` only deletes owned (init-dir) scripts; preserves linked ones
- SSE topic: `project:{id}`
- Events: `init_pipeline_started` → `init_step` (×N) → `init_pipeline_finished`
- Per-project `asyncio.Lock` (mirrors `DbtRunner._lock_for`) serializes pipeline runs; `POST /{id}/open` and `POST /{id}/init/run-step` return `409` if a run is already in progress for that project
- Status/log fields on `Project` and `InitStep` (`last_init_status`, `last_status`, `last_log`, etc.) are written at each pipeline/step start and finish so status survives navigation and server restarts; a startup migration flips any row stuck in `running` to `error` after a crash
- The run in progress is tracked in memory (`_active_runs` in `api/init.py`: its steps and which have started), exposed per step as `run_state` on `GET /init/steps` (`pending` = in the run, not reached yet). The Initialization page seeds tile states from it (`seedStepStates()` in `InitPipeline/flow.ts`), only from data fetched after mount, so leaving and returning mid-run shows the live run rather than the previous run's colors

**`base: pip install` step logic:**
1. Reads `global_requirements_path` from `app_settings` (set via Global Settings UI)
2. Reads `REQUIREMENTS_PATH` from project env vars (set in Environment tab)
3. Installs both (global first, project second) into the dbt venv via `_venv_pip()` (pip co-located with the `dbt` binary)
4. Skips silently if neither path is configured; fails fast if a configured path does not exist

### Interactive PTY Systems

Both share the **InteractiveInitManager singleton** (two separate use cases):

**1. Interactive dbt init**
- Entry: `POST /api/projects/init-session/start`
- First pip-installs the dbt adapter, then spawns `dbt init` via ptyprocess
- SSE topic: `init:{session_id}`
- Events: `init_output` (chunks), `init_finished`
- Replay buffer in-memory — replayed to late subscribers; **no persistence across restart**

**2. Terminal (bash)**
- Entry: `POST /api/terminal/start` (queries via `api.terminal.start()`)
- Spawns user's shell (bash/zsh) via ptyprocess
- Supports input (`POST /api/terminal/{id}/input`), resize (`POST /api/terminal/{id}/resize`), stop (`POST /api/terminal/{id}/stop`)
- SSE topic: `terminal:{session_id}`
- Events: `terminal_output` (chunks), `terminal_finished`
- Replay buffer in-memory — replayed to late subscribers
- Frontend: `TerminalPanel.tsx` uses xterm.js with multi-instance tabs

### SSE + React Query Pattern (Frontend)

```tsx
// Always use appropriate SSE hook — never poll
useProjectEvents(projectId, useCallback((event) => {
  if (event.type === 'statuses_changed' || event.type === 'graph_changed') {
    qc.invalidateQueries({ queryKey: ['graph', projectId] });
  }
}, [projectId, qc]));

// Terminal: useTerminalEvents
useTerminalEvents(sessionId, onEvent, useCallback(() => { /* on close */ }, []));

// dbt init PTY: useInitSessionEvents
useInitSessionEvents(sessionId, onEvent, useCallback(() => { /* on close */ }, []));
```

- All API calls through `lib/api.ts` typed helpers — never `fetch()` directly in components
- SSE via `useProjectEvents` / `useInitSessionEvents` / `useTerminalEvents` from `lib/sse.ts`
- TanStack Query cache invalidated by SSE events — never rely on polling for freshness
- `RunPanel` is **always mounted** in `ProjectLayout` (never unmounted) so it receives `run_log` SSE events even when bottom pane is closed

### dbt Target Configuration

- `GET /api/projects/{id}/dbt-targets` — reads `profiles.yml` (project-local first, falls back to `~/.dbt/`) and returns available target names
- `GET /api/projects/{id}/dbt-target` — returns currently active target from `ProjectEnvVar` table (key: `dbt_target`)
- `PUT /api/projects/{id}/dbt-target` — sets active target; subsequent dbt runs pass `--target {value}` via `RunRequest.extra`
- Frontend Header has Profile and Target dropdowns; Target select calls `api.profiles.setDbtTarget()` on change
- Project-local `profiles.yml` (if exists) takes precedence over `~/.dbt/profiles.yml`

### Global Settings

- `AppSetting` table stores key/value pairs for global config
- `GET /api/settings` returns `{ dbt_projects_path, global_requirements_path, log_level, theme, python_path, python_path_editable, configured }`
- `PUT /api/settings` updates any subset of the above keys
- `python_path` (`WICKD_PYTHON_PATH`) is the interpreter the dbt venv is built from. Seeded at startup by `load_python_setting()` (`dbt/python_env.py`) from whatever the existing venv was built from, else `find_system_python()`. The UI is a dropdown fed by `GET /api/settings/python-interpreters` (`venv.list_pythons()` — 3.11+ installs found on PATH, Homebrew, `~/.pyenv/versions/*/bin`, python.org frameworks; deduped by realpath, virtualenv interpreters excluded). Changing it validates (3.11+, not inside a virtualenv), rebuilds the venv via `venv.rebuild_venv()` (skipped when the new path is a symlink to the current interpreter) and only then saves; empty input re-detects; returns 409 while a dbt run, global setup, or init pipeline is in flight. Mirrored into `app.dbt.venv` via `set_configured_python()` because venv resolution is sync. The venv records its interpreter in `<venv>/.wickd-python`, and `ensure_venv()` rebuilds on mismatch. The dbt venv is `data/dbt-venv` in dev (not `backend/.venv` — dbt is kept out of the backend's own venv so its Python can be switched) and `<data_dir>/dbt-venv` in the packaged app. `python_path_editable` is false only if `WICKD_DBT_VENV_DIR` points at the backend's own venv, which is never rebuilt
- **First-run setup wizard**: `SetupGate` (`frontend/src/components/setup/`, wraps the whole app in `App.tsx`) shows a full-screen `LoadingScreen` until the first `GET /api/settings` succeeds (retrying every 250ms — the backend may still be booting), then `SetupWizard` *instead of* the app while `setup_completed` is false, or on the `wickd:open-setup` window event (Global Settings → Run setup again). It saves everything via `POST /api/setup/complete` (`api/setup.py`), which validates paths first, then `change_python_path()`, then creates the requirements file if `create_requirements_file` (seeded with `dbt-core`; the wizard defaults the path to `<projects folder>/requirements.txt`), then commits and rescans; field errors come back as `400 {field, code, message}`, and the wizard jumps to that step. The last step streams global setup via the shared `useGlobalSetupRun()` hook (also used by `GlobalSetupModal`). `seed_setup_completed()` runs at startup and marks installs that predate the wizard (projects path already set in the DB or env) as complete
- `GET /api/init/dbt-core-status` also returns `expected` (the global requirements file's dbt-core line, else `dbt-core==<dbt_core_version>`), `expected_source` and `matches` (`requirement_satisfied()`, range-aware); the home page shows DbtCoreDriftBanner (lib/dbtCoreDrift.ts, tested) with Reinstall → global setup when `matches` is false. The installed version is parsed by `parse_dbt_version()` (`dbt --version` prints `Core:` / `- installed: X` on dbt 1.x)
- `PUT /api/settings` keeps one source of truth for dbt-core: saving a non-empty `global_requirements_path` deletes `dbt_core_version`, and a non-empty `dbt_core_version` is refused (400) while a requirements file is set; Global Settings shows that row as "Set by your requirements file"
- Status checks (`/api/init/dbt-core-status`, `/api/init/package-info`) use `venv.existing_bin()` and never create the dbt venv — creating it blocks the event loop ~1s and would build it before the wizard's Python choice
- Global setup (`POST /api/init/global-setup`) installs the global requirements file if set, else `pip install --upgrade dbt-core[==dbt_core_version]` (`_global_setup_install_args()`)
- dbt-core version (`app/dbt/core_version.py`, unit-tested in test_core_version.py): the wizard's Packages step offers a picker (`GET /api/setup/dbt-core-versions`, PyPI, cached) unless the requirements file already lists dbt-core (`GET /api/setup/requirements-file`); the choice seeds a new file, is appended to an existing one without dbt-core, or with no file becomes the `dbt_core_version` setting (WICKD_DBT_CORE_VERSION). Frontend: components/setup/dbtCorePlan.ts (pure, tested) + DbtCoreVersionPicker.tsx
- `configured: bool` indicates whether `WICKD_PROJECTS_PATH` is meaningfully set (mandatory to show project list)
- Home page shows blocking banner if `configured: false`
- Workspace is resolved from `app_settings` table (key `dbt_projects_path`) with fallback to env var `WICKD_PROJECTS_PATH`
- `_effective_workspace()` in `projects/service.py` handles resolution; used by `rescan_projects` and `start_init_session`
- `global_requirements_path` is read by `_run_init_steps()` in `api/init.py` during `base: pip install`

### File Watcher

- `WatcherManager` in `watcher/service.py` — Rust-backed watchfiles, ~200ms debounce
- One `watchfiles.watch()` on a dedicated thread for all projects (never one per project: `awatch()` builds its watcher on the event loop and parks a worker thread each, which made startup crawl with many projects); `build_plan()` / `is_relevant()` / `route_changes()` are pure and unit-tested in `test_watcher.py`
- Watches per project: `models/`, `tests/`, `seeds/`, `snapshots/`, `macros/`, `analyses/`, `target/`
- `manifest.json` or `run_results.json` changed → publishes `graph_changed`
- `.sql` / `.yml` / `.yaml` changed → publishes `files_changed`

### Bottom Pane Architecture

- Shared across all Project routes (Home, Models, Docs, etc.)
- Lives in `ProjectLayout` alongside router outlet
- Supports dragging to open/close; snaps closed below 80px threshold
- Multi-tab interface, in order: "Node DAG", "Node SQL", "Execution DAG" (RunPanel), "Impact", "Terminal", "Project Logs", "API Logs"; Execution DAG is the default tab; the pane never opens itself on a run (it stays as the user left it). Commands without DAG nodes (compile, docs generate, debug, …) show one project node with the operation's name (OperationNode.tsx, lib/operationRun.ts)
- **Node DAG** tab (`NodeDagPanel.tsx`) shows the `+node+` lineage of the selected node, centered on it. The selection is lifted into `ProjectLayout` via `lib/selectedNodeContext.tsx`: pages call `useReportSelectedNode(uid)` (Models.tsx, FileExplorer and the Git page — the selected changed file's node via `lib/nodeForPath.ts` `nodeForRepoPath()`, which strips the repo-relative project subpath) and it clears on unmount; `lib/nodeLineage.ts` `buildNodeLineageGraph()` builds the subgraph (tests excluded unless the selected node is a test). Mounted only while visible so centering uses the real pane size
- Terminal tab allows multiple instances with VSCode-style tabs on the right side
- `RunPanel` always mounted to continuously receive `run_log` SSE events
- The app home page has its own pane (`routes/Home/HomeBottomPane.tsx`): Terminal, Project Logs (only combined docs runs, via `app/logs/workspace_logger.py`), API Logs; it reuses `PaneTabBar`, `usePaneResize`, `TerminalArea` and `LogView` from `BottomPane/`
- `BottomPane` manages `open` state, `activeTab`, and `height`

### SidePane Architecture (Right Panel)

- Horizontally draggable/collapsible panel, same pattern as BottomPane
- Unified replacement for old inline `ModelSidePanel` (DAG view) and file explorer metadata
- **Single component**: `SidePane` renders `PropertiesTab` directly (no tab bar)
- Props: `projectId`, `model` (ModelNode or null), `graph`, `page` ('files' | 'dag'), navigation callbacks (`onNavigateToFiles`, `onNavigateToDag`, `onViewDocs`, `onDelete`), `failedTestUid`
- **PropertiesTab** — unified model inspector showing:
  - Metadata: name, type, materialization, schema, database, file path, dependencies, tags, description, current status
  - Run controls: 3×3 grid (run/build/test × upstream/downstream/all) for models; single test button for tests
  - Test failures: rows of failing test metadata (when applicable)
  - Action buttons: Edit in Files / Open in DAG, View Docs, Delete model
- All run state and execution logic lives in PropertiesTab (no lifting to parent)
- Models.tsx mounts SidePane(page="dag"); FileExplorer mounts SidePane(page="files")
- Deep-link support: `Models.tsx` uses `useSearchParams` to read `?model=<unique_id>` and pre-select on load; the param stays in sync with the selection so it's part of back/forward history

### Project Files and Configuration

**API Endpoints** (`backend/app/api/projects.py`):
- `GET /api/projects/{id}` — returns `ProjectOut` with `readme`, `dbt_project_yml`, and `profiles_yml` text fields (populated on GET)
- `POST /api/projects/{id}/ensure-profiles-yml` — writes minimal `profiles.yml` to project dir if missing (e.g., after `dbt init`)
- `PATCH /api/projects/{id}/settings` — updates `init_script_path` only

**dbt Targets** (`backend/app/api/env.py`):
- `GET /api/projects/{id}/dbt-targets` — reads `profiles.yml` (project-local first, then `~/.dbt/`) and returns list of available target names
- `GET /api/projects/{id}/dbt-target` — returns currently active target from `ProjectEnvVar` table (key: `dbt_target`)
- `PUT /api/projects/{id}/dbt-target` — sets active target; subsequent runs pass `--target {value}` via `RunRequest.extra`

**Frontend**:
- Project homepage (`index.tsx`) displays README, dbt_project.yml, and profiles.yml in tabbed Monaco viewer using `YamlViewer` component
- Header has Profile and Target selectors; Target dropdown populated from `GET /api/projects/{id}/dbt-targets`
- FileExplorer: Removed old MAIN_TABS (View/Run/Setup); ViewPane always shown; integrated SidePane for navigation

## Development Commands

```bash
task start           # backend + frontend in parallel (primary)
task start:pro       # same, with Pro loaded live from ../wickd-pro via PYTHONPATH (no install; hot reload watches both repos; PRO_DIR=<path> to override)
task dev:backend     # uvicorn on :8001, hot reload
task dev:frontend    # vite on :5173, proxies /api → :8001
task test:backend    # pytest --cov=app -q (run from backend/)
task test            # pytest + tsc build
task lint            # ruff check app tests
task ai:runtime      # fetch the pinned llama.cpp build (llama-server) into src-tauri/binaries/llama; dev uses it, packaging bundles + signs it
task db:reset        # delete data/wickd.sqlite
task package:app     # build + install the free desktop app (no wickd-pro, no .env needed)
task release         # runs package:production signed with the Developer ID in .env.signing (gitignored; see .env.signing.example), notarizes, commits the version files, pushes main, then creates the GitHub release tagged on that commit; also uploads wickd_aarch64.dmg (stable name the lamphere-labs site's Download buttons link to)
```

Single test file: `cd backend && .venv/bin/pytest tests/test_x.py -xvs`

## Checklist: Adding a New dbt Feature (Command or Event)

- [ ] API endpoint in `backend/app/api/` — follow `runs.py` `_run_dbt_and_persist()` pattern
- [ ] Use `runner.stream(req)` — never `asyncio.create_subprocess_exec` directly
- [ ] Publish event via `bus.publish()` with correct topic (`project:{id}`)
- [ ] Add event type to `useProjectEvents` handler in the relevant frontend route
- [ ] If event means stale data: `qc.invalidateQueries(...)` in the handler
- [ ] Add typed API helper to `lib/api.ts` if new endpoint
- [ ] Write backend test with `override_db` fixture (autouse — no declaration needed)
- [ ] Update `docs/architecture.md` → API Routes and Key Flows if user-facing
- [ ] Update `docs/how-to/run-models.md` if run/build/test controls changed

## Checklist: Adding a New Global Setting

- [ ] Add key/value to `AppSetting` table via migrations (or upsert in-code if safe)
- [ ] Add field to `SettingsUpdateDto` and `SettingsDto` in `api/settings.py`
- [ ] Add `_get_override(session, "my_key")` call in `get_settings()`
- [ ] Add `_upsert(session, "my_key", ...)` call in `put_settings()`
- [ ] Return `configured` flag if it affects workspace visibility (Home page)
- [ ] Call `_effective_workspace()` in `projects/service.py` to resolve final workspace path
- [ ] Update frontend `api.settings.get()` type if response shape changed
- [ ] Update `docs/architecture.md` → Configuration table and `CONTRIBUTING.md` → Configuration table
- [ ] Update `docs/how-to/configure-environment.md` → Global settings section

## Checklist: Adding a New Terminal Feature

- [ ] Terminal sessions reuse `InteractiveInitManager` in `app.dbt.interactive`
- [ ] Topic: `terminal:{session_id}` (distinct from `init:{session_id}`)
- [ ] Use `sse_response_with_replay()` if adding SSE endpoint (supports late subscribers)
- [ ] Add `useTerminalEvents(sessionId, onEvent, onClose)` call in frontend component
- [ ] Events: `terminal_output` (chunks), `terminal_finished`
- [ ] TerminalPanel multi-instance tabs managed in BottomPane/index.tsx
- [ ] Update `docs/how-to/use-terminal.md` if terminal behavior or UX changed

## Checklist: Adding dbt Target Support to a New Feature

- [ ] Read dbt target via `GET /api/projects/{id}/dbt-target` in frontend
- [ ] Pass target as `--target {value}` in `RunRequest.extra` tuple in backend
- [ ] Frontend: add target-aware logic to run controls (grid layout, button behavior)
- [ ] If storing per-run metadata: include target in historical record (e.g., run_invocations)
- [ ] Test with multiple profiles.yml scenarios (project-local vs global)
- [ ] Update `docs/how-to/configure-environment.md` → dbt Targets section if dropdown behavior changed

## Checklist: Updating Documentation

Run `/update-docs` after any session with code changes. Manual checklist:
- [ ] `CLAUDE.md` Database Tables matches `backend/app/db/models.py`
- [ ] `docs/architecture.md` API Routes match `backend/app/main.py` router registrations
- [ ] `docs/architecture.md` Configuration table matches `backend/app/config.py`
- [ ] `CONTRIBUTING.md` Configuration table matches above
- [ ] `README.md` Features list covers new user-facing features
- [ ] Relevant `docs/how-to/` guide updated if a user-facing flow changed
- [ ] `docs/how-to/README.md` index updated if a new guide was added

How-to guides live in `docs/how-to/`:
- `create-project.md` — New Project modal, dbt init PTY, profiles.yml setup
- `run-models.md` — Run/build/test, SidePane grid, RunPanel
- `configure-environment.md` — Env vars, targets, profiles, requirements
- `init-pipeline.md` — Init steps, scripts, env var capture
- `navigate-dag.md` — DAG view, filter bar, SidePane
- `use-file-explorer.md` — File browser, Monaco editor
- `use-terminal.md` — TerminalPanel, multi-tab sessions
