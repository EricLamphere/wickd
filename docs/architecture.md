# wickd Architecture

wickd is a local-first web UI that wraps dbt-core. It runs as a local dev server pair (FastAPI + Vite), discovers dbt projects from a configured workspace directory, and provides a live-updating DAG view with run/build/test controls, an integrated terminal, an in-browser SQL editor, a PTY-backed `dbt init` terminal, and a native docs browser.

---

## High-Level Stack

| Layer | Technology | Why |
|---|---|---|
| Backend | FastAPI (Python 3.11+) | Async, native SSE/streaming, simple subprocess management |
| dbt execution | `subprocess` calling the venv `dbt` binary | Safe — avoids dbt Python API global state issues; one process per invocation; always uses the isolated dbt venv (`data/dbt-venv` in dev, OS user-data dir in the packaged app — see `dbt_venv_dir` in Configuration) |
| Manifest parsing | Custom JSON parser over `manifest.json` | Direct, version-agnostic parsing of dbt's output artifacts |
| File watching | `watchfiles` (Rust-backed) | Low-overhead, async-friendly, debounced |
| Live push | Server-Sent Events (SSE) via `sse-starlette` | One-way server→client is sufficient; simpler than WebSockets; built-in browser reconnect |
| Database | SQLite via SQLAlchemy async + `aiosqlite` | Zero-ops, file-based, sufficient for single-user local tool |
| Frontend | React 18 + Vite + TypeScript | Standard SPA stack |
| DAG rendering | `@xyflow/react` + `dagre` | Interactive graph with automatic LR layout |
| SQL editor | `@monaco-editor/react` | Full editor experience in-browser |
| Terminal | `xterm.js` + `xterm-addon-fit` | PTY output rendering for integrated terminal and `dbt init` |
| Styling | Tailwind CSS | Utility-first, fast iteration |
| Data fetching | TanStack Query | Cache invalidation on SSE events; no manual refetch logic |
| Interactive init / terminal | `ptyprocess` | Full PTY for `dbt init`'s interactive prompts and integrated bash terminal |

---

## Repository Layout

```
wickd/
├── backend/
│   ├── app/
│   │   ├── main.py                  # FastAPI app, lifespan, SPA mount
│   │   ├── config.py                # Pydantic settings (env vars, paths)
│   │   ├── logging_setup.py         # structlog configuration
│   │   ├── api/
│   │   │   ├── projects.py          # /api/projects — list, get, rescan, ensure-profiles-yml; returns dbt_project_yml + profiles_yml
│   │   │   ├── models.py            # /api/projects/{id}/models — DAG, create, compile, show, profile
│   │   │   ├── runs.py              # /api/projects/{id}/run|build|test (loads dbt_target from project_env_vars → --target)
│   │   │   ├── sql.py               # /api/projects/{id}/models/{uid}/sql GET/PUT
│   │   │   ├── files.py             # /api/projects/{id}/files — file browser
│   │   │   ├── docs.py              # /api/projects/{id}/docs — native docs browser
│   │   │   ├── env.py               # /api/projects/{id}/profiles + dbt-targets + dbt-target (R/W)
│   │   │   ├── init.py              # /api/projects/{id}/init — steps, pipeline, PTY session
│   │   │   ├── workspace.py         # /api/projects/{id}/workspace — SQL scratchpad compile/run/path
│   │   │   ├── terminal.py          # /api/terminal — integrated bash PTY sessions
│   │   │   ├── settings.py          # /api/settings — global app config (dbt_projects_path, python_path, …)
│   │   │   ├── setup.py             # /api/setup — first-run wizard save + seed_setup_completed() for pre-wizard installs
│   │   │   ├── events.py            # /api/projects/{id}/events — SSE endpoint
│   │   │   ├── debug.py             # /api/projects/{id}/debug — runs dbt debug, parses output into structured checks
│   │   │   ├── drift.py             # /api/projects/{id}/drift — schema drift check (batched dbt show vs manifest columns); /drift/{id}/recheck re-probes one model
│   │   │   ├── health_summary.py    # /api/projects/{id}/health/summary — status of connection/drift/freshness for the Health overview, tab badges and nav dot (logic in app/health/summary.py)
│   │   │   ├── document.py          # /api/projects/{id}/models/{uid}/document/propose — docs generator (stub `- name:` entries in schema YAML), as a reviewable proposal
│   │   │   ├── freshness.py         # /api/projects/{id}/freshness — dbt source freshness, backgrounded snapshot
│   │   │   ├── column_lineage.py    # /api/projects/{id}/column-lineage — backgrounded, parallel column-level lineage scan
│   │   │   ├── propagation.py       # /api/projects/{id}/propagate/* + /lineage/tag-flow — inherited descriptions and tag flow (Pro; engine in wickd_pro via app/propagation/pro.py)
│   │   │   ├── test_gaps.py         # /api/projects/{id}/test-gaps + /ai/tests/batch — riskiest untested columns and a batch tests proposal (Pro; ranking in wickd_pro via app/test_targets/pro.py)
│   │   │   ├── refactor.py          # /api/projects/{id}/refactor + Wicky refactor requests — rename model / rename column / extract CTE (Pro; engine in wickd_pro via app/refactor/pro.py)
│   │   │   ├── ai_proposal_apply.py # /api/projects/{id}/ai/proposals/{pid}/accept (whole proposal at once) + /undo (file ops in app/ai/file_ops.py)
│   │   │   ├── performance.py       # /api/projects/{id}/node-durations (Base) + run analysis / project performance (Pro; analysis in wickd_pro via app/performance/pro.py)
│   │   │   ├── semantic.py          # /api/projects/{id}/semantic/* (status, catalog, explain, query, Health check) + /metricflow/{plan,apply,verify}-dbt-change — semantic layer (Base; MetricFlow sidecar in app/semantic/)
│   │   │   ├── exports.py           # /api/projects/{id}/exports/dag, /exports/dashboard + /api/exports/default-dir, /reveal — writes DAG exports to a user-chosen folder (path validation in app/exports/paths.py)
│   │   │   └── health.py            # /api/health
│   │   ├── db/
│   │   │   ├── engine.py            # Async SQLAlchemy engine, SessionLocal, get_session
│   │   │   ├── models.py            # ORM: 12 tables (see Database Schema below)
│   │   │   └── migrations.py        # DDL-on-startup migrations (idempotent; no Alembic)
│   │   ├── dbt/
│   │   │   ├── manifest.py          # Parse target/manifest.json → nodes + edges (incl. semantic_model / metric / saved_query nodes)
│   │   │   ├── semantic_nodes.py    # semantic_models / metrics / saved_queries → the `semantic` dict on graph nodes (defensive across dbt 1.7–1.12 and both YAML specs)
│   │   │   ├── run_results.py       # Parse target/run_results.json → statuses + per-node timing (execute window, thread, adapter_response), elapsed_time, threads
│   │   │   ├── runner.py            # DbtRunner singleton; subprocess + asyncio.Lock per project; .run() for silent invocations
│   │   │   ├── select.py            # Build --select strings (only/upstream/downstream/full)
│   │   │   ├── venv.py              # venv_dbt/venv_pip/venv_python — resolve binaries in settings.dbt_venv_dir; self-provisions the venv from the python_path setting on first use; rebuilds when it changes
│   │   │   ├── python_env.py        # python_path global setting — seeded at startup, mirrored into venv.py
│   │   │   ├── init_scripts.py      # Read/write init/*.sh custom scripts
│   │   │   ├── debug_parser.py      # Parse dbt debug stdout → structured DebugResult with per-check status
│   │   │   ├── drift.py             # diff_columns / is_eligible_for_drift_check — column drift helpers
│   │   │   ├── probe.py             # probe_warehouse_columns() — actual column names via dbt show --inline (drift + docs generator); probe_many_warehouse_columns() — many nodes in one dbt show via adapter.get_columns_in_relation (drift)
│   │   │   ├── schema_yaml.py       # document_node() — splices `- name:` entries into the node's schema YAML without re-serialising it
│   │   │   ├── column_lineage.py    # SQL-first column lineage (sqlglot); LineageJob prep + trace_job (poolable worker fn)
│   │   │   ├── profile.py           # Parse dbt show --output json output into column profile stats
│   │   │   ├── show_parser.py       # parse_show_json() — handles dbt 1.5+ and 1.11+ show output formats
│   │   │   └── interactive.py       # InteractiveInitManager singleton (PTY sessions; reused for terminal)
│   │   ├── git/
│   │   │   ├── runner.py            # GitRunner singleton; subprocess + asyncio.Lock per project
│   │   │   └── repo.py              # find_repo_root, parse_porcelain_v2, BranchInfo / FileChange dataclasses
│   │   ├── events/
│   │   │   ├── bus.py               # In-process pub/sub EventBus singleton
│   │   │   └── sse.py               # SSE response helpers (standard + with-replay)
│   │   ├── projects/
│   │   │   ├── discovery.py         # Walk workspace for dbt_project.yml; infer platform
│   │   │   └── service.py           # list_projects, rescan_projects; _effective_workspace()
│   │   ├── semantic/                # Semantic layer (Base): MetricFlow in a dbt-free sidecar venv
│   │   │   ├── sidecar_env.py       # <data_dir>/metricflow-venv with the pinned engine (ENGINE_VERSION); rebuilt when the pin or interpreter changes (.wickd-metricflow)
│   │   │   ├── worker_main.py       # STANDALONE worker run by the sidecar's Python (no app imports; PyInstaller data file): JSON lines — ping/load/catalog/explain/dimension_values/validate
│   │   │   ├── runtime.py           # MetricFlowRuntime singleton: lazy start (builds the sidecar), idle stop, request ids, restart once on crash
│   │   │   ├── service.py           # target-path aware semantic_manifest.json + dialect → worker calls; dbt_environment() (cached dbt --version)
│   │   │   ├── execute.py           # run_sql(): MetricFlow SQL through `dbt show --inline` (runner lock, timeout, own-LIMIT wrapping)
│   │   │   ├── status.py            # semantic_status(): available / can_query / mode / reason / compatible versions; YAML spec detection cache
│   │   │   ├── compat.py            # check(dbt_core, python, uses_latest_spec, want_cli) + recommend(); table in compat_data.py (generated by scripts/metricflow_compat.py)
│   │   │   ├── spec.py              # legacy / latest / mixed / none from schema YAML
│   │   │   ├── pins.py              # dbt-core pins in requirements files: find, would_undo, rewrite (pure)
│   │   │   ├── dbt_change.py        # pip dry-run plan, pin updates and install args for the version dialog
│   │   │   ├── check.py             # Health check run: validate (+ LIMIT 0 per metric with warehouse) → SemanticCheckSnapshot
│   │   │   ├── autoparse.py         # debounced silent `dbt parse` after YAML edits in projects with a semantic layer
│   │   │   ├── query_spec.py        # check_query()/check_where(): metric names exist, `where` = MetricFlow templates + a plain SQL condition (no Jinja blocks, comments, `;`, subqueries); checked_sql() re-checks MetricFlow's SQL is one read-only SELECT
│   │   │   ├── query_service.py     # run_metric_query(): validate → explain → cache (refresh/prefer/only) → one shared, shielded `dbt show` per key → store
│   │   │   ├── query_cache.py       # metric_query_results: key (project, target, env fingerprint, sql hash); lookup()/store(), last 100 per project
│   │   │   ├── batch.py             # run_many(): N queries in one `dbt show` (Jinja run_query + WICKD_METRIC_BATCH lines), resumes after a failing statement; for dashboards/monitors
│   │   │   ├── saved_queries.py     # Save as saved query: choose the YAML file, date range → metric_time filters
│   │   │   ├── pro.py               # shim over private wickd_pro.semantic (semantic drafts: facts, heuristic + LLM draft, manifest JSON, YAML items; SemanticDraftUnavailable)
│   │   │   └── mode.py              # metricflow_mode: project ('' / auto / off) over the global default
│   │   └── watcher/
│   │       └── service.py           # ONE shared watchfiles watcher thread for all projects; routes changes to bus.publish per project; YAML changes schedule semantic autoparse
│   ├── pyproject.toml
│   └── tests/
├── frontend/
│   ├── src/
│   │   ├── main.tsx                 # React entry point
│   │   ├── App.tsx                  # BrowserRouter + route definitions
│   │   ├── lib/
│   │   │   ├── api.ts               # fetch wrappers + typed API helpers
│   │   │   └── sse.ts               # useProjectEvents, useInitSessionEvents, useTerminalEvents
│   │   ├── components/
│   │   │   ├── Header.tsx           # Persistent nav; back/forward arrows (NavArrows.tsx); Profile + Target dropdowns on project pages (reads projectId from pathname)
│   │   │   ├── HomeCommandPalette.tsx # ⌘K palette for Home.tsx — open project by name, new project, rescan, global settings
│   │   │   └── StatusBadge.tsx      # Status color chip
│   │   └── routes/
│   │       ├── Home.tsx             # Project list, search, rescan, new project modal, global settings modal; own ⌘K listener → HomeCommandPalette
│   │       └── Project/
│   │           ├── ProjectLayout.tsx    # Shared layout (BottomPane + <Outlet overflow-auto>); global ⌘K listener; CommandPaletteContext
│   │           ├── lib/
│   │           │   ├── commandPaletteContext.tsx # React context (CommandPaletteContext) + useCommandPalette() hook
│   │           │   ├── selectedNodeContext.tsx   # Selected node lifted to ProjectLayout; useReportSelectedNode() (DAG + Files pages)
│   │           │   ├── nodeLineage.ts            # buildNodeLineageGraph() — +uid+ subgraph for the Node DAG tab
│   │           │   ├── impact.ts                 # computeImpact(graph, seedIds) — downstream nodes by depth, test counts, risk flags; buildImpactSelector()
│   │           │   └── bottomPaneEvents.ts       # openBottomTab() window event so the SidePane can open a bottom pane tab
│   │       │   └── testCoverage.ts # Test coverage utility; buildCoverageMap(), getModelCoverageStats(), bucketFor(), badgeClassesFor(); derives per-column test counts
│   │           ├── components/
│   │           │   └── CommandPalette.tsx # VS Code-style palette (z-[60]); nav + project actions + model search + send typed text to Wicky
│   │           ├── index.tsx            # Project home: tiles + tabbed README/dbt_project.yml/profiles.yml viewer
│   │           ├── Models.tsx           # React Flow DAG with real-time run overlays; ?model= = selected node (in back/forward history); SidePane; DagFilterBar
│   │           │                        #   DagFilterBar: text selector (+model, tag:x), Type/Materialization/Tag/Status dropdowns; optional Coverage overlay
│   │           │                        #   Coverage: per-column test count heatmap; derives from GraphDto client-side; persists toggle state per-project
│   │           ├── Docs.tsx             # Native docs browser (folder tree)
│   │           ├── Metrics/             # Metrics page: MetricsSidebar, QueryBar + FilterEditor, ResultsPane (Chart / Table / SQL), MetricChart (Recharts, colours from --series-N), MetricsUnavailable, ExploreButton + MetricPreview; lib/metricQuery.ts (URL ⇄ state ⇄ request), lib/metricSeries.ts (small multiples, top 8 series), lib/exploreLink.ts, lib/openInWorkspace.ts — all lib/ tested
│   │           ├── Environment.tsx      # Env vars + profiles
│   │           ├── InitScripts.tsx      # Init pipeline management
│   │           ├── Health.tsx           # Health page: Overview (default) + Connection + Schema Drift + Test Gaps (Pro) + Source Freshness tabs, each check tab with a status badge
│   │           ├── FileExplorer/        # File browser + Monaco editor; SidePane replaces old tab bar
│   │           ├── Git/                 # Source Control page (VSCode-style SCM)
│   │           ├── Workspace/           # SQL Workspace — file tree + Monaco editor + results pane + autocomplete
│   │           └── components/
│   │               ├── BottomPane/
│   │               │   ├── index.tsx        # Drag-to-resize pane; tab management; terminal instances
│   │               │   ├── RunPanel.tsx     # Execution DAG (real-time run_log parsing); shows full-run notice when no model selected
│   │               │   ├── NodeDagPanel.tsx # Node DAG: +node+ lineage of the selected node (SelectedNodeContext), centered on it
│   │               │   ├── ImpactPanel.tsx  # Impact: toolbar (selector, counts, flags, Build impacted / Copy selector) + ImpactTable
│   │               │   ├── ImpactTable.tsx  # Impact list: sticky column + per-depth group headers; tests, column coverage bar, flags
│   │               │   ├── TerminalPanel.tsx # xterm.js multi-instance terminal; only resizes PTY when dims change
│   │               │   └── LogPanel.tsx     # Project and API logs
│   │               ├── NavRail.tsx          # Collapsible left nav sidebar (persists collapsed state in localStorage; resizable when expanded)
│   │               ├── ProjectNav.tsx       # Nav items (DAG/Files/Docs/Workspace/Git/Environment/Init/Health); icon-only mode when collapsed
│   │               ├── HealthCheckPanel.tsx # dbt debug runner — shows per-check status table, version info, raw log
│   │               ├── DriftPanel.tsx       # Schema drift UI — header (target, checked/skipped), stale notice, progress; results in drift/ (DriftResults: search, filters, Drifted/Not built/Errors/In sync groups; ModelDriftRow: re-check, Build model, Open YAML, Document columns)
│   │               ├── semantic/            # Semantic layer: SemanticLayerPanel (Health → Semantic Layer), SemanticIssues (grouped validation results, Open YAML), MetricFlowCompatDialog + ChangePreview (pick a compatible dbt-core or continue without; compatDialog.ts, tested), useSemantic.ts (status / latest check / sidecar progress / project mode), semanticView.ts (tested)
│   │               ├── health/              # Shared Health pieces: HealthOverview (cards + Run all; TestGapsCard for Pro test gaps), useHealth.ts (useHealthSummary, useHealthRuns — keyed mutations shared across views), healthStatus.ts (badge/nav-dot logic), StaleNotice, RunButton, Spinner; TestGapsPanel.tsx + useTestGaps.ts + testGapsView.ts (Test Gaps tab, Pro)
│   │               ├── SidePane/
│   │               │   ├── index.tsx        # Right-side collapsible panel (drag/collapse); tabs: Properties, Profile
│   │               │   ├── PropertiesTab.tsx # Model metadata; Refs/Sources + Referenced By as cmd+clickable chips; run controls; action buttons
│   │               │   └── ProfilePanel.tsx  # Column profile stats for a model via dbt show (min/max/nulls/distinct/sample)
│   │               ├── ModelNode.tsx
│   │               ├── NewProjectModal.tsx  # dbt init PTY terminal; writes profiles.yml after rescan
│   │               ├── DagFilterBar.tsx     # filter bar: text selector + dropdown pills + Clear + node count
│   │               ├── CoverageLegend.tsx  # Test coverage legend; shows 4 coverage buckets (untested/1 test/2 tests/3+ tests) rendered as ReactFlow Panel
│   ├── vite.config.ts               # Dev proxy → :8001; prod build output
│   └── tailwind.config.ts
├── docs/
│   └── architecture.md              # This file
├── data/                            # SQLite database (git-ignored)
└── Taskfile.yml
```

---

## Database Schema

12 tables, all in `backend/app/db/models.py`:

```
projects
  id                INTEGER PK
  name              TEXT(255)          -- from dbt_project.yml "name:"
  path              TEXT(1024) UNIQUE  -- absolute path to project directory
  platform          TEXT(64)           -- inferred from profiles.yml (postgres, duckdb, …)
  profile           TEXT(255)          -- value of dbt_project.yml "profile:"
  vscode_cmd        TEXT(255)          -- optional custom VS Code launch command
  init_script_path  TEXT(255)          -- subdirectory for init scripts (default "init/")
  ignored           BOOLEAN            -- when true, project is hidden from the project list
  metricflow_mode   TEXT(16)           -- '' = global default (app_settings metricflow_mode), 'auto' or 'off'
  created_at        DATETIME

init_steps
  id            INTEGER PK
  project_id    INTEGER FK→projects
  name          TEXT(255)        -- display name
  order         INTEGER          -- execution order
  script_path   TEXT(1024)       -- absolute path for linked external scripts
  is_base       BOOLEAN          -- True for built-in steps (dbt deps)
  enabled       BOOLEAN
  UNIQUE (project_id, name)

model_statuses
  id            INTEGER PK
  project_id    INTEGER FK→projects
  unique_id     TEXT(512)        -- dbt unique_id (model.project.name)
  kind          TEXT(32)         -- "model" or "test"
  status        TEXT(32)         -- idle | pending | running | success | error | warn | stale
  message       TEXT             -- error message if applicable
  started_at    DATETIME
  finished_at   DATETIME
  UNIQUE (project_id, unique_id)

run_invocations
  id            INTEGER PK
  project_id    INTEGER FK→projects
  command       TEXT(64)         -- run, build, test, or any dbt subcommand (custom commands)
  selector      TEXT(1024)       -- dbt --select string
  status        TEXT(32)         -- pending | success | error
  log_path      TEXT(1024)
  started_at    DATETIME
  finished_at   DATETIME
  custom_args   TEXT             -- JSON list of user-entered args for custom commands (null otherwise); replayed on rerun
  threads       INTEGER          -- --threads from run_results.json args (else distinct thread ids); null before timing capture
  elapsed_time  REAL             -- dbt's own elapsed_time from run_results.json

invocation_model_results         -- per-node history per invocation (last 20 rows per node kept)
  id                    INTEGER PK
  invocation_id         INTEGER FK→run_invocations
  project_id            INTEGER FK→projects
  unique_id             TEXT(512)
  name                  TEXT(255)
  kind                  TEXT(32)     -- "model" or "test"
  status                TEXT(32)
  execution_time        REAL
  message               TEXT
  started_at            DATETIME     -- execute step window from run_results.json timing (compile step if execute is missing)
  completed_at          DATETIME
  thread_id             TEXT(128)    -- e.g. "Thread-1 (worker)"
  rows_affected         INTEGER      -- from adapter_response
  bytes_processed       INTEGER      -- from adapter_response (BigQuery)
  adapter_response_json TEXT         -- raw adapter_response, capped ~2 KB (scalars only when larger)

env_profiles
  id            INTEGER PK
  project_id    INTEGER FK→projects
  name          TEXT(255)

profile_env_vars
  id            INTEGER PK
  profile_id    INTEGER FK→env_profiles
  key           TEXT(255)
  value         TEXT

project_env_vars
  id            INTEGER PK
  project_id    INTEGER FK→projects
  key           TEXT(255)
  value         TEXT
  -- Well-known keys:
  --   dbt_target        active dbt target; passed as --target on every invocation
  --   REQUIREMENTS_PATH path to project-specific requirements.txt
  --   WORKSPACE_PATH    relative path to SQL workspace dir (default "workspace")
  --   PROPAGATE_TAGS    comma-separated tags the Docs Tags tab traces through lineage (default "pii,sensitive")
  --   DASHBOARDS_PATH   folder (inside the project) for metric dashboard YAML files (default "wickd/dashboards")
  --   MONITOR_INTERVAL_HOURS  metric monitors' automatic check while wickd is open (Pro; whole hours ≥ 1, unset = off)
  --   Any KEY=value exported by an init script is upserted here automatically

app_settings
  key           TEXT PK          -- e.g. "dbt_projects_path", "global_requirements_path"
  value         TEXT

global_env_vars                  -- defaults for every project + global setup's pip; overridden by the active profile, then project_env_vars
  id            INTEGER PK
  key           TEXT(255) UNIQUE
  value         TEXT

global_profiles
  id            INTEGER PK
  name          TEXT(255) UNIQUE -- display name
  created_at    DATETIME

global_profile_vars
  id            INTEGER PK
  profile_id    INTEGER FK→global_profiles
  key           TEXT(255)
  value         TEXT
  UNIQUE (profile_id, key)

drift_snapshots
  id              INTEGER PK
  project_id      INTEGER FK→projects (CASCADE)
  started_at      DATETIME
  finished_at     DATETIME (nullable)
  status          TEXT(32)   -- running | done | error
  target          TEXT(255) (nullable)  -- dbt target used during the scan
  total_models    INTEGER    -- number of eligible models
  checked_models  INTEGER    -- models processed so far (progress)
  results_json    TEXT       -- JSON array of ModelDriftResult objects (incl. not_built, yaml_path)
  error_message   TEXT (nullable)
  skipped_json    TEXT       -- {materialization: count} of models the scan skipped (views, ephemeral, …)
  -- Interrupted snapshots (status='running') are reset to 'error' on server restart

freshness_snapshots
  id              INTEGER PK
  project_id      INTEGER FK→projects (CASCADE)
  started_at      DATETIME
  finished_at     DATETIME (nullable)
  status          TEXT(32)   -- running | done | error
  target          TEXT(255) (nullable)  -- dbt target used during the scan
  results_json    TEXT       -- JSON array of SourceFreshnessResult objects
  error_message   TEXT (nullable)

column_lineage_snapshots
  id              INTEGER PK
  project_id      INTEGER FK→projects (CASCADE)
  started_at      DATETIME
  finished_at     DATETIME (nullable)
  status          TEXT(32)   -- running | done | error
  total_models    INTEGER    -- number of models needing lineage (jobs)
  checked_models  INTEGER    -- jobs completed so far (progress)
  results_json    TEXT       -- JSON {downstream_uid: {column: [{node, column}, ...]}}
  error_message   TEXT (nullable)
  manifest_mtime  REAL       -- mtime of target/manifest.json this snapshot was computed from;
                             -- used to short-circuit a re-scan when the manifest hasn't changed
  row_dependencies_json TEXT -- JSON {uid: [{node, column}, ...]}: upstream columns each model filters / joins /
                             -- groups on (WHERE, JOIN ON/USING, GROUP BY, HAVING, QUALIFY), i.e. which rows it has
  lineage_version INTEGER    -- 1 = projection lineage only; 2 = also row dependencies; 3 = also a transform `kind`
                             -- (identity | rename | cast | derived) on each results_json ref; 4 = also join_keys_json.
                             -- The short-circuit only reuses a snapshot whose version matches what a scan would produce now
  join_keys_json  TEXT       -- JSON {uid: {join_pairs: [{left: {node, column}, right: {node, column}, type}],
                             -- grain: {columns, via: group_by | distinct | dedupe} | null}} (lineage_version 4; test suggestions)
  -- Interrupted snapshots (status='running') are reset to 'error' on server restart

metric_query_results       -- Metrics page result cache (semantic/query_cache.py)
  project_id      INTEGER FK → projects (cascade)
  target          TEXT       -- DBT_TARGET the query ran with ('' = profile default)
  env_fingerprint TEXT       -- sha256 of the env vars wickd layers in (global → profile → project + target) and of the profiles.yml dbt reads; never the values
  sql_hash        TEXT       -- sha256 of MetricFlow's SQL (changes when definitions do)
  profile_name    TEXT       -- active global profile, for display
  metrics_json, group_by_json, columns_json, rows_json (≤ 5000 rows), truncated, ran_at, elapsed_ms
  UNIQUE(project_id, target, env_fingerprint, sql_hash); last 100 per project kept

metric_monitors            -- Pro: metrics watched for anomalies (semantic/monitors.py)
  project_id      INTEGER FK → projects (cascade)
  metric, grain (day|week|month), dimension (nullable; slice by its top 10 values)
  sensitivity     TEXT       -- low | normal | high
  lookback        INTEGER    -- periods of history kept and loaded on the first check (default 180 / 52 / 24)
  enabled         BOOLEAN
  target          TEXT       -- pinned dbt target, NULL = the active one
  slices_json, slices_refreshed_at  -- top slice values, recomputed weekly
  last_result_json, last_checked_at -- latest detection summary (kept when a build-triggered check skips the monitor)
  position        INTEGER    -- order on the Monitors tab (drag to reorder; new monitors go last)

metric_monitor_points      -- a monitor's history per target and slice ('' = unsliced)
  monitor_id      INTEGER FK → metric_monitors (cascade)
  target, slice, period (YYYY-MM-DD, the period's start), value
  previous_value  REAL       -- the value it replaced, set only when that one was stored after the period ended (a restatement)
  suppressed      BOOLEAN    -- "mark as expected": never flagged, left out of baselines
  observed_at     DATETIME
  UNIQUE(monitor_id, target, slice, period); trimmed to the lookback

metric_monitor_runs        -- one check: trigger build | manual | interval
  project_id, target, status (running|done|error), trigger, monitors_json, results_json (per monitor summary + flagged points), error_message, started_at, finished_at

semantic_check_snapshots
  id              INTEGER PK
  project_id      INTEGER FK→projects (CASCADE)
  started_at      DATETIME
  finished_at     DATETIME (nullable)
  status          TEXT(32)   -- running | done | error
  results_json    TEXT       -- {errors, warnings, future_errors: [{level, message, object_type, object_name, element_type, element_name}],
                             --  warehouse: [{metric, ok, error}] | null}
  error_message   TEXT (nullable)
  manifest_hash   TEXT       -- sha1 of semantic_manifest.json when the check started; the summary flags the result stale once it differs

test_gap_ignores
  id              INTEGER PK
  project_id      INTEGER FK→projects (CASCADE)
  key             TEXT        -- Test gaps row key: "<unique_id>::<column>" or "<unique_id>::(a, b)"; UNIQUE(project_id, key)
  unique_id       TEXT
  name            TEXT        -- model name and column label, kept to list the row after the gap itself is gone
  label           TEXT
  created_at      DATETIME
  -- ignored rows are left out of GET /test-gaps (and its count) until unignored

license_state
  id              INTEGER PK  -- always 1, single-row cache for this installation
  license_key     TEXT (nullable)   -- Polar license key, or null if unset
  activation_id   TEXT(64) (nullable)  -- Polar device activation id for this install
  device_id       TEXT(64)          -- stable per-install device id (uuid4 hex), generated once
  entitled        BOOLEAN default false
  status          TEXT(32) default 'unset'  -- unset | granted | not_entitled | ... (mirrors Polar's status)
  checked_at      DATETIME (nullable)  -- last time entitlement was checked against Polar
  customer_id     TEXT (nullable)  -- Polar customer id, captured from validate(); required to cancel a subscription
  license_key_id  TEXT (nullable)  -- Polar's internal id for this key (not the key string), captured from validate(); required to look up activation count
  limit_activations INTEGER (nullable)  -- max devices allowed on this key (from Polar's "Limit Activations" benefit); null means unlimited

ai_conversations                     -- Ask-mode chat threads (wickd Pro AI)
  id              INTEGER PK
  project_id      INTEGER FK→projects (CASCADE)
  title           TEXT(255)  -- first question, truncated
  created_at / updated_at  DATETIME

ai_messages
  id              INTEGER PK
  conversation_id INTEGER FK→ai_conversations (CASCADE)
  role            TEXT(16)   -- user | assistant | action (a quick action run from the chat) | query (SQL Wicky wrote)
  content         TEXT
  unique_id       TEXT(512) (nullable)  -- node selected when asked (its context was sent to the model)
  proposal_id     INTEGER FK→ai_proposals (SET NULL, nullable)  -- for role 'action': the proposal it produced
  payload_json    TEXT (nullable)  -- for role 'query': {question, sql, explanation, status, error, columns, rows, truncated}; waiting/running reset to error on restart
  created_at      DATETIME

ai_proposals                         -- AI-generated file changes awaiting review
  id              INTEGER PK
  project_id      INTEGER FK→projects (CASCADE)
  kind            TEXT(32)   -- document | tests | propagate | refactor
  unique_id       TEXT(512) (nullable)
  title           TEXT(255)
  status          TEXT(16)   -- generating | ready | applied | rejected | dismissed | error | empty (nothing needed changing) | undone
  error_message   TEXT (nullable)
  result_json     TEXT       -- what the AI produced, kept for chat history: {description, columns: {name: text}} or {tests: [{column, test, reason, values?, to?, field?, failures}]}; refactors: {summary, manual: [{path, line, text, reason}], notes, verify: {status: running | ok | error, output}}
  created_at / updated_at  DATETIME
  -- Proposals still 'generating' are reset to 'error' on server restart

ai_proposal_files
  id              INTEGER PK
  proposal_id     INTEGER FK→ai_proposals (CASCADE)
  path            TEXT(1024) -- relative to the project root
  original_text   TEXT (nullable)  -- file content the proposal was made against; null = new file
  proposed_text   TEXT             -- rename: the text written at new_path
  status          TEXT(16)   -- pending | accepted | rejected | undone
  op              TEXT       -- modify | create | delete | rename (default modify; a legacy modify with no original_text is a create)
  new_path        TEXT (nullable)  -- rename target
  applied_text    TEXT (nullable)  -- what accepting wrote; Undo restores only while the file still holds it
```

---

## API Routes

```
GET    /api/health

GET    /api/settings
PUT    /api/settings
POST   /api/setup/complete                               first-run wizard: validate + save projects path, python, requirements, dbt-core version, theme, global env vars (optional; replaces the set); mark setup_completed. The chosen dbt-core (`dbt_core_version`, "" = latest) seeds a new requirements file, is appended to an existing one that doesn't list dbt-core, or (no file) is saved as the dbt_core_version setting
GET    /api/setup/dbt-core-versions                      stable dbt-core releases from PyPI, newest first (`{versions, latest}`; cached 1h; 502 if PyPI is unreachable)
GET    /api/setup/requirements-file?path=                `{exists, dbt_core_line}` — whether a requirements file exists and already lists dbt-core (read-only; drives the wizard's version picker)
GET    /api/settings/python-interpreters                 list Python 3.11+ installs for the WICKD_PYTHON_PATH dropdown

GET    /api/projects
POST   /api/projects/rescan
GET    /api/projects/summaries                           node-type counts + latest run for every project (home page cards, one request; manifest counts cached by mtime)
GET    /api/projects/search?q=&limit=                    model/source/seed/snapshot/exposure names + column names across non-ignored projects (home search + ⌘K); ranked exact > prefix > substring, names before columns, root package before installed packages; per-manifest index cached by mtime; returns hits, truncated, unindexed_project_ids (no manifest yet)
GET    /api/projects/{id}                                includes readme, dbt_project_yml, profiles_yml
POST   /api/projects/{id}/ensure-profiles-yml            writes minimal profiles.yml if absent
PATCH  /api/projects/{id}/settings

GET    /api/projects/{id}/events                         SSE

GET    /api/projects/{id}/models                         graph: nodes, edges, unit_tests (dbt 1.8+ unit tests, kept out of nodes)
POST   /api/projects/{id}/models
GET    /api/projects/{id}/models/{unique_id}
DELETE /api/projects/{id}/models/{unique_id}
POST   /api/projects/{id}/compile
GET    /api/projects/{id}/models/{unique_id}/compiled    on-demand compile + return compiled SQL
POST   /api/projects/{id}/models/{unique_id}/show        run dbt show, return rows
POST   /api/projects/{id}/models/{unique_id}/profile    run dbt show (full table), return column profile stats
POST   /api/projects/{id}/models/{unique_id}/document/propose   add `- name:` entries for the node + columns to its schema YAML (body `{columns}`; null → probe the warehouse), as an `ai_proposals` row of kind `document_stub` (status ready, or empty with a note when nothing is missing) for the review window; Base — reviewing/accepting it needs no Pro license (`BASE_KINDS` in app/ai/gating.py); accepting compiles the node
GET    /api/projects/{id}/models/{unique_id}/sql
PUT    /api/projects/{id}/models/{unique_id}/sql
POST   /api/projects/{id}/column-lineage/start            start async column lineage scan (202, or 200 if a fresh snapshot already exists); returns ColumnLineageSnapshot — Pro feature, 403 if not entitled
GET    /api/projects/{id}/column-lineage                 get the latest ColumnLineageSnapshot for a project — Pro feature, 403 if not entitled
GET    /api/projects/{id}/column-lineage/{snapshot_id}   get a specific ColumnLineageSnapshot by id — Pro feature, 403 if not entitled
GET    /api/projects/{id}/propagate/descriptions?unique_id=&include_casts=true  Pro: how many empty column descriptions lineage could fill `{fillable, conflicts, by_node}`; 409 `{error: lineage_not_ready, reason: missing|running|outdated|error}` until a lineage_version 3 snapshot exists
POST   /api/projects/{id}/propagate/descriptions         Pro: build a "propagate" proposal filling those descriptions (body `{unique_ids?, include_casts}`); 202, then `ai_proposal_updated`
GET    /api/projects/{id}/lineage/tag-flow?tag=          Pro: every column / exposure carrying data from columns tagged `tag` (default: first of PROPAGATE_TAGS) `{tag, tags, columns, exposures}`; 409 as above
POST   /api/projects/{id}/propagate/tags                 Pro: build a "propagate" proposal adding inherited tags to columns' YAML (body `{tag?}`; default every PROPAGATE_TAGS tag); 202
POST   /api/projects/{id}/exports/dashboard              same body and responses as exports/dag, for a dashboard export (html | png)
POST   /api/projects/{id}/exports/dag                    write a DAG export the frontend rendered (body `{directory, filename, format: html|svg|png, content, encoding: utf8|base64, overwrite}`) into the chosen folder; 201 `{path, bytes}`, 400 `{field, message}` for a bad folder/name, 409 if the file exists and `overwrite` is false
GET    /api/exports/default-dir                          default export folder: ~/Downloads, else the home directory
POST   /api/exports/reveal                               show an exported file in Finder / the platform file manager (204; 404 if missing)

GET    /api/projects/{id}/files?path=                    one folder level of the project tree (all files; .git, dbt_packages, logs, venvs hidden)
GET    /api/projects/{id}/files/content?path=            read a text file (known text extensions, or a small file without NUL bytes); 400 for binary
PUT    /api/projects/{id}/files/content?path=            write a text file
POST   /api/projects/{id}/files/new                      create a file or folder (`{name, dir_path, is_dir}`); 409 if it exists
POST   /api/projects/{id}/files/rename?path=             rename in place (`{new_name}`)
POST   /api/projects/{id}/files/move                     move paths into a folder (`{paths, dest_dir}`, "" = root); all-or-nothing: 409 on a name clash, 400 for a folder into itself
POST   /api/projects/{id}/files/copy                     copy paths into a folder; clashing names get ` copy`, ` copy 2`, … (paste, duplicate)
POST   /api/projects/{id}/files/upload                   multipart files dropped from the OS (`dest_dir`, `overwrite`, `files`; a file name may carry folders); 409 on existing files unless overwrite
POST   /api/projects/{id}/files/reveal                   show a path in Finder / the platform file manager (204)
DELETE /api/projects/{id}/files?path=                    delete a file or folder (recursive)

GET    /api/ai/status                                     AI readiness: entitled, Pro package installed, llama-server found, endpoint in use, selected model, per-model download state, `ready`
POST   /api/ai/models/{model_id}/download                 start (or resume) downloading a catalog model (202); progress on the `global` topic — Pro, 403 if not entitled
DELETE /api/ai/models/{model_id}/download                 cancel a download (the partial file is kept for resume)
DELETE /api/ai/models/{model_id}                          delete a downloaded model (409 while downloading)
GET    /api/projects/{id}/ai/conversations                Ask chats, most recent first — Pro (403/503)
POST   /api/projects/{id}/ai/conversations                new chat
GET    /api/projects/{id}/ai/conversations/{cid}          chat + messages (action messages embed their proposal)
DELETE /api/projects/{id}/ai/conversations/{cid}          delete a chat
POST   /api/projects/{id}/ai/conversations/{cid}/messages body {content, unique_id?, mode: ask | explain_failure | explain_slow}; streams the answer as text/event-stream (`delta` × N, then `done` or `error`); both turns are saved
POST   /api/projects/{id}/ai/document                     body {unique_id, overwrite, conversation_id?}; records an `action` message in that chat; 202 AiProposal (status generating); generates in the background, 409 if already generating for that node
POST   /api/projects/{id}/ai/conversations/{cid}/query    body {content, unique_id?}; Wicky writes ONE read-only SELECT (not run); returns [user message, `query` message] — status proposed, or invalid if it fails app/ai/sql_guard.py
POST   /api/projects/{id}/ai/messages/{mid}/run           body {sql} (may be edited); re-validated, then `dbt show --inline --limit 101` behind the project's dbt lock (202; waiting → running → done/error via `ai_query_updated`; 120s timeout; 100 rows kept)
POST   /api/projects/{id}/ai/messages/{mid}/answer        streams an answer from a finished query's rows (text/event-stream, saved as an assistant message)
POST   /api/projects/{id}/ai/tests                        body {unique_id, conversation_id?}; 202 AiProposal (kind tests); suggests + pre-checks generic tests in the background — lineage-backed ones (join keys, grain; `source: lineage`, `evidence`) first when a lineage_version 4 snapshot exists, then the AI model's; without an AI model only the lineage-backed ones (`result.note` says so)
GET    /api/projects/{id}/test-gaps?limit=50              Pro: untested columns with evidence-backed tests, ranked by downstream reach, ignored rows left out `{snapshot_id, total, ignored, rows: [{key, unique_id, name, column, columns?, score, reach, row_uses, exposures, in_grain, existing, candidates}]}`; 409 lineage_not_ready until a lineage_version 4 snapshot exists; cached per snapshot + manifest mtime
GET    /api/projects/{id}/test-gaps/ignored               Pro: ignored rows, newest first `{rows: [{key, unique_id, name, label, ignored_at, still_a_gap (null when lineage isn't ready), candidates}]}`
POST   /api/projects/{id}/test-gaps/ignore                Pro: body {keys}; hide these rows from /test-gaps until unignored; `{changed}`; 422 when none is a current gap
POST   /api/projects/{id}/test-gaps/unignore              Pro: body {keys}; `{changed}`
POST   /api/projects/{id}/ai/semantic-draft               Pro: body {unique_id, conversation_id?}; 202 AiProposal kind semantic — Wicky drafts a semantic model + metrics (wickd_pro via app/semantic/pro.py), validated in the MetricFlow sidecar against the real semantic manifest (`validate_draft`), a LIMIT 5 smoke query per metric in one `dbt show`; YAML in the project's spec (dbt/schema_semantic.py) + a time spine when missing; `ai_proposal_progress` phases facts / writing / validating; 409 {status} when MetricFlow is off or incompatible; after applying, `dbt parse` + MetricFlow validation → result.verify
POST   /api/projects/{id}/ai/tests/batch                  Pro: body {keys} (row keys from /test-gaps); 202 AiProposal kind tests with `result.batch` — one file per schema YAML, each model pre-checked through the runner (`ai_proposal_progress` with done/total/current per model); no AI model needed
GET    /api/projects/{id}/ai/proposals?unique_id=         proposals needing attention (generating | ready | error | empty)
GET    /api/projects/{id}/ai/proposals/{pid}              one proposal with its files
DELETE /api/projects/{id}/ai/proposals/{pid}              dismiss (status → dismissed; the row is kept for chat history)
PUT    /api/projects/{id}/ai/proposals/{pid}/selection     body {keys, accepted}; keys = items kept (not rejected), accepted = those already accepted in review; keep only these items (tests "t0"…, "description", "col:<name>"): the file is rebuilt from its original text via app/ai/selection.py; accept is refused (409) when nothing is selected
POST   /api/projects/{id}/ai/proposals/{pid}/files/{fid}/accept   apply the file's operation (modify / create / delete / rename); 409 if the file changed since the proposal was made (or a create/rename target exists); triggers a compile (refactors: `dbt parse` once every file is decided)
POST   /api/projects/{id}/ai/proposals/{pid}/files/{fid}/reject   leave the file alone
POST   /api/projects/{id}/ai/proposals/{pid}/accept       Accept all: apply every pending file as one unit: all are checked first (409 `{error: conflict, files: [...]}`), a failed write rolls back the files already written; files whose items were all rejected in review are rejected instead; then compiles the nodes written (refactors: `dbt parse`)
POST   /api/projects/{id}/ai/proposals/{pid}/reject       Reject all: every pending file rejected, nothing written
POST   /api/projects/{id}/ai/proposals/{pid}/undo         restore every accepted file (original text back, created files removed, renames reversed) while each still holds what was applied; else 409 `{error: changed_since_applied, files: [...]}`; status → undone
POST   /api/projects/{id}/refactor                        Pro (no AI model needed): body {op: rename_model | rename_column | extract_cte, unique_id, new_name, column?, cte?, conversation_id?, message_id?}; 202 AiProposal (kind refactor) built in the background; refusals land as status error with the reason; 409 while another refactor is being prepared
POST   /api/projects/{id}/ai/conversations/{cid}/refactor body {content, unique_id?}; Wicky turns the request into one operation (schema-constrained, re-validated); returns [user message, `refactor` message] — payload {request, operation, description, status: proposed | none}; confirming it is POST /refactor with message_id (status → confirmed)
POST   /api/projects/{id}/ai/messages/{mid}/refactor/cancel  mark a `refactor` card cancelled

GET    /api/license                                      current cached entitlement status (does not force a fresh Polar check); includes the plaintext license_key and can_cancel
PUT    /api/license                                       set (or clear, if license_key is null) the license key; immediately checks it against Polar
POST   /api/license/recheck                               force an immediate Polar check, bypassing the recheck interval
POST   /api/license/cancel                                cancel the active subscription at period end via Polar; 502 if no customer_id on record or the Polar call fails
GET    /api/license/activations                          live count of devices currently activated against this license key (not cached); 502 if no license_key_id on record or the Polar call fails

POST   /api/projects/{id}/debug                          run dbt debug, return structured check results + raw log
GET    /api/projects/{id}/debug/last                     get result of the most recent debug run (from cache)

POST   /api/projects/{id}/drift                          start async schema drift scan (202); returns DriftSnapshot
GET    /api/projects/{id}/drift                          get the latest DriftSnapshot for a project
GET    /api/projects/{id}/drift/{snapshot_id}            get a specific DriftSnapshot by id
POST   /api/projects/{id}/drift/{snapshot_id}/recheck    re-probe one model ({unique_id}) and update its row; 409 while a scan runs
GET    /api/projects/{id}/health/summary                 status/headline/issue count/stale reasons for connection, drift and freshness (+ `semantic` for projects with a semantic layer, else null; `runnable` false while MetricFlow is off or incompatible; + `monitors` (Pro) for projects with enabled monitors, else null)
GET    /api/projects/{id}/semantic/status?want_cli=       Semantic layer: {available, can_query, mode, mode_source, reason_code, reason, warning, dbt_core, python, engine_version, sidecar, spec, adapter_type, counts, compatible_dbt_versions, recommended_version, cli_release}
GET    /api/projects/{id}/semantic/catalog               metrics with dimensions, and saved queries, as MetricFlow sees them; 409 {error, message, status} when unavailable
POST   /api/projects/{id}/semantic/explain               body {metrics, group_by, where, order_by, limit, start, end, saved_query} → {sql, columns}; 400 invalid_query
POST   /api/projects/{id}/semantic/query                 validate + explain + `dbt show --inline` (or the stored result) → {sql, sql_hash, columns, rows, truncated, ran_at, elapsed_ms, target, profile_name, source: warehouse|cache}; body adds `rows` (≤ 5000) and `cache` (refresh | prefer); identical queries in flight share one run
POST   /api/projects/{id}/semantic/query/cached          same body as explain → the stored result for the current target + env, or null; never runs the query
POST   /api/projects/{id}/semantic/dimension-values      body {metric, dimension, limit?} → {values (largest metric first), ran_at, source}: filter value suggestions; the stored result when there is one, else one small `dbt show`
POST   /api/projects/{id}/semantic/saved-queries         body = explain body + {name, label?, description?} → {path}: appends a `saved_queries:` entry to the project's YAML (422 yaml_edit_failed)
POST   /api/projects/{id}/semantic/check                 body {warehouse}; starts the Health → Semantic Layer check (semantic_check_started / _finished)
GET    /api/projects/{id}/semantic/check/latest          latest SemanticCheckSnapshot or null
GET    /api/projects/{id}/dashboards                     metric dashboards (files under DASHBOARDS_PATH): {folder, dashboards: [{slug, path, title, widget_count, exposure, exposure_status (found / out_of_date / missing / unknown, from the manifest's exposures and their depends_on metrics), exposure_path, exposure_unique_id, exposure_drift {add, remove}, error, modified_at}]}; invalid files are listed with `error`
POST   /api/projects/{id}/dashboards                     body {title, widgets?} → 201 detail; the slug is made from the title (unique in the folder)
GET    /api/projects/{id}/dashboards/{slug}              {…summary, dashboard} (the file's contents; unknown keys kept)
PUT    /api/projects/{id}/dashboards/{slug}              body {dashboard, base_modified_at?} → detail; 400 invalid_dashboard (field paths), 409 conflict when the file changed since base_modified_at
DELETE /api/projects/{id}/dashboards/{slug}              204; removes the file
GET    /api/projects/{id}/dashboards/{slug}/results      each widget's stored results for the current target + env (planned with the dashboard's period and filters; never runs): {target, profile_name, widgets: [{widget_id, status: ok|not_run|error|empty, error, notes, grain, current, previous, ran_at, queries: {role: {status, query, sql, columns, rows, truncated, ran_at, error}}}]}
POST   /api/projects/{id}/dashboards/{slug}/refresh      body {widget_ids?}: run the widgets' queries in one `dbt show` (batch.run_many; identical SQL once), store each in metric_query_results → same shape; 409 already_running
POST   /api/projects/{id}/dashboards/{slug}/preview      body {widgets (1–10, unsaved), run = true}: the widgets planned with the saved dashboard's period and filters (Drill into…); stored results, and with `run` the ones without any run and stored → same shape; never writes the file; 400 invalid_widget
POST   /api/projects/{id}/dashboards/{slug}/exposure/propose  body {owner, name?}: a proposal (kind `exposure`, Base) with the exposures YAML and the dashboard file's `exposure:` key, reviewed in ProposalReviewModal and applied by the usual accept route; 422 yaml_edit_failed (e.g. the name exists)
POST   /api/projects/{id}/dashboards/{slug}/exposure/update   a proposal (kind `exposure`) setting the linked exposure's `depends_on` metrics to the dashboard's (other entries kept; `dbt/schema_exposures.py` update_exposure_metrics()); 409 exposure_missing
POST   /api/projects/{id}/dashboards/{slug}/exposure/delete   unlink and delete: a proposal (kind `exposure`) removing the exposure from its YAML (`remove_exposure()`; op `delete` when that empties the file) and `exposure:` from the dashboard; 409 exposure_missing
POST   /api/projects/{id}/dashboards/{slug}/exposure     body {owner, name?}: the same written directly, without review (scripts) → {path, name}
GET    /api/projects/{id}/metric-monitors                Pro: {monitors: [{…, latest}], running, interval_hours, max_monitors, active_target, last_run}
POST   /api/projects/{id}/metric-monitors                Pro: body {metric, grain, dimension?, sensitivity?, lookback?, target?} → 201 monitor + a first check; 400 unknown metric / non-categorical dimension, 409 duplicate_monitor / too_many_monitors (25)
PUT    /api/projects/{id}/metric-monitors/order          Pro: {ids} in their new order (drag to reorder) → 204; unlisted monitors follow in their old order; 400 bad_order
PATCH  /api/projects/{id}/metric-monitors/{mid}          Pro: {sensitivity?, lookback?, enabled?, target? (null unpins)}
DELETE /api/projects/{id}/metric-monitors/{mid}          Pro: 204; deletes its history
POST   /api/projects/{id}/metric-monitors/refresh        Pro: Check now, body {ids?} → {run_id} or {queued: true} behind the running check
GET    /api/projects/{id}/metric-monitors/latest         Pro: the latest MetricMonitorRun or null
PUT    /api/projects/{id}/metric-monitors/settings       Pro: {interval_hours: 1–168 | null} → the MONITOR_INTERVAL_HOURS project env var
GET    /api/projects/{id}/metric-monitors/{mid}/series?slice=&target=  Pro: stored history scored again → {monitor, slice, slices, target, points, summary, restatements}
POST   /api/projects/{id}/metric-monitors/{mid}/points/suppress  Pro: {slice, period, suppressed} — mark a period as expected (404 when not stored)
POST   /api/projects/{id}/metricflow/plan-dbt-change     body {version, want_cli}: pip dry run → {ok, previous_version, install, changes, pins, error}
POST   /api/projects/{id}/metricflow/apply-dbt-change    body {version, want_cli, update_pins, replace_ranges}: rewrites pins, installs via the global-setup stream; 409 while dbt / setup / init runs
POST   /api/projects/{id}/metricflow/verify-dbt-change   after the install: dbt --version, dbt parse, compatibility again

POST   /api/projects/{id}/freshness                      start async source freshness check (202); returns FreshnessSnapshot
GET    /api/projects/{id}/freshness                      get the latest FreshnessSnapshot for a project

POST   /api/projects/{id}/run
POST   /api/projects/{id}/build
POST   /api/projects/{id}/test
POST   /api/projects/{id}/command                        run an arbitrary dbt command ({command: "ls -s +orders"}); 400 if invalid/blocked (init, docs serve)
GET    /api/projects/{id}/run-history                    paginated invocations (?limit, offset, command, status, q)
GET    /api/projects/{id}/run-history/{inv}              invocation + per-node results incl. timing (started_at, completed_at, thread_id, rows_affected, bytes_processed), threads, elapsed_time, has_timing
GET    /api/projects/{id}/run-history/{inv}/log          captured dbt stdout lines
POST   /api/projects/{id}/run-history/{inv}/rerun        rerun with the same selector / custom args
POST   /api/projects/{id}/runs/cancel                    cancel the running dbt process
GET    /api/projects/{id}/node-trend/{uid}               a node's execution-time history
GET    /api/projects/{id}/node-durations?command=        median / last successful execution time + run count per node (DAG Durations overlay, Base)
GET    /api/projects/{id}/run-history/{inv}/analysis     Pro: critical path, wall vs ideal time, thread utilisation, starvation, regressions, recommendations for one run (has_timing=false + reason for runs without timing); 403 not entitled, 503 Pro package missing
GET    /api/projects/{id}/performance?command=&limit=20  Pro: slowest nodes (median of recent runs), each node's latest regression, recommendations merged from the 5 most recent runs with timing; 403 / 503 as above

GET    /api/projects/{id}/docs/status                    timestamp of last generated docs
POST   /api/projects/{id}/docs/generate                  runs dbt compile --write-catalog (≥1.9) or dbt docs generate
GET    /api/projects/{id}/docs/data                      merged manifest+catalog JSON for native docs browser
GET    /api/projects/{id}/docs/view                      patched index.html for iframe-based dbt docs viewer

GET    /api/projects/{id}/env-vars                       list project_env_vars rows
PUT    /api/projects/{id}/env-vars/{key}                 upsert a project env var
DELETE /api/projects/{id}/env-vars/{key}                 delete a project env var

POST   /api/projects/{id}/open                           runs init pipeline
GET    /api/projects/{id}/init/steps                 steps with persisted last_status/log; run_state = pending/running/success/error for steps in the run in progress (null otherwise)
POST   /api/projects/{id}/init/steps
DELETE /api/projects/{id}/init/steps/{name}
POST   /api/projects/{id}/init/reorder
POST   /api/projects/{id}/init/test-script               test-run editor script content with the project env (bash -euo pipefail, 5 min timeout); returns log + captured/missing vars, persists nothing

POST   /api/init/global-setup                            run global pip install (global_requirements_path, else dbt-core at dbt_core_version or the latest) with global env vars set
POST   /api/init/global-setup/cancel                     cancel a running global setup
GET    /api/init/global-setup/events                     SSE stream for global setup output
GET    /api/init/dbt-core-status                         `{installed, version, expected, expected_source, matches}` — installed dbt-core vs the requirements file's dbt-core line (else the dbt_core_version pin); matches=false drives the home page drift warning. Never creates the venv

POST   /api/projects/init-session/start                  pip install adapter + spawn PTY
POST   /api/projects/init-session/{session_id}/input
POST   /api/projects/init-session/{session_id}/stop
GET    /api/projects/init-session/{session_id}/events    SSE with replay buffer

POST   /api/terminal/start                               spawn bash/zsh PTY
POST   /api/terminal/{id}/input
POST   /api/terminal/{id}/resize
POST   /api/terminal/{id}/stop
GET    /api/terminal/{id}/events                         SSE with replay buffer

GET    /api/projects/{id}/profiles
POST   /api/projects/{id}/profiles
PATCH  /api/projects/{id}/profiles/{profile_id}
DELETE /api/projects/{id}/profiles/{profile_id}
POST   /api/projects/{id}/profiles/{profile_id}/activate
PUT    /api/projects/{id}/profiles/{profile_id}/vars/{key}
DELETE /api/projects/{id}/profiles/{profile_id}/vars/{key}

GET    /api/projects/{id}/dbt-targets                    list outputs from profiles.yml
GET    /api/projects/{id}/dbt-target                     current target (from project_env_vars)
PUT    /api/projects/{id}/dbt-target                     set active target

GET    /api/global-env                                    list global (default) env vars, sorted by key
PUT    /api/global-env/{key}                              upsert one (422 on an invalid name)
DELETE /api/global-env/{key}                              remove one (204, no-op if missing)

GET    /api/global-profiles
POST   /api/global-profiles
DELETE /api/global-profiles/{profile_id}
PUT    /api/global-profiles/{profile_id}/vars/{key}
DELETE /api/global-profiles/{profile_id}/vars/{key}

GET    /api/projects/{id}/workspace/path              workspace dir path + relative path (creates dir if missing)
POST   /api/projects/{id}/workspace/compile          compile SQL with dbt compile --inline; returns compiled SQL
POST   /api/projects/{id}/workspace/run              run SQL with dbt show --inline; returns columns + rows (max 5000)

GET    /api/projects/{id}/git/status                 repo root, current branch, ahead/behind, changes list
GET    /api/projects/{id}/git/diff                   unified diff for one file (?path=&staged=)
GET    /api/projects/{id}/git/file-at-head           HEAD blob for Monaco DiffEditor original (?path=)
POST   /api/projects/{id}/git/stage                  git add -- <paths>
POST   /api/projects/{id}/git/unstage                git restore --staged -- <paths>
POST   /api/projects/{id}/git/discard                git restore -- <paths>
POST   /api/projects/{id}/git/commit                 git commit -m <message>
GET    /api/projects/{id}/git/branches               list local + remote branches
POST   /api/projects/{id}/git/branches               create branch
POST   /api/projects/{id}/git/checkout               switch branch
POST   /api/projects/{id}/git/pull                   SSE-streamed git pull
POST   /api/projects/{id}/git/push                   SSE-streamed git push
GET    /api/projects/{id}/git/log                    commit history (?path= &limit=)
GET    /api/projects/{id}/impact/changes             changed files → manifest nodes (?scope=working|branch &base=<ref>)
```

---

## Event System

All real-time updates flow through a single in-process pub/sub bus. Publishers call `bus.publish(Event(topic, type, data))`. SSE endpoints subscribe to a topic and stream events to the browser as they arrive.

### Event Bus (`events/bus.py`)

```
EventBus (module singleton: bus)
  _subscribers: dict[topic → set[asyncio.Queue]]

  subscribe(topic)  → asyncio.Queue   (creates queue, registers it)
  publish(event)    → None            (puts event on every queue for that topic)
  unsubscribe(...)  → None            (removes queue on SSE disconnect)
```

Each SSE client gets its own queue. `publish` is non-blocking (`put_nowait`); events are dropped if a client queue is full (max 1024). There is no persistence — events are lost if the server restarts.

### Topics

| Topic | Subscribers | Publishers |
|---|---|---|
| `project:{id}` | All project routes (RunPanel always mounted) | Runner, Watcher, Init pipeline, compile |
| `init:{session_id}` | New project terminal modal | PTY reader, pip install stream |
| `terminal:{session_id}` | TerminalPanel | PTY reader (bash/zsh) |
| `global` | Wicky panel, Semantic Layer tab (`useGlobalEvents`) | AI model downloader (`ai_model_download`: `model_id`, `state` downloading/verifying/done/error/cancelled, `bytes_done`, `bytes_total`, `error`); MetricFlow sidecar setup (`metricflow_env`: `state` installing/ready/error, `phase`, `message`) |

### Project-scoped Event Types

| Type | Published by | Frontend effect |
|---|---|---|
| `run_started` | `runner.py` | RunPanel begins tracking new run (payload `command`, `label` e.g. `source freshness`, `select`, `started_at`) |
| `run_log` | `runner.py` | RunPanel parses line → updates Execution DAG + Models DAG in real time |
| `run_finished` | `runner.py` | RunPanel stops timer |
| `run_error` | `runner.py` | RunPanel shows error |
| `statuses_changed` | `runs.py` | Invalidates models query → DAG tiles update; clears live overlays |
| `graph_changed` | `watcher.py`, `models.py` | Invalidates models query → DAG re-renders |
| `files_changed` | `watcher.py` | — (graph_changed handles visual update) |
| `compile_started` | `models.py` | Shows "Compiling…" spinner |
| `compile_finished` | `models.py` | Hides spinner |
| `docs_generating` | `docs.py` | — |
| `docs_generated` | `docs.py` | Invalidates docs-status query |
| `init_pipeline_started` | `init.py` | Init modal shows step list |
| `init_step` | `init.py` | Init modal updates step status |
| `init_pipeline_finished` | `init.py` | Init modal shows success/error |
| `git_status_changed` | `git/api.py`, `watcher.py` | Invalidates git status + branches queries |
| `git_started` | `git/runner.py` | Source Control shows sync in progress |
| `git_log` | `git/runner.py` | Appends push/pull output line to sync log |
| `git_finished` | `git/runner.py` | Source Control re-fetches status after push/pull |
| `git_error` | `git/runner.py` | Source Control shows error (e.g. git not on PATH) |
| `health_check_started` | `debug.py` | Health page shows spinner |
| `health_check_finished` | `debug.py` | Health page renders check results table |
| `drift_started` | `drift.py` | Drift panel shows progress bar |
| `drift_progress` | `drift.py` | Drift panel updates checked/total counter |
| `drift_finished` | `drift.py` | Drift panel renders column diff results (also sent after a single-model recheck, with `recheck`) |
| `freshness_started` | `freshness.py` | Freshness panel shows running state |
| `freshness_finished` | `freshness.py` | Freshness panel invalidates query, renders results |
| `column_lineage_started` | `column_lineage.py` | DagFilterBar shows lineage loading state |
| `column_lineage_progress` | `column_lineage.py` | DagFilterBar updates checked/total counter; invalidates column-lineage query |
| `column_lineage_finished` | `column_lineage.py` | Invalidates column-lineage query → DAG lineage trace becomes available |
| `ai_proposal_updated` | `ai_proposals.py` | Invalidates `['ai-proposals', id]` → Wicky chat shows generating / ready to review / error |
| `ai_query_updated` | `ai_query.py` | A Query data query changed status (waiting/running/done/error); invalidates the Wicky conversation |
| `semantic_check_started` | `semantic/check.py` | Invalidates `['semantic-check-latest', id]` and the health summary |
| `semantic_check_finished` | `semantic/check.py` | Same, plus `['semantic-status', id]`; payload `snapshot_id`, `ok`, `errors`, `warnings` |
| `dashboards_changed` | `api/dashboards.py`, `watcher/service.py` | A dashboard file was created, saved, deleted or changed on disk (`slug`); invalidates `['dashboards', id]`, `['dashboard', id, slug]`, `['dashboard-results', id, slug]` |
| `metric_monitor_started` | `semantic/monitors.py` | A monitor check started (`run_id`, `count`, `trigger`); invalidates `['metric-monitors', id]` and the health summary |
| `metric_monitor_progress` | `semantic/monitors.py` | `run_id`, `step` (slices / querying / detecting), `total`; the Monitors tab's Check now label |
| `metric_monitor_finished` | `semantic/monitors.py` | `run_id`, `ok`, `counts` by status; invalidates `['metric-monitors', id]` and the health summary |
| `ai_proposal_progress` | `ai_proposals.py` | Wicky chat renders descriptions / suggested tests as they stream (`phase`: columns, sampling, writing, checking; partial JSON `text`, throttled to ~4/s) |

### Init Session Event Types

| Type | Published by | Frontend effect |
|---|---|---|
| `init_output` | `interactive.py`, pip install stream | Writes chunk to xterm.js terminal |
| `init_finished` | `interactive.py` | Shows "Done" footer; triggers rescan on close |

### Terminal Event Types

| Type | Published by | Frontend effect |
|---|---|---|
| `terminal_output` | `interactive.py` PTY reader | Writes chunk to xterm.js |
| `terminal_finished` | `interactive.py` PTY reader | Shows restart bar in TerminalPanel |

### SSE with Replay (`events/sse.py`)

PTY session events (init and terminal) use a replay buffer. When a subscriber connects, the SSE endpoint first sends all buffered output chunks, then streams live events. This ensures the terminal shows complete output even if the user navigates away and back, or opens the modal after output has started.

Standard project events do not replay.

---

## Key Flows

### 1. Project Discovery

On startup and on `POST /api/projects/rescan`. The startup rescan runs as a background task after the server is up (`begin_startup_scan()` in `service.py`), so `/api/settings` answers — and the UI leaves its loading screen — while a large workspace is walked; `GET /api/projects`, `/projects/summaries` and `POST /rescan` await it via `wait_for_startup_scan()`, and the watcher resyncs when it finishes. `discovery_done` / `startup` / `watcher_start` log their durations.
1. `_effective_workspace()` in `service.py` resolves the active projects path: checks `app_settings` DB table first, falls back to `WICKD_PROJECTS_PATH` env var, returns `None` if unconfigured
2. If `None`, rescan is a no-op; Home page shows a blocking banner
3. `discovery.py` walks the workspace for `dbt_project.yml` files (in a worker thread, off the event loop), skipping excluded dirs (`target`, `dbt_packages`, `node_modules`, dot-dirs, …) and Python environments of any name (detected by `pyvenv.cfg` or `conda-meta/`)
4. For each project, reads `profile:` from the YAML and looks up the adapter type in `profiles.yml` (each profiles.yml is parsed once per pass)
5. `service.py` upserts rows into `projects`

### 2. Global Settings

- `GET /api/settings` returns `{ dbt_projects_path, configured }` where `configured: bool` indicates whether the path is meaningfully set
- `PUT /api/settings` saves the path to `app_settings` and returns `configured: true`
- Home page gates the project list on `configured` and shows an amber banner when false
- `_effective_workspace()` is the single source of truth for path resolution across the backend

### 3. Opening a Project (Init Pipeline)

`POST /api/projects/{id}/open` → background task `_run_init_steps()`:
1. Publishes `init_pipeline_started`
2. Builds env dict: process env + project env vars + active profile vars (via `load_project_env()`)
3. For each enabled `InitStep` in order:
   - `base: pip install` — installs `global_requirements_path` (from `app_settings`) and `REQUIREMENTS_PATH` (from project env vars) into the dbt venv; skips if neither is set
   - `base: dbt deps` — runs `dbt deps` in the project directory
   - custom steps — runs `bash -euo pipefail <script_path>` in the script's parent directory; on success, sources the script again with `set -a` and `export -p` to capture any exported env vars (e.g. `SNOWFLAKE_ACCOUNT`); new/changed vars are upserted into `project_env_vars` and merged into the running env so subsequent steps see them immediately
   - Publishes `init_step` with status after each step
4. Publishes `init_pipeline_finished`
5. On success, fires `_compile_project` in the background to populate the DAG immediately

### 4. Models DAG

`GET /api/projects/{id}/models`:
1. Loads `target/manifest.json` via `manifest.py`
2. Extracts nodes and edges from `parent_map`
3. Merges with latest `ModelStatus` rows from SQLite
4. Returns `GraphDto {nodes, edges}`

The frontend runs `dagre` layout client-side and renders with React Flow. `Models.tsx` overlays a live `liveStatuses` map (populated from `run_log` SSE parsing) so models turn blue while running without waiting for `statuses_changed`.

DAG filtering (`dagFilter.ts`) is purely client-side — no backend involvement:
- **Text selector**: supports dbt-style syntax — `+model` (ancestors), `model+` (descendants), `+model+` (both), `tag:x`, `source:x`, `resource_type:model`, bare type names (`model`, `seed`, `snapshot`, `test`, `source`), and plain substring on name; space-separated tokens are unioned
- **Dropdown filters**: Type, Materialization, Tag, Status — AND between categories, OR within each
- BFS graph traversal builds ancestor/descendant sets using pre-computed adjacency maps
- After filter changes, `fitView()` is called with a 200ms ease so the camera re-centers on the visible subset

### 5. Running dbt

`POST /api/projects/{id}/run` (same pattern for build/test):
1. `select.py` builds the `--select` string from `(model_name, mode)`
2. `runs.py` reads `project_env_vars` for key `dbt_target`; if set, appends `--target <value>` to `RunRequest.extra`
3. `runner.py` acquires the per-project `asyncio.Lock` and spawns `dbt run --select <selector> [--target <target>]`
4. If `profiles.yml` exists in the project root, `build_args()` also adds `--profiles-dir <project_path>`
5. Each stdout line is published as `run_log`
6. `RunPanel.tsx` (always mounted) parses `run_log` lines with regex to identify START/result events, updates the Execution DAG in real time — models appear blue (running) as they start
7. On exit, `run_results.py` parses `target/run_results.json`, upserts `ModelStatus`, publishes `statuses_changed`
8. Frontend invalidates the graph query → final statuses applied

On the main DAG, `lib/useLiveRunStatuses.ts` overlays live statuses parsed from `run_log`. Each node shows `running` for at least 600ms (fast adapters like duckdb finish a model in tens of ms, which would otherwise never paint), and the overlay is cleared only after the `statuses_changed` refetch resolves and every held result has been shown. A selected node keeps its status ring color; the sky selection ring shows only while it's idle.

### 6. Execution DAG (RunPanel)

`RunPanel.tsx` is always mounted (height=0 when the pane is closed) so it never misses SSE events:
- On `run_started`: for run/build/test/seed (`drawsNodes()` in `lib/operationRun.ts`) builds a `name → unique_id` lookup map from current graph and sets a `newRunPending` flag; any other command (compile, debug, source freshness, deps, custom commands…) shows one `OperationNode` — the project name plus `run_started.label` (`command_label()` in `dbt/runner.py`: the command and its subcommand words) — running, then green / red on the exit code, yellow when a line warned (`isWarningLine()`). dbt run outside the runner drives the same node from its own events: `docs_generating`/`docs_generated` (docs generate), `compile_started`/`compile_finished` (the project compile), `init_step` for `base: dbt deps` / `base: dbt compile` (`initStepOperation()`); warnings there come from `project_log` lines and the step's log. An operation finishes once (a single-model compile sends both `run_finished` and `compile_finished`)
- The pane never opens itself on a run; it stays as the user left it
- On `run_log` START line: clears previous run's nodes on first hit (lazy clear), adds node with `running` status
- On `run_log` result line (OK/ERROR/WARN/PASS/FAIL): updates node status optimistically
- `buildDisplayGraph` includes ancestor nodes so edges are visible even for single-model runs
- On `statuses_changed`: final states confirmed from DB

### 6a. Node DAG (bottom pane)

The **Node DAG** tab shows the `+node+` lineage of whatever node is selected on the current page:
- The selection lives in `ProjectLayout` (`lib/selectedNodeContext.tsx`). The DAG page reports its selected node, the Files page reports the open file's model (or the active test in a YAML file), and the Git page reports the node defined by the selected changed file (`lib/nodeForPath.ts`; prefers a non-test node in a shared YAML file) via `useReportSelectedNode()`; it clears when the page unmounts, so other pages show an empty state
- `buildNodeLineageGraph()` walks all transitive ancestors and descendants; `filterNodeLineage()` then applies the tab's Type/Materialization/Status dropdowns (shared `FilterDropdown` + `matchesDropdownFilters()` with the main DAG, persisted in sessionStorage as `node-dag-filter-{id}`). Type defaults to seed/source/model/exposure (`defaultNodeDagFilter()`), so tests are hidden until picked; there's no Clear button, so the tab always shows the `+node+` lineage, narrowed only by the dropdowns; the selected node is always kept. Edges that skip hidden nodes are drawn dashed (`bridged`) so the view stays connected
- The panel is mounted only while its tab is visible, and centers on the selected node at a zoom that keeps the whole lineage in view. It re-centers when the selection or the node set changes, not on status-only refreshes, so a run doesn't move the viewport

### 6b. Impact analysis

`lib/impact.ts` `computeImpact(graph, seedIds)` is a pure function over `GraphDto` (unit-tested in `impact.test.ts`):
- A breadth-first walk from all seeds at once assigns each downstream node its shortest depth. Test nodes are not walked; they're counted per parent as `dataTests`, and `unit_tests` are matched to models by name as `unitTests`
- Flags: `untested` (model/snapshot with no tests), `exposure`, `incremental`, `failing` (error/warn), `stale`. The summary counts downstream nodes by type, tests on seeds vs. tests only downstream, and flags across downstream nodes
- `buildImpactSelector()` produces `<seed>+ …` (sources as `source:x.y`), which `useBuildImpacted()` sends to `POST /build` as `select`

It's shown in two places: `SidePane/ImpactSummary.tsx` (a card in PropertiesTab, hidden for tests and exposures) and the bottom pane **Impact** tab (`ImpactPanel.tsx`, mounted only while visible). The card also appears in the multi-selection panel. The tab uses the DAG's multi-selection when there is one (`SelectedNodeIdsContext`, reported by Models.tsx via `useReportSelectedNodes()` and empty unless 2+ nodes are selected), otherwise `SelectedNodeContext`. The card's **Show impact** button calls `openBottomTab('impact')`, a `wickd:open-bottom-tab` window event that BottomPane listens for. `openBottomTab(tab, { impactMode })` can also pick the tab's source.

**Column-level impact (Pro).** In Selection mode the toolbar's **Columns** toggle (state in BottomPane) switches to column-level impact, built on the column lineage snapshot:
- **Row dependencies** (private `wickd_pro/row_dependencies.py`, `trace_row_dependencies()`; `trace_job_full()` runs it alongside `trace_job()`): `qualify()` the compiled SQL against parent columns, walk every scope, and resolve columns in `WHERE` / `JOIN ON`/`USING` / `GROUP BY` / `HAVING` / `QUALIFY` (plus subquery projections, which feed IN/EXISTS filters) back through CTE, derived-table and set-operation aliases to parent columns. Stored per snapshot as `row_dependencies`; data tests get them too (their row dependency is the column they check). The public shim's `trace_job_full()` falls back to `[]` for older Pro builds
- `lib/columnImpact.ts` `computeColumnImpact(graph, lineage, seeds)` (pure, tested) propagates picked `(node, column)`s: projection lineage narrows to specific downstream columns; a row dependency on an affected column marks the whole downstream model affected (`via: 'rows'`, with the triggering column); children with no lineage at all are assumed fully affected (`'untraced'`); exposures are reached through any affected parent. Tests count as affected when their row dependency (else `attached_node` + `column_name`, else any parent) is affected. Tests traced as lineage targets are never listed as nodes
- `computeImpact(graph, seeds, { reach, affectedTests })` then builds the usual table from that reach; rows get an **Affected columns** column (`describeAffected()`) and "N of M" affected tests; the toolbar shows how many node-level-downstream nodes are unaffected, and **Build impacted** selects exactly the affected nodes (`buildExactSelector()`, no `+`)
- **DAG column selection drives it:** Models.tsx reports its clicked columns (`activeColumnSels`, `<uid>::<column>` keys) via `useReportSelectedColumns()` (`SelectedColumnsContext` in `lib/selectedNodeContext.tsx`). In Selection mode a non-empty column selection becomes the seeds and picks (`picksFromColumnKeys()`), forces column-level on (toggle disabled), and replaces the picker with a read-only summary
- `lib/useColumnLineageData.ts` reads/starts the snapshot (shared `['column-lineage', id]` query with the DAG) and needs `lineage_version >= 2`; `ImpactColumnBar.tsx` shows unlock (403 → `UpgradeModal`), load/refresh progress, or the per-seed column picker; `BottomPane/useColumnLevelImpact.ts` ties it together

**Change-set modes.** The Impact tab's **Selection / Uncommitted / Branch** switch (state held in BottomPane so it survives tab switches) picks the starting nodes. The two git modes call `GET /api/projects/{id}/impact/changes` (`api/impact.py`) via `lib/useImpactChanges.ts`, which refetches on `git_status_changed`, `files_changed` and `graph_changed`:
- `git/changeset.py` collects repo-relative changes through `git_runner`. `scope=working` runs `git status --porcelain=v2 -z --untracked-files=all`; a rename also reports its old path as deleted. `scope=branch` resolves the base (`?base=`, else `origin/HEAD`'s target, else `main`/`master`/`origin/main`/`origin/master`; refs are validated against a safe-ref pattern and `rev-parse --verify`), then `git merge-base <base> HEAD` and `git diff --name-status -z --no-renames <merge-base>` (commits plus uncommitted changes) plus untracked files. `to_project_files()` keeps paths inside the dbt project directory, so projects in a monorepo work
- `dbt/changes.py` `map_changed_files()` maps files to manifest nodes. `original_file_path` covers model SQL, seed CSVs and the YAML defining sources/exposures. `patch_path` maps a schema YAML to every node it documents, which over-approximates when one YAML documents several models. A root-project macro file maps to every node that calls it, directly or through other macros (`depends_on.macros`). Only models, seeds, snapshots, sources and exposures are returned. `dbt_project.yml`/`packages.yml`/`dependencies.yml`/`selectors.yml`/`profiles.yml` come back as `project_wide`. Other `.sql/.yml/.yaml/.csv/.py` files under the project's resource paths (read from `dbt_project.yml`) that the manifest doesn't know come back as `unmapped`. `target/`, `dbt_packages/` and `logs/` are ignored
- In the UI, the depth-0 group is labelled "Changed", with each node's reason (`lib/impactChanges.ts` `describeReasons()`: "edited", "new file", "_schema.yml", "via macro x"). `ImpactNotices.tsx` explains what was compared and lists project-wide and unmapped files. `buildImpactSelector()` leaves exposures out, since `dbt build` has nothing to build for them
- The Git page's collapsible **Impact** section (`Git/components/ImpactSection.tsx`, between Changes and Commit History; sections share `PaneSection.tsx`) shows the uncommitted change set's impact, with **Details** (`openBottomTab('impact', { impactMode: 'working' })`) and **Build impacted**

### 7. Integrated Terminal

`TerminalPanel.tsx` hosts multiple xterm.js instances (VSCode-style tabs):
- `POST /api/terminal/start` spawns a login shell (`$SHELL -l`, falling back to zsh/bash/sh)
- `InteractiveInitManager` singleton manages the PTY session (reused from `dbt init`)
- `ResizeObserver` + `xterm-addon-fit` handle dynamic resize; a 30ms timeout ensures fit runs after the container is visible
- `lastSizeRef` tracks last sent `{cols, rows}`; `setwinsize` is only called when dimensions actually change — prevents spurious `SIGWINCH` signals that would cause zsh to redraw the prompt on every click
- Sessions persist until explicitly closed; switching tabs keeps the session alive

### 8. Interactive `dbt init`

1. Frontend shows platform picker
2. `POST /api/projects/init-session/start {platform}` creates a pending session
3. Background: pip-installs the adapter, then spawns `dbt init` via ptyprocess
4. Frontend subscribes to SSE with replay buffer; xterm.js renders all output
5. On `init_finished`, frontend calls `POST /api/projects/rescan` then `POST /api/projects/{id}/ensure-profiles-yml` on each project — writes a minimal `profiles.yml` into any newly created project that doesn't have one
6. Project appears in list with a working `profiles.yml` ready for `--profiles-dir`

### 9. Docs Generation

`POST /api/projects/{id}/docs/generate` → background task `_generate_docs()`:
1. Publishes `docs_generating`
2. Tries `dbt compile --write-catalog` (dbt ≥ 1.9); if the flag is unrecognised, falls back to `dbt docs generate`
3. All output is streamed to Project Logs via `append_project_log()` — does **not** use `runner.stream()`, so no `run_started` event is emitted; the Execution DAG shows its project node from `docs_generating` / `docs_generated` instead
4. On success, copies `manifest.json`, `catalog.json` (and `index.html` if produced) to `data/docs/{project_id}/`
5. Publishes `docs_generated {ok, generated_at}`
6. Frontend invalidates `['docs-status', projectId]`; the native docs browser (`Docs.tsx`) re-fetches `GET /api/projects/{id}/docs/data`

### 10. Column-Level Lineage (wickd Pro)

Column-level lineage is the first paid ("Pro") feature — all three routes (`start`, latest, and by-snapshot-id) call `_require_pro(session)` (`api/column_lineage.py`), which raises `403 {"error": "pro_feature_required", "reason": <Entitlement.reason>}` when `entitlements.check_entitlement()` returns not-entitled. Both GET routes are gated too, not just `start`, because an already-computed snapshot persists in the DB indefinitely and would otherwise keep serving results forever after a subscription lapses. See "Licensing (wickd Pro)" below for the entitlement system itself.

**Open-core split:** the actual sqlglot-based tracing algorithm (`prepare_lineage_jobs`, `trace_job`, `build_column_lineage`, and their private helpers) lives in a separate private repo, `wickd-pro` (not in this repo) — all licensing/entitlement enforcement stays in this public repo, since that code must run inside the distributed app regardless of who can read the source. `backend/app/dbt/column_lineage.py` in *this* repo is a thin public shim: it defines the real, always-importable `ColumnRef`/`LineageJob` dataclasses (required at server-startup import time by `api/column_lineage.py`, so they can't be `TYPE_CHECKING`-only) and lazily imports `wickd_pro.column_lineage` inside each function, raising `ColumnLineageUnavailable` if the private package isn't installed. The public repo therefore builds and runs completely standalone for contributors; only maintainer/release builds of the packaged desktop app install `wickd-pro`: run `task package:pro` (installs `wickd-pro` from a sibling checkout — a plain, non-editable install, since PyInstaller can't see through an editable install) before a Pro build (`task package:sandbox:pro` / `task package:production`); contributors build the free app with `task package:app`. `packaging/wickd.spec` detects whether `wickd_pro` is importable at build time (`importlib.util.find_spec`) and only adds it to PyInstaller's `hiddenimports` when present — required because it's imported lazily at call time, which PyInstaller's static analysis can't discover on its own. Skipping `package:pro` produces a normal public build with lineage unavailable; nothing else in the packaging flow changes.

Column lineage is computed **SQL-first**: `dbt/column_lineage.py` derives each model's column list by parsing the compiled SQL's outer `SELECT` with sqlglot (`named_selects`) — no yml `columns:` documentation is required. yml-documented columns are used only as a fallback when the SQL parse can't determine an explicit column list (a top-level `SELECT *`, or missing `compiled_code` because `dbt compile` hasn't run).

The scan is a backgrounded, progress-reporting job — same pattern as schema drift and source freshness (`column_lineage_snapshots` table; see Database Schema):

1. `POST /api/projects/{id}/column-lineage/start`:
   - Reads `target/manifest.json`'s mtime; if the latest snapshot for the project is `done`, its `manifest_mtime` matches and its `lineage_version` equals what a scan would produce now (`LINEAGE_VERSION`, or 1 when the installed `wickd_pro` predates row dependencies — `supports_row_dependencies()`), short-circuits and returns that snapshot directly (200) — no recomputation.
   - Otherwise, runs the "prep" phase (`prepare_lineage_jobs()`, in a thread executor) — cheap manifest parsing that builds one `LineageJob` per model needing lineage (no `sqlglot.lineage.lineage()` calls yet).
   - Creates a `running` `ColumnLineageSnapshot` row, spawns a background `asyncio.Task`, publishes `column_lineage_started`, returns 202.
2. Background runner (`_run_column_lineage`) fans the actual CPU-bound tracing out across a `ProcessPoolExecutor` (sized `max(1, min(8, cpu_count-1))`) — one `trace_job_full(job)` call per model (projection lineage + row dependencies), submitted via `loop.run_in_executor(pool, trace_job_full, job)` and collected with `asyncio.wait(..., return_when=FIRST_COMPLETED)` so each completed job's `checked`/`total`/`current` can be published as it lands.
3. As each job completes: increments `checked_models`, merges the result into `results_json` and `row_dependencies_json`, commits, publishes `column_lineage_progress`.
4. On completion: sets `status="done"`, `finished_at`, final `results_json` + `manifest_mtime`, publishes `column_lineage_finished`.
5. `GET /api/projects/{id}/column-lineage` returns the latest snapshot (status + `results`, a nested dict from downstream node → column → list of upstream `{node, column}` refs).

`build_column_lineage(manifest_path)` remains available as a synchronous, in-process, no-pool entry point sharing the same job-prep/trace logic — used by tests and any caller that just wants the full result computed inline.

In the frontend (`Models.tsx`):
- Toggling "Load column lineage" calls `POST .../column-lineage/start` (ignoring 409 — a run already in flight is fine) and keeps `useQuery(['column-lineage', id])` (`GET .../column-lineage`) as the source of truth for rendered data.
- A `useProjectEvents` handler invalidates `['column-lineage', id]` on `column_lineage_progress`/`column_lineage_finished`, and tracks `{checked, total}` from `column_lineage_progress` for an optimistic progress indicator (mirrors `DriftPanel.tsx`).
- `DagFilterBar` shows `Column lineage: {checked}/{total}…` while a scan is running.
- If `columnLineage`'s query error or the `start` call's rejection is a 403 with `{"error": "pro_feature_required"}` (detected via `isProFeatureRequiredError()` in `lib/api.ts`), the lineage button renders locked (`Lock` icon, "Column lineage (Pro)") and clicking it opens `UpgradeModal` instead of starting a scan. `UpgradeModal` reads `GET /api/license` for status/reason copy and a Polar checkout link (`checkout_url`, from `POLAR_*_CHECKOUT_URL`), and lets the user paste + activate a license key inline (`PUT /api/license`) or force a recheck (`POST /api/license/recheck`).
- Expanding a model node in the DAG reveals its columns; clicking a column toggles it in `activeColumnSels`
- `traceColumn()` walks the lineage map bidirectionally (upstream via `reverseLineageIndex`, downstream via forward traversal) to collect all `{node, column}` pairs in the trace
- Highlighted `{node, column}` pairs are passed as props into each `ModelNode`; nodes and edges outside the trace are dimmed
- None of this blocks other queries/interactions — the scan runs fully server-side in background worker processes; the frontend only ever does small polling GETs and SSE-driven invalidation.

### 10d. Lineage propagation (wickd Pro)

Builds on column lineage (section 10). Since `lineage_version` 3 the scan records how each output column is derived from each upstream ref: `identity` (same name), `rename`, `cast` (CAST / TRY_CAST / SAFE_CAST / `::`, optionally inside `COALESCE(x, literal)`) or `derived` (anything else). It is computed in `wickd_pro.transform_kinds` from sqlglot's lineage tree as the weakest step along the path (`trace_job_kinds()`, behind the shim's `supports_transform_kinds()` probe, so older Pro builds still produce version 2 snapshots).

- **Engine (private):** `wickd_pro.propagation` — `inherit_descriptions()` walks upstream from each undocumented column along identity/rename/cast edges to the nearest documented column(s), and reports a conflict instead of guessing when several distinct descriptions are reachable; `tag_flow()` follows declared column tags downstream through every kind (a hash of PII is still PII), preferring the strongest path, and lists exposures that depend on a reached node; `inherit_tags()` narrows that to undeclared columns. Public shim: `app/propagation/pro.py`; manifest → plain dicts in `app/propagation/inputs.py` (column `tags` and `config.tags` both count).
- **Writing (public):** `app/propagation/proposals.py` turns results into one `ai_proposals` row of kind `propagate` with one `ai_proposal_files` row per schema YAML touched (the file `plan_document_node()` picks). Copied descriptions are the source column's raw YAML text (`raw_descriptions()` / `raw_source_descriptions()`), so `{{ doc() }}` blocks stay doc blocks. Tags are spliced by `app/dbt/schema_column_tags.py` `add_column_tags()` (block list, one-line list, single string, or `config: tags:`; re-parse verified). Each item names its file; partial accept (`PUT .../selection` with `file_id`) rebuilds only that file through `render_file()`, and accepting a file compiles the nodes it documents.
- **UI:** Docs project overview "Fill descriptions from lineage (N)", the side pane's "Inherit descriptions from upstream (N)" (only when the model has something to fill), and the Docs **Tags** browse tab (`?browse=tags&tag=`: `TagFlowPanel` with a DataTable, exposures, "Write inherited tags to YAML", and "Show in DAG", which seeds the DAG's `dag-column-sels-{id}` / `dag-expanded-nodes-{id}` session keys). Review uses `ProposalReviewModal`, which lists the active file's items for multi-file proposals. Lineage not ready → `LineageNotReadyNotice` with "Refresh column lineage". No new SSE events: `['propagate-preview', id]` and `['tag-flow', id]` are invalidated on `column_lineage_finished`, `graph_changed`, `files_changed` and `ai_proposal_updated`.

### 10d-2. Smarter test suggestions (wickd Pro)

Builds on column lineage (section 10). Since `lineage_version` 4 the scan also records, per model, its **join pairs** (each equality in a JOIN `ON`/`USING`, resolved through CTEs and pass-through renames to two upstream columns, with the join type) and its **grain** (the final SELECT's GROUP BY, SELECT DISTINCT, or a `row_number() … = 1` dedupe in QUALIFY or a WHERE on a CTE, followed through `select … from <cte>` layers) in `join_keys_json` — `wickd_pro.structure.trace_structure()`, via `trace_job_structure()` behind the shim's `supports_structure()` probe.

- **Ranking (private):** `wickd_pro.test_targets.rank_test_targets()` turns that into candidate tests per `(model, column)` with evidence: grain → `unique` + `not_null` (one column) or `not_null` each + `dbt_utils.unique_combination_of_columns` (several, only when dbt_utils is installed); inner-join keys → `not_null`; `relationships` from the many side to the one side only when the one side is known unique (single-column grain or an existing `unique` test). Existing tests are skipped. Score = (downstream columns + 3 × row-dependency uses + 5 × exposures reached) × 2 in the grain. Public shim `app/test_targets/pro.py`; snapshot loading and the per-snapshot cache in `app/test_targets/service.py`.
- **Add tests:** `ai/test_generation.py` gets the model's ranking (`targets_for_model()`), adds the evidence-backed tests directly (`app/test_targets/items.py` `structural_tests()`), then prompts the AI model with the ranked columns and those tests as already present. Without an AI model (`llm_ready()`), or if it fails, only the lineage-backed tests are proposed. Everything is pre-checked in one `dbt show`; YAML via `render_tests()` (`add_column_tests()` + model-level `add_model_tests()`).
- **Test gaps:** `api/test_gaps.py`; the batch proposal (`app/test_targets/batch.py`) is kind `tests` with `batch: true` and file/node on each item, so partial accept rebuilds one file (`app/ai/selection.py`).
- **UI:** a Test Gaps card on the Health overview (count + top 3, Refresh lineage; it doesn't fetch the lineage snapshot and isn't part of Run all), and Health → **Test Gaps** tab (`?tab=test-gaps`, `TestGapsPanel`; its label carries the gap count as a badge, a dot while lineage is computing; Gaps / Ignored sub-tabs in `?gaps=`, Ignore selected / Unignore selected, and a Refresh button that re-traces lineage (a no-op when the manifest is unchanged) and re-ranks): a `RichTable` (search, a Test dropdown, checkboxes with shift-click ranges, per-row Ignore / Generate, expand for the evidence and the models that join on it, ⌘-click a model to open it), "Generate tests" → `ProposalReviewModal`, which shows each test's evidence ("From lineage: …"). `['test-gaps', id]` is invalidated on `column_lineage_finished`, `graph_changed`, `files_changed` and `ai_proposal_updated`.

### 10e. Refactors (wickd Pro)

Rename a model, rename a column, or extract a CTE into its own model, proposed as one reviewable multi-file diff. The engine is deterministic; an LLM is only used (optionally) to turn a Wicky chat request into the operation.

- **Engine (private):** `wickd_pro.refactor` — `rename_model()`, `rename_column()`, `extract_cte()` take the manifest, the project's raw files (`app/refactor/inputs.py` `project_files()`: resource dirs + dbt_project.yml, no packages/target) and (for columns) the latest column lineage snapshot. SQL is never re-serialised: Jinja blocks are masked with same-length placeholders (`{{ ref('x') }}` → an identifier, `{% %}` → spaces), sqlglot parses the masked text, and identifier positions map back onto the raw file as span edits. Column renames resolve references per scope (`selected_sources`, CTEs passing the column through `*`), keep downstream output names (`c.new as old`), and update YAML columns, `column_name` tests, `relationships` `field:` and unit-test fixture rows (dict / csv). Anything uncertain — `select *` reaching the output, unqualified names another relation may also have, `using (col)`, Jinja mentions, SQL that won't parse, dbt_project.yml keys, docs blocks, string literals — is never edited and comes back as `manual: [{path, line, text, reason}]`. Refusals (bad name, collision, package model, CTE reading sibling CTEs) raise with a user-facing reason. Intent parsing: `wickd_pro.ai.refactor_intent` (`refactor_prompt()` constrains the model name to an enum of real models; `parse_refactor_intent()` re-validates).
- **Public:** `app/refactor/pro.py` (shim), `service.py` (`run()`; adds the YAML stub for an extracted model via `plan_document_node()`), `verify.py` (`dbt parse` through `runner.run()` after applying, result in `result_json.verify`, announced with `ai_proposal_updated`; failures are reported, never reverted). Proposal files carry an `op` (`app/ai/file_ops.py`: check → apply → undo, each refusing when disk doesn't match). Gating: `require_refactor()` (Pro entitlement + engine, not the AI model); reviewing a refactor proposal uses `require_proposal_access()`.
- **UI:** Wicky's **Refactor** chat mode (and "Refactor…" quick action) → `RefactorCard` (confirm / cancel) → `ActionEntry` with `RefactorOutcome` (dbt parse status, Undo, manual list). Direct entries dispatch `startRefactor()` (`routes/Project/lib/refactorEvents.ts`) — side pane "Rename model…", Docs column rows (hover), Files editor context menu "Extract CTE to model…" — handled by `RefactorHost` (mounted in ProjectLayout: name prompt, build, review, outcome toast). `ProposalReviewModal` shows op badges, rename paths, "Needs manual review" (click to jump to the line); every proposal has "Reject all" / "Accept all" (`POST .../reject` / `.../accept`). No new SSE events.

### 10b. Local AI — Wicky (wickd Pro)

User-facing overview of context, limits, safety and locality: [wicky.md](wicky.md).

The UI is **Wicky**, a right-hand panel in `ProjectLayout` on every project page (⌘I), using the page's selected node as context (or the whole project when nothing is selected).

AI runs on the user's machine. `app/ai/runtime.py` manages a bundled **llama-server** (llama.cpp, fetched by `task ai:runtime` into `src-tauri/binaries/llama/` and shipped as an app resource): started on the first AI request with the selected model, on a free localhost port, with thinking disabled; stopped after 10 idle minutes, on model change and on shutdown. Models come from a pinned catalog (`app/ai/catalog.py`: exact Hugging Face file + SHA-256) and are downloaded on demand into `<data_dir>/models` by `app/ai/download.py` (resumable `.part` file, renamed only after the checksum matches). Setting `ai_endpoint_url` points every AI feature at any OpenAI-compatible server instead (Ollama, LM Studio, …). Both paths go through the same tiny client (`app/ai/client.py`).

Same open-core split as column lineage: prompts, dbt context building and output validation live in `wickd_pro.ai`, behind the public shim `app/ai/pro.py` (plain dicts cross the boundary). Routes gate on entitlement (403) and on the Pro package being installed (503).

- **Ask** — `POST .../ai/conversations/{cid}/messages` builds messages from the manifest (selected node's SQL, columns, tests, upstream descriptions, project overview with exact documentation-coverage counts computed up front, since the node list is truncated on large projects; budgeted to fit a small context window) and streams the reply on the response itself, not the bus.
- **Query data** — `api/ai_query.py`, a fixed two-step flow (no agent loop): the model writes one SELECT using `{{ ref() }}`/`{{ source() }}` from a relations list (`wickd_pro.ai.query`); the user reviews/edits and clicks Run. `app/ai/sql_guard.py` is the backstop: only literal `ref`/`source` Jinja (no `{% %}`, no other macros — they can run SQL at compile time), and sqlglot (adapter dialect) must see exactly one query with no write/DDL/session statements anywhere. Queries with their own LIMIT are wrapped in a subquery, since `dbt show --limit` appends one. Runs behind the project's dbt lock (`runner.is_project_busy()` → `waiting`); `runner.run()` now kills dbt if its caller is cancelled (timeouts). Answering sends the result rows to the model — automatic with the bundled model, a button (with a warning) when a remote endpoint is set.
- **Run results in context** — `app/ai/run_context.py` adds the node's latest status/message and its tests' results (from `model_statuses` + the manifest's `attached_node` links) to Ask. **Explain failure** (`mode: explain_failure`) also re-runs up to 2 failing tests with `dbt show --limit 10` and sends those rows. **Why is it slow** (`mode: explain_slow`, Run History → Performance) sends `app/ai/perf_context.py` `node_performance_info()` instead: the node's last 20 `invocation_model_results` rows with their invocation, upstream medians, and `git log -p` / `git diff HEAD` (via `git_runner`) for its SQL and schema YAML since the oldest of those runs; prompt in `wickd_pro.ai.performance`, falling back to Ask on older Pro builds.
- **Add tests** — `app/ai/test_generation.py`: warehouse columns, a 500-row `dbt show` sample summarised per column (nulls, distinct, values when few), then a schema-constrained answer limited to real columns, the 4 generic tests and parent/grandparent relationship targets (validated again in `wickd_pro.ai.tests`). Every suggestion is pre-checked in ONE `dbt show --inline` union query (failing-row counts shown in review), then spliced in by `app/dbt/schema_tests.py` (uses the column's/entry's `data_tests:`/`tests:` key, else by dbt version; `arguments:` block on dbt 1.10+).
- **Document with AI** — `POST .../ai/document` creates an `ai_proposals` row and generates in the background: warehouse columns via `probe_warehouse_columns()` (falls back to manifest + catalog columns), the node's entry planned with `schema_yaml.plan_document_node()`, descriptions from a JSON-schema-constrained streamed completion (partial output published as `ai_proposal_progress` so the chat shows them being written), spliced in by `schema_descriptions.set_descriptions()` (only columns without a description are sent to the model unless `overwrite`; if nothing is missing it returns `empty` without calling the model). Nothing is written until the user accepts the file in the review modal (Monaco diff, with the proposal's items listed beside it — click one to reveal it in the diff, accept or reject each; rejecting re-derives the file from the original without that item, through the same splicers and checks, never by patching the diff); accepting refuses with 409 if the file changed meanwhile.

### 10c. Run performance (timeline Base, insights Pro)

- **Capture (Base):** `dbt/run_results.py` `load_run_results_file()` also reads each result's `timing` (execute window, compile as fallback), `thread_id` and `adapter_response` (`rows_affected`, `bytes_processed`), plus the top-level `elapsed_time` and `args.threads` (falling back to the number of distinct thread ids). `_persist_results_after_run()` stores them on `invocation_model_results` / `run_invocations`; older rows stay NULL and every view degrades to "timing is recorded for runs from now on".
- **Timeline (Base):** the run detail pane's Timeline tab (`RunHistory/RunTimeline.tsx`) lays bars out with `lib/runTimeline.ts` `buildTimeline()` (one lane per thread, % of wall time, nice ticks; nodes without a thread id packed into extra lanes).
- **DAG Durations overlay (Base):** `GET /node-durations` → `lib/durationOverlay.ts` buckets each node by percentile rank of its median among nodes of the same resource type (unique_id prefix); `lib/useDurationOverlay.ts` owns the toggle (sessionStorage) and refetches on `statuses_changed`.
- **Insights (Pro):** `api/performance.py` loads history and builds plain inputs with `app/performance/inputs.py`, then calls `wickd_pro.performance` through the shim `app/performance/pro.py`: `analyze_run()` (critical path walked back from the last-finishing node through each node's blocking parent; a wait is *starvation* when every thread was busy for at least half of it; ideal time = longest duration-weighted path; utilisation = busy / threads × wall), `detect_regressions()` (≥ 50% and ≥ 5 s over the median of the node's last 10 successful runs, needing 3+), `recommend()` (make incremental, materialize a view, raise threads, break up a bottleneck — thresholds are constants in wickd_pro). Gated by `licensing/gating.py` `require_pro()` (also used by column lineage and AI). The frontend invalidates `['run-analysis', id]` / `['performance', id]` on `statuses_changed`; no new SSE events.

### 10a. Licensing (wickd Pro entitlement)

Entitlement resolution (`app/licensing/entitlements.py`) wraps a thin async Polar client (`app/licensing/polar_client.py`, `httpx`-based) with a persistent grace-period cache (`license_state` table, single row, id=1) so Pro features keep working through brief offline periods:

1. `check_entitlement(session, force=False)`: if no `license_key` is set → `not_licensed`. If checked within `RECHECK_INTERVAL` (6h) and not forced, trusts the cache.
2. If due for a check: activates this device against the key if no `activation_id` is cached yet (`POST .../license-keys/activate`), then validates (`POST .../license-keys/validate`).
3. `LicenseKeyNotEntitled` (Polar's real-world shape for a canceled subscription — confirmed via live sandbox testing to be a 404 from validate or a 403 with "no longer active" from activate) is **always trusted immediately**, regardless of the grace period — caches `entitled=False, reason="not_entitled"`.
4. `ActivationLimitReached` (403 from activate, seat limit) returns `reason="activation_limit_reached"` **without** caching, so a retry after freeing a seat re-attempts activation instead of waiting out `RECHECK_INTERVAL`.
5. Any other `PolarError` (network failure, unexpected response) falls back to `_grace_period_result()`: if the last cached result was `entitled=True` and within `GRACE_PERIOD` (7 days) of `checked_at`, returns `reason="grace_period"` (still entitled); otherwise `reason="unreachable"` (not entitled).

`api/license.py` exposes this as `GET/PUT /api/license` + `POST /api/license/recheck` + `POST /api/license/cancel` + `GET /api/license/activations` (see API Routes). `polar_use_sandbox` / the `polar_organization_id` / `polar_api_key` / `polar_api_base` properties on `Settings` (`config.py`) pick sandbox vs. production Polar credentials and API base URL.

**Cancellation** (`entitlements.cancel_subscription()`) is a separate flow from entitlement checking, since Polar's license-key validate/activate endpoints are unauthenticated and don't expose subscription management. It uses the organization API key (`polar_api_key`, server-side only, never sent to the frontend) to mint a short-lived customer session token (`POST /v1/customer-sessions/`, keyed on the `customer_id` captured from a prior `validate()` call), then lists and cancels the customer's active subscription(s) via the customer-portal subscriptions API (`GET`/`DELETE /v1/customer-portal/subscriptions/...`). Cancellation is **at period end** — Polar keeps the subscription (and Pro access) active until the current billing period ends; `cancel_subscription()` deliberately does not clear local license state, so the normal `RECHECK_INTERVAL` polling picks up the eventual `not_entitled` result from Polar on its own once the period actually ends.

**Activation visibility** (`entitlements.get_activation_count()`) exists because a license key is a bare shared secret — Polar's activation-limit benefit (`limit_activations`, currently 2 devices per key, configured in the Polar dashboard) is the only thing stopping a key from being shared/leaked and used by strangers; nothing else in this system detects or prevents it. This function surfaces how many devices are *currently* activated (via the org-authenticated `GET /v1/license-keys/{license_key_id}`, whose `activations` array is counted) so a legitimate user can notice unexpected activity — e.g. more devices than they own — and go deactivate the extra one from their Polar customer portal. It's a live, uncached look-up (not baked into `check_entitlement()`'s cache) since it's only fetched on demand when the Subscription UI is open, not on every entitlement check.

The Global Settings modal's "Subscription" tab (`components/SubscriptionSection.tsx`, wired into `components/GlobalSettingsModal.tsx`) is the UI for all of this — installation-wide, not per-project, matching where the license itself lives. It shows the license key (masked by default, revealed via an eye-icon toggle — `GET /api/license` now returns the plaintext key for this purpose, with copy warning the user not to share it), subscription status, a live "X of Y devices activated" row (when `can_view_activations` is true) with a manual refresh button, and a confirm-before-cancel "Cancel subscription" button when `can_cancel` is true; when no key is set, shows a "Subscribe" link (to `checkout_url`) and an inline key-activation input.

### 10f. Semantic layer (Base)

- **Graph:** `dbt/manifest.py` reads `semantic_models`, `metrics` and `saved_queries` as nodes (`resource_type` semantic_model / metric / saved_query) with `label` and a `semantic` dict (`dbt/semantic_nodes.py`); `parent_map` already links model → semantic model → metric → saved query. The DAG hides them by default (Type filter) and shows them when a semantic node is deep-linked; the Node DAG tab includes them when the selected node is one. Impact walks into them (`metric` flag; build selectors leave them out). Docs and search list them.
- **Runtime:** one long-lived MetricFlow worker (`semantic/runtime.py`) runs `worker_main.py` under `<data_dir>/metricflow-venv`, which holds only the pinned `metricflow` engine (never dbt, never imported into the backend, whose sqlglot is capped lower). It reads `<target-path>/semantic_manifest.json` and renders SQL for the manifest's `adapter_type` with a render-only SQL client: about 4 ms per explain, no warehouse connection. The venv is built on first use (`metricflow_env` progress on the `global` topic). Execution goes through the user's dbt: `dbt show --inline` (`semantic/execute.py`).
- **Compatibility:** `semantic/compat.py` (dbt-core × Python × YAML spec, plus the optional `mf` CLI's dbt-metricflow ranges in `compat_data.py`). When MetricFlow can't run, routes answer 409 `{error, message, status}`, and `MetricFlowCompatDialog` offers compatible dbt-core versions (latest patch of each compatible minor, both directions), pip's dry-run diff, requirement-pin updates, then installs through the global-setup stream, verifies (`dbt --version`, `dbt parse`) and offers Revert. "Continue without MetricFlow" sets `projects.metricflow_mode = off`.
- **Freshness:** a YAML change in a project with a semantic layer schedules a silent `dbt parse` 1.5 s later (`semantic/autoparse.py`, skipped while the runner is busy); every dbt command rewrites `semantic_manifest.json`, so `graph_changed` refreshes the UI.
- **Health:** the Semantic Layer tab runs MetricFlow's validations (and optionally `LIMIT 0` per metric through `dbt show`), stored as `semantic_check_snapshots`; `summarize_semantic()` adds it to the overview, tab badges and nav dot.
- **Metric explorer (plan 08):** the Metrics page keeps the query in the URL; the SQL pane follows `POST /semantic/explain` (debounced, no warehouse). Run calls `POST /semantic/query` with `cache: refresh`; on load the page shows the stored result for the same request (`/semantic/query/cached`). `semantic/query_service.py` validates (`query_spec.py`) → explains → keys the result by (project, target, env fingerprint, sql hash) → runs one shielded `dbt show` per key (concurrent identical requests share it, a closed tab doesn't cancel it) → stores it in `metric_query_results`. Turning on cache-first later is the `cache: prefer` policy plus a staleness rule. `semantic/batch.py` runs many queries in one `dbt show` for plans 10–11. Save as saved query splices YAML via `dbt/schema_saved_queries.py` (re-parse verified).
- **Semantic drafts (plan 09, Pro):** `app/ai/semantic_draft.py` collects the facts' inputs (warehouse columns + types via the batch probe, a 500-row sample, the semantic manifest), wickd_pro drafts (heuristics, then the LLM under a JSON schema whose enums are the facts' columns), the sidecar's `validate_draft` op merges the draft into semantic_manifest.json in memory and reports only the errors it adds (falling back to the heuristic draft when the AI's breaks a rule), and `semantic/batch.py` runs every metric's LIMIT 5 smoke query in one `dbt show`. Files: the model's schema YAML (`dbt/schema_semantic.py`: legacy top-level entries or latest-spec keys on the model and its columns, re-parse verified) and optional time spine files; partial accept re-renders the YAML for the chosen items (`ai/selection.py`), dropping metrics whose inputs were rejected.
- **Metric-aware Query data (plan 09, Pro):** `api/ai_query.py` first asks wickd_pro.ai.metric_query for a MetricFlow request (catalog names as schema enums; filters structured, rendered into `where` templates in wickd_pro) when the project has metrics and MetricFlow can query; the payload keeps `metric_request` and MetricFlow's SQL, and Run executes it through `semantic/query_service.py`. Edited SQL runs as plain SQL; questions the metrics don't cover fall back to written SQL.

- **Metric dashboards (plans 11–12):** files `<DASHBOARDS_PATH>/<slug>.yml` (default `wickd/dashboards`, a project env var; always inside the project). `semantic/dashboards.py` validates them with Pydantic (`extra="allow"`, so unknown keys round-trip; empty lists dropped on write; temp file + rename), lists invalid files with their error and reads plan 11's `tiles:` format as widgets (`upgrade_legacy()`). A dashboard has `period: {current, compare}` (presets stored relative; `semantic/dashboard_periods.py` resolves them, `previous_period` = same length right before, `previous_year`), `grain` (auto by period length), `canvas_width` (fixed px, default 1200, so widgets keep their size whatever the window or the builder's rails do), `filters` and `widgets` (`type` summary/timeseries/bar/leaderboard/table/text, `width` (% of `canvas_width`) / `height` (px) flowing in list order (old `w`/`h` grid units converted on read), `metrics`, `filters`, a per-key `period` override, type-specific `options`). `semantic/dashboard_plan.py` (pure) turns each widget into role-tagged queries — summary `total`/`trend`, others `current`, each with a `*_previous` for the comparison (no limit there; matched by key) — merging dashboard filters only where every referenced dimension is shared by the widget's metrics (otherwise a note); bad options or vanished metrics break only that widget. `semantic/dashboard_refresh.py` explains every query (the SQL is the cache key, as in the explorer), returns stored results on open, and on Refresh runs the unique SQLs in one `run_many()` and stores each in `metric_query_results` (now 400 per project). Register as exposure is `semantic/dashboard_exposure.py` + the `dbt/schema_exposures.py` splicer. The watcher publishes `dashboards_changed` for files in the folder. Frontend (`Metrics/dashboards/`): `builder/DashboardBuilder.tsx` — Metrics rail and Widgets rail floating over a fixed-width, centred, scrollable canvas (rails are drop targets that refuse drops; the board's right edge drags its width), in one dnd-kit DndContext (`useBuilderDnd`: metric onto a widget adds it via `addMetric()`'s rules, onto empty space or the sticky drop zone starts a summary; palette types insert; widgets reorder by grip), `useDashboardEditor` (undo history + autosave 700 ms after a change, 409 conflict when the file changed on disk), period bar with react-day-picker calendars, resize by edges or corner (pointer capture; capped at the room left in the row so the widget never wraps itself; lock points at quarter widths / the rest of the row and at 100 px heights / row neighbours' heights), click a bar / stacked segment / Top N row to show it over time (the widget splits top and bottom; `drill.ts` narrows the query the widget ran and groups it over time, run with `cache: prefer`; a stacked segment picks the bar's and the stack's values, the space above a bar the bar's alone), right-click a value (bar, segment, Top N or table row) for show timeseries / apply as dashboard filter / Drill into… (`InspectDialog`: draft widgets from `drilledWidgets()` — summary, time series, a horizontal bar breakdown by the first shared dimension no filter references (`breakdownDimension()`), table by period (table `period_grain`) — filtered to the pick and run through `POST …/preview` (`dashboard_refresh.preview()`), each configurable with `builder/WidgetSettings.tsx`, the builder's Configure pane; Add to dashboard inserts the chosen drafts after the source widget with `withUniqueIds()`) / open in explorer, Present; changed widgets without a stored result run automatically after a save; renderers in `widgets/`; pure helpers in `dashboardModel.ts` / `periods.ts` (the TS period resolution mirrors the backend's). Pro monitor overlays (status pill; band + flagged points on an unfiltered, unsplit single-metric time series at the monitor's grain). Exports (`lib/dashboardExport/`): HTML clones the rendered grid with the app's CSS (no `@font-face`/`url()`), the results as embedded JSON and a small hover runtime; PNG composes one SVG from the on-screen layout (no `foreignObject`, which taints WebKit canvases), written by `POST /exports/dashboard`.
- **Metric monitors (plan 10, Pro):** `semantic/monitors.py` groups due monitors by target (pinned or active), refreshes weekly top slices in one batch (`totals_query` → `wickd_pro.anomaly.slice_values`), then explains every monitor's series (`metric_time__<grain>` + the slice dimension filtered to its top values, `start` = the lookback on a first check, else the trailing 35 days / 14 weeks / 14 months; `semantic/monitor_queries.py`) and runs them in one `dbt show` (`batch.run_many(target=)`). Rows are upserted into `metric_monitor_points` (periods gone from the window become gaps; `previous_value` only when the old value was stored after its period ended), then `wickd_pro.anomaly.detect()` (via the `semantic/anomaly.py` shim) scores the stored history: seasonal-median baseline, robust z on recent residuals, CUSUM level shifts, missing/zero periods, restatements, partial current period. Triggers: `schedule_after_run()` from `_persist_results_after_run()` (monitored metrics whose `parent_map` ancestors include a node the run built successfully; entitlement checked in the background task), Check now, and a scheduler loop (every 5 min) for projects with `MONITOR_INTERVAL_HOURS`. One check per project; requests during one merge into a single follow-up. `summarize_metric_monitors()` feeds the Health overview card and nav dot; the DAG and Impact read `['metric-monitors', id]`.

### 11. SQL Workspace

`WorkspacePage` (`routes/Project/Workspace/`) is a standalone SQL scratchpad with its own file tree, editor, and results pane. It does **not** use `DbtRunner` — it calls `asyncio.create_subprocess_exec` directly to avoid publishing `run_started`/`run_finished` events and keep the Run panel quiet.

**Compile** (`POST /api/projects/{id}/workspace/compile`):
1. Calls `dbt compile --inline "<sql>" --output json`
2. Parses the JSON response — handles dbt 1.10+ `{"compiled": "..."}` and older `{"results":[{"node":{"compiled_code":"..."}}]}` formats
3. Returns `{ compiled_sql }` to the frontend

**Run** (`POST /api/projects/{id}/workspace/run`):
1. Calls `dbt show --inline "<sql>" --limit <n> --output json`
2. `_parse_show_output()` tries multiple JSON shapes (`results[0].table`, `show[*]`) for cross-version compatibility
3. Returns `{ columns, rows }` (limit clamped 1–5000; existing `LIMIT` clause in SQL is respected and takes precedence)
4. Results persist in `sessionStorage` so they survive navigation within the session

**Workspace path** (`GET /api/projects/{id}/workspace/path`):
- Reads `WORKSPACE_PATH` from `project_env_vars`; defaults to `"workspace"`
- Creates the directory if it does not exist; returns both absolute and relative paths
- All SQL files are enforced to have a `.sql` extension on creation

**Frontend layout** (three resizable panels):
- Left: file tree (add/delete/rename files and folders; filter bar) + Database Explorer (resizable vertical split)
- Center: Monaco editor with Code / Compiled SQL tabs; Cmd+S saves, Cmd+Enter runs; SQL formatter (Jinja-aware)
- Right: query results pane (drag to open/resize/close); shows row count and query timestamp

**Autocomplete** (`Monaco registerCompletionItemProvider` on `'sql'`):
- `ref('` → lists all models/seeds/snapshots with materialization + schema detail
- `source('schema',` → lists source table names for the given schema
- `source('` → lists all source schema names
- `FROM`/`JOIN <word>` → lists models as `{{ ref('...') }}` and sources as `{{ source('...', '...') }}`
- Column names after `SELECT`, `WHERE`, `ON`, etc. — scoped to models referenced in the current SQL statement
- Completions are prefix-filtered and ranked (exact match first, then alphabetical)

**Cmd+click navigation** — `ref('model')` and `source('schema', 'table')` spans are underlined when Cmd/Ctrl is held. Clicking navigates to `/projects/:id/files?model=<unique_id>`, which the File Explorer resolves to the model's source file and rewrites (with replace) as `?path=<file>`. `?path=` is the File Explorer's open file, so opening files is part of the header's back/forward history.

Session state (`sessionStorage`) persists open file path, expanded tree nodes, active tab, and last query results across navigation within a browser session.

### 12. Health Check (dbt debug)

`POST /api/projects/{id}/debug` → `debug.py`:
1. Loads project env via `load_project_env()` and reads active dbt target
2. Runs `dbt debug` via `runner.stream(req)` — streams stdout into a buffer
3. Publishes `health_check_started`; stores raw log output
4. `dbt/debug_parser.py` → `parse_debug_output()` extracts:
   - dbt/Python/adapter version strings
   - Active profiles dir, profile name, target name
   - Per-check status rows (`ok | fail | warn | info`) for connection, profile YAML, project YAML, etc.
5. Publishes `health_check_finished` with the full result payload
6. The result (plus `requested_target`, the DBT_TARGET it ran with) is stored in `app_settings` under `health_check:{project_id}`; `GET /api/projects/{id}/debug/last` returns it without re-running. While it runs the project id is in `debug.running_debug`, so the health summary reports `running` to every view

`HealthCheckPanel.tsx` (Health → "Connection" tab):
- Shows per-check status table (green tick / red x / amber warn / info)
- Displays version info block and raw log accordion

### 13. Schema Drift

`POST /api/projects/{id}/drift` (202 Accepted) → `drift.py`:
1. Creates a `DriftSnapshot` DB row with `status=running`
2. Launches `_run_drift_check()` as a background asyncio task (one per project; concurrent requests return 409)
3. Reads manifest via `load_manifest()` and filters to eligible models (`is_eligible_for_drift_check` — tables, incremental, seeds, snapshots); the rest are counted by materialization into `skipped_json` (`skipped_counts()`)
4. In batches of `PROBE_BATCH_SIZE` (25) models:
   - `probe_many_warehouse_columns()` runs one `dbt show --inline` via `runner.run()` (silent — no bus events) whose Jinja calls `load_relation(ref(...))` then `adapter.get_columns_in_relation()` for every model in the batch and prints the columns as one JSON line (`null` for a relation that doesn't exist → `not_built`, reported separately from drift and errors). Metadata only, no table scans; one dbt startup per batch instead of per model (dbt can't run in parallel per project, so batching is the speed-up)
   - If the batch fails as a whole (one bad relation fails the compile), each of its models falls back to `probe_warehouse_columns()` (`select * … --limit 1`) so per-model errors are kept
   - `diff_columns()` compares manifest-declared columns against warehouse columns and attaches the warehouse data type (`warehouse_type`; empty for single-model fallbacks). Types are shown in `DriftPanel` but not compared yet — `type_mismatch` is always false until declared types are normalised per adapter
   - Publishes `drift_progress` when each batch starts and per model, with `checked / total` and the batch's `batch_start`/`batch_end`; `DriftPanel` shows "Checking 26–50 of N…" (`lib/driftProgress.ts`)
5. Writes all results to `drift_snapshots.results_json` and sets `status=done`; publishes `drift_finished`
6. `GET /api/projects/{id}/drift` returns the latest snapshot; `GET /api/projects/{id}/drift/{id}` returns a specific one
7. `POST /api/projects/{id}/drift/{id}/recheck` re-probes one model (batch of one, same fallback), replaces its row in the snapshot and publishes `drift_finished` with `recheck: <unique_id>`

`DriftPanel.tsx` (Health → "Schema Drift" tab):
- Header: issue summary, models checked vs. skipped by materialization, the target scanned; stale notice from the health summary
- Live progress via SSE (`drift_started` resets it, `drift_progress`, `drift_finished`)
- `drift/DriftResults.tsx`: model search, filter pills, groups Drifted / Not built / Errors, and an expandable In sync list. Rows start collapsed (one-line summary such as `2 warehouse-only · 1 manifest-only`) when more than 5 have issues
- `drift/ModelDriftRow.tsx` actions: re-check (↻), Build model for not-built models or manifest-only columns (`dbt build --select <uid>`, then re-checks on `run_finished`), Open YAML (`yaml_path`, for manifest-only or warehouse-only columns), Document N warehouse-only columns
- Interrupted snapshots (server restart mid-scan) are reset to `status=error` on startup

### 14. Model Column Profile

`POST /api/projects/{id}/models/{unique_id}/profile` → `models.py`:
1. Runs `dbt show --select <uid> --output json` against the full materialized table via `runner.run()` (silent)
2. `dbt/profile.py` → `build_column_profile()` computes per-column stats: row count, null count/pct, distinct count, min, max, and up to 5 sample values
3. Returns `ProfileResponseDto { columns: [ProfileColumnDto] }`

`ProfilePanel.tsx` (SidePane → "Profile" tab):
- Appears alongside the Properties tab when a model is selected in the SidePane
- Shows a compact stats table per column (rows, nulls%, distinct, min, max, sample)
- Only available for models that are materialized (not ephemeral/view on unsupported adapters)

### 15. File Watching

`WatcherManager` runs a single `watchfiles.watch()` on a dedicated thread over the deduplicated roots (every project dir + each repo's `.git` dir, nested roots collapsed), so startup never blocks the event loop and projects sharing a repo watch its `.git` once. A watch filter on that thread drops noise (`.git/objects`, `logs/`, `dbt_packages/`, Python envs), and each batch is routed to the owning project(s) on the event loop — a `.git` change goes to every project in that repo. The supervisor re-reads the project list every 10s and restarts the watcher only when the plan changes. Project changes that matter: `models/`, `tests/`, `seeds/`, `snapshots/`, `macros/`, `analyses/`, `target/`.

- `manifest.json` / `run_results.json` changes → `graph_changed`
- `.sql` / `.yml` / `.yaml` changes → `files_changed`

### 16. Command Palette

Two separate palettes, since the homepage sits outside `ProjectLayout` and has no project context to build project-scoped commands from:

- **Homepage** (`Home.tsx` + `components/HomeCommandPalette.tsx`) — its own ⌘K / Ctrl+K listener opens `HomeCommandPalette`, offering "Open [project name]" for every non-ignored project plus New project / Rescan projects / Global settings actions.
- **Inside a project** — `ProjectLayout.tsx` listens for ⌘K / Ctrl+K globally and opens `CommandPalette.tsx` (portal-rendered at z-[60]). The palette provides:

**Navigation commands** (always visible when query is empty):
- Go to [page name] for each project route (DAG, Files, Docs, Workspace, Git, Environment, Init, Health)

**Project actions** (always visible):
- Run / Build / Test all models
- Generate docs
- Check health → navigates to `/health?tab=overview`
- Run all health checks → navigates to the overview and starts dbt debug, the drift scan and source freshness (queued on the per-project dbt lock)
- Check connection (dbt debug) → navigates to `/health?tab=connection` and runs `dbt debug`
- Check source freshness → navigates to `/health?tab=source-freshness` and triggers freshness scan
- Check schema drift → navigates to `/health?tab=schema-drift` and triggers drift scan
- Ask Wicky… → opens the Wicky pane and focuses its input

**Wicky** (appear whenever text is typed, listed last so Enter still runs a matching command):
- Ask Wicky: [text] / Query data: [text] → `openWicky()` (`lib/wickyEvents.ts`, `wickd:open-wicky` window event) opens the Wicky pane, switches it to Ask or Query data and sends the text with the selected node as context. The request waits until Wicky is ready; if a reply is still streaming, the text is left in the input instead

**Model commands** (appear when searching):
- Show DAG, Open file, View docs, Run, Run upstream/downstream, Build, Test [model name]

Behavior:
- ⌘K with empty query shows Navigation + Project sections only (50 results max)
- Typing filters all sections with substring match, ranked: nav → project → model
- Arrow keys navigate, Enter executes, Escape or backdrop click closes
- Re-pressing ⌘K while open closes the palette

**Health page `?tab=` deep-link**:
- `/health?tab=overview` activates the Overview tab (the default)
- `/health?tab=connection` activates the Connection (dbt debug) tab
- `/health?tab=source-freshness` activates the Source Freshness tab
- `/health?tab=schema-drift` activates the Schema Drift tab
- `/health?tab=test-gaps` activates the Test Gaps tab (Pro)
- Links from the command palette use these params to pre-select the tab even if the page is already mounted

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WICKD_PROJECTS_PATH` | _(none)_ | Root directory scanned for dbt projects; overridable via Global Settings UI |
| `WICKD_DATA_DIR` | `<repo>/data` (dev) / `~/Library/Application Support/com.lampherelabs.wickd` (desktop app, passed in by the Tauri shell) | App storage: SQLite database, dbt venv, generated docs, API logs. Not a user-facing setting — the dev default is fixed and the desktop app sets it from Tauri's `app_data_dir()` |
| `WICKD_DATABASE_URL` | _(derived from DATA_DIR)_ | Override SQLite path |
| `WICKD_LOG_LEVEL` | `INFO` | structlog level |
| `WICKD_LLAMA_SERVER_PATH` | _(bundled copy, then `PATH`)_ | llama-server binary for local AI — see Key Flows → Local AI |
| `WICKD_METRICFLOW_MODE` | `auto` | Default MetricFlow mode when the `metricflow_mode` app setting is unset |
| `WICKD_METRICFLOW_VENV_DIR` | `<data_dir>/metricflow-venv` | The MetricFlow sidecar venv (engine only, no dbt) — see Key Flows → Semantic layer |
| `WICKD_FRONTEND_DIST` | `frontend/dist` (dev) / resolved next to the packaged binary | Directory the SPA is served from — see `_mount_spa()` |
| `POLAR_USE_SANDBOX` | `true` | Which Polar environment to validate license keys against — sandbox or production |
| `POLAR_SANDBOX_ORGANIZATION_ID` | _(none)_ | Polar sandbox org id (not a secret) |
| `POLAR_SANDBOX_API_KEY` | _(none)_ | Polar sandbox API key — secret, `backend/.env` only, never committed |
| `POLAR_PRODUCTION_ORGANIZATION_ID` | _(none)_ | Polar production org id (not a secret) |
| `POLAR_PRODUCTION_API_KEY` | _(none)_ | Polar production API key — secret, `backend/.env` only, never committed |
| `POLAR_SANDBOX_CHECKOUT_URL` | _(none)_ | Polar sandbox checkout link, surfaced in the frontend upgrade modal |
| `POLAR_PRODUCTION_CHECKOUT_URL` | _(none)_ | Polar production checkout link, surfaced in the frontend upgrade modal |
| `POLAR_SANDBOX_ORGANIZATION_SLUG` / `POLAR_PRODUCTION_ORGANIZATION_SLUG` | `lamphere-labs` | Public org slug → `settings.polar_portal_url` (`https://polar.sh/<slug>/portal`, or `sandbox.polar.sh` when `POLAR_USE_SANDBOX`), returned as `portal_url` by `GET /api/license`. Shown under every license key input ("Lost your key…") and in Settings → Subscription. Empty string hides it |

`dbt_venv_dir` (`Settings`, not an env var): the isolated venv `dbt` runs from — `<repo>/data/dbt-venv` in dev (kept separate from the backend's own `backend/.venv`), or `<data_dir>/dbt-venv` in the packaged app; overridable with `WICKD_DBT_VENV_DIR`. Self-created on first use of `venv_dbt()`/`venv_pip()`/`venv_python()` from the `python_path` global setting (auto-detected on first launch: the interpreter an existing venv was built from, else the first Python 3.11+ found — see `app/dbt/venv.py` and `app/dbt/python_env.py`). Changing `python_path` rebuilds the venv, so dbt and adapters must be reinstalled via global setup. `venv.create()` is never run from the app's own (possibly frozen) interpreter — doing so from a PyInstaller-frozen binary causes `ensurepip` to recursively re-exec the whole app.

Global settings (stored in `app_settings` table, set via UI):

| Setting key | Description |
|---|---|
| `dbt_projects_path` | Overrides `WICKD_PROJECTS_PATH` |
| `global_requirements_path` | Absolute path to a `requirements.txt` installed into the dbt venv on every project open |
| `dbt_core_version` | dbt-core release global setup installs when no `global_requirements_path` is set (UI label `WICKD_DBT_CORE_VERSION`); missing/empty = latest. Chosen in the setup wizard. Cleared when a requirements path is saved; refused while one is set (the file decides) |
| `log_level` | Overrides `WICKD_LOG_LEVEL` |
| `metricflow_mode` | Semantic layer default for projects without their own `metricflow_mode` (UI label `WICKD_METRICFLOW_MODE`): `auto` (default) or `off`; overrides the `WICKD_METRICFLOW_MODE` env var |
| `python_path` | Python 3.11+ interpreter the dbt venv is built from (UI label `WICKD_PYTHON_PATH`). Auto-detected on first launch; changing it rebuilds the venv. Not editable in a source checkout |

Per-project env vars (stored in `project_env_vars`, injected into every dbt subprocess via `load_project_env()`):

| Key | Set by | Description |
|---|---|---|
| `REQUIREMENTS_PATH` | Environment tab (UI) | Path to a project-specific `requirements.txt`; installed during `base: pip install` |
| `dbt_target` | Target dropdown (UI) | Active dbt target; passed as `--target` on every dbt invocation |
| `WORKSPACE_PATH` | Environment tab (UI) | Relative path to the SQL workspace directory inside the project (default `workspace`) |
| `PROPAGATE_TAGS` | Environment tab (UI) | Comma-separated column tags traced through lineage on the Docs Tags tab (default `pii,sensitive`) |
| `DASHBOARDS_PATH` | Environment tab (UI) | Folder inside the project for metric dashboard YAML files (default `wickd/dashboards`) |
| `MONITOR_INTERVAL_HOURS` | Environment tab / Metrics → Monitors (UI) | Metric monitors' automatic check while wickd is open, in whole hours ≥ 1 (Pro; unset = off) |
| _(any exported var)_ | Init scripts automatically | Any `export KEY=value` in a custom init script is captured and upserted here after the step succeeds; persists across restarts |

`load_project_env()` builds the subprocess env as: `os.environ` + `project_env_vars` rows + active profile vars (from `env_profiles` / `profile_env_vars`).

---

## Running Locally

```bash
task install          # create venv, pip install, npm install
task start            # backend (:8001) + Vite dev server (:5173) in parallel (foreground, logs to terminal)
```

The Vite dev server proxies all `/api` requests to `localhost:8001`. Open [http://localhost:5173](http://localhost:5173).

To choose a specific Python interpreter:

```bash
task install PYTHON=python3.12
```

---

## Design Decisions

**Subprocess over dbt Python API** — the dbt Python API is not safe for concurrent use; it modifies global state and is not re-entrant. Using a subprocess per invocation isolates execution completely and allows streaming stdout line-by-line.

**SSE over WebSockets** — All real-time communication is server→client. SSE is sufficient, simpler, and has built-in browser reconnect.

**In-memory event bus** — A Redis or database-backed queue would add ops overhead for a local-only tool. The in-memory bus is zero-config and fast enough; events lost on restart are acceptable (the next page load re-fetches current state from disk).

**Replay buffer for PTY sessions only** — Run log events are ephemeral (run_results.json is the durable record). PTY output has no equivalent durable store, so the replay buffer fills that gap for both the init terminal and the integrated bash terminal.

**RunPanel always mounted** — The bottom pane can be collapsed, but `RunPanel` must always receive `run_log` SSE events. It renders with `height: 0` when hidden rather than unmounting, so no events are lost mid-run.

**Lazy clear on new run** — `runNodeIds` is not cleared on `run_started`. It clears when the first `START` log line of the new run arrives. This keeps the previous run's Execution DAG visible until actual execution begins.

**SQLite** — Single-user, local tool. No concurrent writes from multiple processes. SQLite with aiosqlite is zero-ops and sufficient.

**`_effective_workspace()` as single source of truth** — The projects path can come from the `app_settings` DB table (set via UI) or `settings.dbt_projects_path` (the `WICKD_PROJECTS_PATH` env var). All backend code that needs the workspace path calls this one function.

**SidePane as a unified panel** — The right-side panel (DAG and File Explorer) intentionally has no tab bar. Model metadata and run controls live in one scrollable view. Separating them into tabs added navigation friction with no benefit since both are used together during a typical run-and-inspect workflow.

**SidePane upstream/downstream chips** — "Refs / Sources" (upstream nodes) and "Referenced By" (downstream nodes) are shown as chips derived from graph edges at render time. "Referenced By" is collapsed by default behind a header with its count (a widely used model can have dozens of children, tests included); its open state persists while switching nodes. Cmd+clicking a chip calls `onNavigateToFile(path)`, which in FileExplorer expands the tree and opens the file. Chips without a navigable `original_file_path` render in muted style with no hover effect.

**NavRail collapse state in localStorage** — The left sidebar collapse state persists in `localStorage` under `nav-rail-collapsed`. Navigating between pages or clicking a nav icon while collapsed never re-opens the rail; the collapsed state is only changed by clicking the toggle chevron at the bottom of the rail.

**Project-local `profiles.yml`** — Each project carries its own `profiles.yml` rather than relying on `~/.dbt/profiles.yml`. This makes projects self-contained and portable. `DbtRunner.build_args()` adds `--profiles-dir` automatically when the file is present, so existing projects without one continue to use the global fallback. `ensure-profiles-yml` writes a minimal stub after `dbt init` so new projects are immediately usable.

**dbt target stored in `project_env_vars`** — The active dbt target (`dev`, `prod`, etc.) is persisted as a `project_env_vars` row with key `dbt_target`, passed as `--target` on every invocation. This keeps target selection durable across sessions without adding a new DB column or migration.

**Global profiles as reusable env var templates** — `global_profiles` / `global_profile_vars` store named env var sets that are not tied to any project. They serve as templates that can be imported into project profiles, enabling teams to share common variable sets (e.g., a "prod credentials" profile) without duplicating them per project.

**Requirements install in the dbt venv** — `pip install -r <requirements.txt>` targets the pip binary co-located with the `dbt` executable (`venv_pip()`). This ensures packages install into whichever Python environment dbt actually runs in, not the app's own venv. A global path (for shared adapters or tools) and a per-project path (for project-specific packages) are both supported and installed in sequence.

**`runner.run()` for silent invocations** — `DbtRunner.stream()` publishes `run_started`/`run_log`/`run_finished` events to the bus, which the Execution DAG follows. Operations like schema drift checks and column profiling run `dbt show` repeatedly and should not appear as user-visible runs. `runner.run()` uses the same per-project lock and env setup but returns `(returncode, stdout, stderr)` without emitting any bus events.

**Schema drift stored in SQLite** — `drift_snapshots` persists the full results_json so the last drift report survives server restarts. A single in-memory `_running` dict (project_id → asyncio.Task) prevents concurrent drift scans per project. Interrupted snapshots are auto-corrected to `status=error` on startup.

**dbt debug result persisted in app_settings** — `dbt debug` is quick (~1s) but re-running it on every page load is unnecessary. The last result is stored under `health_check:{project_id}` in `app_settings` and served by `GET /debug/last` until explicitly re-triggered.

**Health summary** — `GET /health/summary` reduces the three checks' stored results to `{status, headline, issues, finished_at, target, stale_reasons}` each (pure logic in `app/health/summary.py`). It feeds the Health Overview cards, the tab badges and the dot on the nav rail's Health item (`useHealthSummary`, query `['health-summary', id]`, invalidated by the health/drift/freshness start/finish events and `statuses_changed`). Stale reasons: the active target differs from the one the result was produced with; for drift, scanned models that ran successfully after the scan; for connection and freshness, results older than a day.

**All dbt commands use the venv binary** — `venv_dbt()` / `venv_pip()` / `venv_python()` in `dbt/venv.py` resolve binaries relative to `settings.dbt_venv_dir` (`data/dbt-venv` in dev; `<data_dir>/dbt-venv` in the packaged app, created on first use). This ensures adapter packages installed during setup (e.g. `dbt-snowflake`) are available to every dbt invocation regardless of what's on `$PATH`.

**Docs generation bypasses `runner.stream()`** — `dbt compile --write-catalog` and `dbt docs generate` are invoked directly (not via `DbtRunner`) so they emit `compile_started`/`compile_finished` or `docs_generating`/`docs_generated` events but never `run_started`. This prevents the frontend from switching to the Run tab when docs are generated.

**Init-script env var capture** — exported shell vars are captured by sourcing each script a second time in a `set -a` subshell and diffing `export -p` output against the parent env. Captured vars are upserted into `project_env_vars` so they survive server restarts and are injected into all future dbt subprocesses via `load_project_env()`. This requires no changes to the shell scripts themselves.
