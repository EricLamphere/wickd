# Settings Conventions for wickd

## Where Settings Live in the UI

All settings must appear in one of two places in the Environment page (`frontend/src/routes/Project/Environment.tsx`):

| Setting type | UI section | Editable from |
|---|---|---|
| Global (`app_settings` table) | **Global** sub-section under the Settings tile | Global Settings modal only (read-only on Environment page) |
| Project (`projects` table columns or `ProjectEnvVar` rows) | **Project** sub-section under the Settings tile | Inline on the Environment page |

**Never add a setting only to the Global Settings modal without also listing it in the read-only Global section of the Environment page. Never add a project-level setting as a free-form env var without also listing it as a named row in the Project section.**

## Adding a New Global Setting

1. Add it as a named row in the `rows` array in `GlobalSettingsSection` in `Environment.tsx` (read-only display)
2. Add it as a named row in the `rows` array in `GlobalSettingsModal.tsx` (editable)
3. Include an `example` value for the "e.g. …" placeholder shown when unset
4. Follow the checklist in `CLAUDE.md` → "Checklist: Adding a New Global Setting"

## Adding a New Project Setting

1. Add a `ProjectSettingRow` in `ProjectSettingsSection` in `Environment.tsx`
2. Decide the backing store:
   - **`projects` table column** (structural config like `init_script_path`): save via `api.projects.updateSettings()`
   - **`ProjectEnvVar`** (runtime config passed to init scripts like `REQUIREMENTS_PATH`): save via `api.init.setEnvVar()` / `api.init.deleteEnvVar()`
3. If the setting is a `ProjectEnvVar`, clearing it (empty save) should delete the row so it doesn't appear as an empty env var in the Environment Variables section
4. Invalidate the relevant query keys after save

## UX Rules

- **Click-to-edit**: Values are clickable spans — clicking opens an inline input. No pencil buttons.
- **Keyboard**: Enter to save, Escape to cancel.
- **Unset placeholder**: Always show `e.g. <example>` (not "not set", not "default: …") when the value is empty. Every setting must have an example value.
- **Defaults**: Document the default in the example text and enforce it on save when needed (e.g. `INIT_SCRIPT_PATH` falls back to `'init'` when saved empty).
- **Read-only globals**: Show `Lock` icon, muted opacity, no click handler. Direct users to the Global Settings panel.

## Current Project Settings

| Setting | Backing store | Default | Example |
|---|---|---|---|
| `INIT_SCRIPT_PATH` | `projects.init_script_path` | `wickd/init` | `wickd/init` |
| `REQUIREMENTS_PATH` | `ProjectEnvVar` | (empty) | `/path/to/requirements.txt` |
| `WORKSPACE_PATH` | `ProjectEnvVar` | `wickd/workspace` | `analysis/scratch` |
| `PROPAGATE_TAGS` | `ProjectEnvVar` | `pii,sensitive` | `pii,sensitive` |
| `METRICFLOW_MODE` | `projects.metricflow_mode` | (empty = global default) | `off` |
| `DASHBOARDS_PATH` | `ProjectEnvVar` | `wickd/dashboards` | `wickd/dashboards` |
| `DOCS_PATH` | `ProjectEnvVar` (Markdown pages for Docs → Pages; relative to the project, may point into the git repo, e.g. `../docs`) | `docs`, else the git repo root's `docs/` | `docs` |
| `MONITOR_INTERVAL_HOURS` | `ProjectEnvVar` | (empty = off) | `6` |
| `MONITOR_SCHEDULE` | `ProjectEnvVar` (saved through PUT …/metric-monitors/settings, which validates it) | (empty = off) | `0 9 * * 1-5` |
| `DIFF_BASE_TARGET` | `ProjectEnvVar` (metric compare's "before" side; data diff's prod side, required there; the target a `git:` STATE_SOURCE is parsed for) | (empty = the active target) | `prod` |
| `METRIC_QUERY_TIMEOUT` | `ProjectEnvVar` (seconds each metric query may run before it's stopped, counted from dbt's parse; 1–3600; read by `semantic/batch.py` `query_timeout()`) | `120` | `300` |
| `METRIC_QUERY_CONCURRENCY` | `ProjectEnvVar` (metric `dbt show` processes at once, shared by all of a project's metric runs; 1–16; DuckDB/SQLite always 1; read by `semantic/show_slots.py` `query_concurrency()`) | `4` | `8` |
| `STATE_SOURCE` | `ProjectEnvVar` (slim builds' production manifest: `git:<ref>` or `path:<folder>`; Test link resolves it) | (empty = git, the repo's base branch) | `git:main` |
| `state_defer` | `ProjectEnvVar`, internal (sticky "Defer to prod": `defer` / `favor`; set from the side pane toggle / Header chip, not shown as a setting row) | (empty = off) | `defer` |

## Current Global Settings

| Setting | Key | Example |
|---|---|---|
| `WICKD_DBT_PROJECTS_PATH` | `dbt_projects_path` (comma-separated list allowed) | `/home/user/dbt-projects, /home/user/work/dbt` |
| `WICKD_GLOBAL_REQUIREMENTS_PATH` | `global_requirements_path` | `/home/user/dbt-projects/requirements.txt` |
| `WICKD_DBT_CORE_VERSION` | `dbt_core_version` | `1.10.13` |
| `WICKD_PYTHON_PATH` | `python_path` | `/opt/homebrew/bin/python3.12` |
| `WICKD_LOG_LEVEL` | `log_level` | `INFO` |
| `WICKD_AI_MODEL` | `ai_model` | `qwen3.5-4b` |
| `WICKD_AI_ENDPOINT_URL` | `ai_endpoint_url` | `http://localhost:11434` |
| `WICKD_AI_ENDPOINT_MODEL` | `ai_endpoint_model` | `qwen3:8b` |
| `WICKD_METRICFLOW_MODE` | `metricflow_mode` | `auto` |
| `WICKD_SHARED_DOCS_PATHS` | `shared_docs_paths` (comma-separated absolute folders; validated on save) | `/home/user/dbt/docs` |
