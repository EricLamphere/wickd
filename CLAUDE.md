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

```
backend/app/
  api/            — FastAPI routers, one file per resource (semantic, metric_monitors, test_gaps, ai_model, ai_chat, ai_proposals, ai_query, projects, models, document, runs, files, docs, init, init_script_test, env, sql, terminal, settings, global_env, global_profiles, git, debug, drift, freshness, health_summary, column_lineage, license, impact, performance, propagation, refactor, ai_proposal_apply)
  db/
    models.py     — All SQLAlchemy models (12 tables)
    engine.py     — get_session dependency
    migrations.py — DDL-on-startup migrations
  dbt/
    runner.py     — DbtRunner singleton; subprocess execution + serialization lock; .stream() publishes bus events; .run() is silent (returns stdout/stderr)
    select.py     — build_selector(name, mode) → --select string
    manifest.py   — Parse target/manifest.json; semantic_models / metrics / saved_queries become nodes (resource_type semantic_model / metric / saved_query) with `label` and a `semantic` dict built by semantic_nodes.py (defensive across dbt 1.7–1.12 and both YAML specs; unit-tested against real manifests in tests/fixtures/semantic/)
    run_results.py — Parse target/run_results.json (load_run_results_file(): per-node timing window/thread/adapter_response + elapsed_time/threads)
    init_scripts.py — Read/write init/{script_path}/*.sh scripts per project
    interactive.py — InteractiveInitManager (ptyprocess PTY sessions; reused for terminal too)
    debug_parser.py — parse_debug_output() → structured DebugResult from dbt debug stdout
    custom_command.py — parse_custom_command() → ParsedCommand; shlex-tokenizes user-entered dbt commands, blocks `init`/`docs serve`, detects --select/--target/--profiles-dir
    changes.py    — map_changed_files(manifest, files, resource_dirs) → ChangeMapping (nodes→reasons, unmapped, project_wide, relevant_files): changed files → model/seed/snapshot/source/exposure nodes via original_file_path, patch_path (schema YAML) and root-project macros (transitively through depends_on.macros); resource_dirs_from_project_yml(); pure, unit-tested in test_changes.py
    drift.py      — diff_columns() + is_eligible_for_drift_check() — column schema diff helpers
    probe.py      — probe_warehouse_columns() — a built node's real column names via `dbt show --inline`; shared by drift and the docs generator. probe_many_warehouse_columns() — many nodes in one `dbt show` (Jinja `adapter.get_columns_in_relation`, `[name, data_type]` pairs as a JSON line after BATCH_MARKER; ProbeResult.types); drift scans in batches of 25 and falls back per node if a batch fails
    schema_descriptions.py — set_descriptions(): splices `description:` lines for a node + columns into schema YAML text (fill empty, or overwrite), re-parse verified, pure; used by AI docs
    schema_tests.py — add_column_tests() / add_model_tests() (model-level, e.g. dbt_utils.unique_combination_of_columns): splices generic data tests (DataTestSpec) under a node's columns (`data_tests:`/`tests:` per file + dbt version; `arguments:` on 1.10+), re-parse verified, pure
    schema_saved_queries.py — add_saved_query(): a `saved_queries:` entry (Metrics → Save as saved query), group_by_template(); re-parse verified, pure
    schema_semantic.py — render_legacy() / render_latest(): a drafted semantic model + metrics (wickd_pro to_yaml_items()) spliced in either spec (legacy top-level entries; latest keys on the model entry + its columns); chosen_metrics() drops metrics whose inputs aren't kept; re-parse verified, pure
    schema_yaml.py — plan_document_node() (no write) / document_node() — docs generator: adds `- name:` entries for a model/seed/snapshot + columns to its schema YAML (patch_path file → folder YAML with the resource key → new schema.yml). Never re-serialises: ruamel.yaml only locates line positions, new lines are spliced in matching the file's indent style, and the result is re-parsed and verified before writing
    column_lineage.py — wickd Pro feature (gated via app/licensing). Public shim only: defines the real, always-importable ColumnRef/LineageJob dataclasses (required at import time by api/column_lineage.py) and lazily delegates prepare_lineage_jobs()/trace_job()/trace_job_full() (projection lineage + row dependencies; falls back to no row deps on older Pro builds, see supports_row_dependencies())/build_column_lineage() to the private `wickd_pro` package (separate repo), raising ColumnLineageUnavailable if it isn't installed. The actual sqlglot-based tracing algorithm (case-insensitive matching, UNPIVOT stripping, etc.) lives in wickd-pro, not this repo.
    profile.py    — build_column_profile() — per-column stats from dbt show output
    show_parser.py — parse_show_json() — handles dbt 1.5+ and 1.11+ show output formats
  ai/             — Local AI (wickd Pro). catalog.py (pinned GGUF models + sha256), download.py (`downloader` singleton: resumable download into <data_dir>/models, checksum before rename, progress on the `global` topic), runtime.py (`llama_server` singleton: lazy llama-server process, idle stop, find_llama_server()), client.py (OpenAI-compatible stream_chat(), optional JSON-schema constraint, strips <think>), config.py (ai_model / ai_endpoint_url / ai_endpoint_model from app_settings), provider.py (endpoint else bundled), pro.py (public shim over private `wickd_pro.ai`: ask_messages / documentation_prompt / parse_documentation; AiUnavailable), gating.py (require_ai: 403 / 503), documentation.py (generate_documentation() → FileChange proposal; never writes), semantic_draft.py (generate_semantic_draft(): Add to semantic layer → kind "semantic" proposal with changes for the schema YAML + time spine files; draft_spec() never writes the latest spec below dbt 1.12 or into a legacy project; start_semantic_verify(): dbt parse + MetricFlow validation after applying), test_generation.py (generate_tests(): sample → schema-constrained suggestions → one-query warehouse pre-check → YAML splice), run_context.py (node_run_info(): latest status + tests' results from model_statuses; failing_rows() via dbt show), perf_context.py (node_performance_info(): last 20 runs + upstream medians + git commits/uncommitted diff of the node's SQL/YAML since then, for Ask Wicky `mode: explain_slow`), errors.py (ProposalError / NothingToPropose), sql_guard.py (validate_select() / for_dbt_show(): one read-only query, only literal ref/source Jinja, sqlglot per adapter dialect; wraps queries that have their own LIMIT), selection.py (rebuild(): a proposal's file for a subset of its items, from the summary's `plan` + original text — partial accept), file_ops.py (FileOp: check_apply/apply/check_undo/undo for a proposal file's op — modify/create/delete/rename — each refusing when disk doesn't match; used by per-file accept, Accept all and Undo in api/ai_proposal_apply.py); gating.py also has require_refactor() (Pro entitlement + engine, no AI model) and require_proposal_access(session, kind)
  semantic/       — Semantic layer (Base): MetricFlow in a dbt-free sidecar venv. sidecar_env.py (<data_dir>/metricflow-venv with only `metricflow==ENGINE_VERSION`, marker .wickd-metricflow, rebuilt on pin/interpreter change), worker_main.py (STANDALONE, no `app` imports, run by the sidecar's Python and shipped as a PyInstaller data file: JSON-lines ping/load/catalog/explain/dimension_values/validate/validate_draft (a draft merged into the semantic manifest in memory: only the errors it adds + a LIMIT 5 smoke explain per metric), render-only SQL client per adapter_type, stdout reserved for replies), runtime.py (`metricflow_runtime` singleton like ai/runtime.LlamaServer: lazy start building the sidecar with `metricflow_env` progress, idle stop, request ids, restart once on crash), service.py (target-path aware semantic_manifest.json + dialect → worker; manifest_info() with counts and semantic_hash; dbt_environment() cached `dbt --version`), execute.py (run_sql(): `dbt show --inline` through the runner), status.py (semantic_status(): available/can_query/mode/reason/compatible versions; project_spec() cache, forgotten on YAML changes), compat.py (check() dbt-core × Python × spec × want_cli, recommend(); data in compat_data.py generated by backend/scripts/metricflow_compat.py at release), spec.py (legacy/latest/mixed/none from YAML), pins.py (dbt-core requirement pins: find/would_undo/rewrite, pure), dbt_change.py (pip dry-run plan, pin updates, install args for the version dialog), check.py (Health check → semantic_check_snapshots), autoparse.py (debounced silent `dbt parse` 1.5 s after YAML edits, skipped while the runner is busy), mode.py (project metricflow_mode over the global default). pro.py (shim over private `wickd_pro.semantic`: semantic drafts; SemanticDraftUnavailable), query_spec.py (check_query/check_where: names + `where` limited to MetricFlow templates and a plain SQL condition; checked_sql() = one read-only SELECT), query_service.py (run_metric_query(): validate → explain → cache policy refresh/prefer/only → one shielded shared `dbt show` per cache key → store), query_cache.py (metric_query_results, key incl. env fingerprint), batch.py (run_many(): many queries in one `dbt show` via Jinja run_query + WICKD_METRIC_BATCH lines, resumes after a failure; for dashboards/monitors), saved_queries.py (Save as saved query: file choice + date filters; splicer in dbt/schema_saved_queries.py). Metric monitors (Pro, plan 10): anomaly.py (shim over private `wickd_pro.anomaly`: detect() / slice_values(); AnomalyUnavailable), monitor_queries.py (pure: history windows, slice filters, row parsing, affected_monitors() parent_map walk; tested), monitor_points.py (metric_monitor_points upsert/series/restatements/trim/suppress), monitors.py (request_refresh(): one check per project, merged follow-up; per target: weekly top slices batch → series batch via run_many(target=) → upsert → detect → last_result_json; schedule_after_run() from api/runs.py; interval scheduler loop for MONITOR_INTERVAL_HOURS). Routes in api/metric_monitors.py Routes in api/semantic.py; never import metricflow into the backend (its sqlglot is newer than the backend allows)
  health/
    summary.py    — summarize_connection/drift/freshness/semantic/metric_monitors(): stored results → CheckSummary {status not_run/running/ok/warn/fail, headline, issues, finished_at, target, stale_reasons}; pure, unit-tested; served by GET /health/summary (api/health_summary.py)
  propagation/    — Lineage propagation (wickd Pro). pro.py (public shim over private `wickd_pro.propagation`: inherit_descriptions / tag_flow / inherit_tags; PropagationUnavailable), inputs.py (pure: manifest → docs / declared tags / exposures / writable nodes; PROPAGATE_TAGS parsing), proposals.py (results → one "propagate" AiProposal with a file per schema YAML; render_file() is shared with partial accept in ai/selection.py; raw source descriptions keep doc blocks). Routes in api/propagation.py; YAML tags writer in dbt/schema_column_tags.py
  refactor/       — Refactors (wickd Pro): rename model / rename column / extract CTE. pro.py (public shim over private `wickd_pro.refactor`; RefactorUnavailable), inputs.py (project_files(): resource dirs + dbt_project.yml as {path: text}, no packages/target; describe(): "Rename column `a` → `b` in `m`"), service.py (run(): manifest + files + lineage → engine result; adds the YAML stub for an extracted model via plan_document_node()), verify.py (start_verify(): `dbt parse` via runner.run() after applying → result_json.verify {status, output}, announced with ai_proposal_updated; never reverts). Routes in api/refactor.py (POST /refactor, Wicky POST /ai/conversations/{cid}/refactor → `refactor` confirm-card message, cancel); proposals are kind "refactor" with file ops and `manual` review items
  test_targets/   — Smarter test suggestions (wickd Pro). ignores.py (ignore / unignore / list rows by key, table test_gap_ignores). pro.py (public shim over private `wickd_pro.test_targets`: rank_test_targets(manifest, lineage, row_deps, structure, unique_ids?); TestTargetsUnavailable), service.py (latest_inputs(): lineage_version 4 snapshot else LineageNotReady(reason); project_ranking() cached per snapshot + manifest mtime; targets_for_model() for Add tests, None when not ready), items.py (structural_tests(): candidates → test items; render_tests(): column + model-level tests into a node's YAML, shared by generation, batch and partial accept), batch.py (build_batch(): Test gaps rows → one "tests" proposal with `batch: true`, a file per schema YAML, pre-checked per model). Routes in api/test_gaps.py (GET /test-gaps, POST /ai/tests/batch). ai/test_generation.py adds the lineage-backed tests first and asks the LLM only when llm_ready() (ai/provider.py); without a model they're proposed alone (`result.note`)
  performance/
    pro.py        — public shim over private `wickd_pro.performance` (analyze_run / detect_regressions / recommend; PerformanceUnavailable); contract in the docstring
    inputs.py     — pure: invocation_model_results rows + manifest → the plain dicts sent to wickd_pro (run_nodes, run_parents, nodes_meta, regression_history, median_durations); unit-tested
  licensing/
    gating.py     — require_pro(session, *, available=…): 403 pro_feature_required / 503 when the Pro package is missing; used by Pro routes (performance, column lineage, AI)
    polar_client.py — thin async httpx client wrapping Polar's license-key validate/activate endpoints (sandbox or production per Settings.polar_use_sandbox)
    entitlements.py — check_entitlement() with 7-day grace-period cache (LicenseState) + 6h recheck interval; a definitive "not entitled" from Polar is always trusted immediately, bypassing the grace period
  events/
    bus.py        — EventBus singleton `bus`; in-process pub/sub
    sse.py        — sse_response(), sse_response_with_replay()
  projects/
    discovery.py  — Walk workspace for dbt_project.yml
    service.py    — Upsert projects to DB; _effective_workspace() for WICKD_PROJECTS_PATH; begin_startup_scan()/wait_for_startup_scan(): the startup rescan runs in the background (server answers immediately), project-list endpoints await it
    summary.py    — manifest_node_counts() for GET /projects/summaries (home page cards: one request for all projects; cached by manifest mtime/size)
    search.py     — build_index() / manifest_index() (cached by manifest mtime/size) / search_nodes(): node + column name search across projects for GET /projects/search (home page search box and ⌘K); pure ranking, unit-tested in test_project_search.py
  git/
    runner.py     — GitRunner singleton; subprocess + serialization lock per project; stream() publishes git_started/git_log/git_finished
    repo.py       — find_repo_root() walks upward for .git/; parse_porcelain_v2() parses git status --porcelain=v2 -z; parse_name_status_z() parses git diff --name-status -z
    changeset.py  — working_changes() / branch_changes(base) / resolve_base() / current_branch() over a GitCall; to_project_files() narrows repo paths to the dbt project; used by api/impact.py (GET /impact/changes?scope=working|branch&base=)
  files/
    ops.py        — plan_move()/move_paths()/copy_paths() (all-or-nothing, VS Code ` copy` naming), upload_target(), is_text_file(); pure fs ops behind api/files.py, unit-tested in test_file_ops.py
  watcher/
    service.py    — WatcherManager (ONE shared watchfiles thread for all projects, routes changes by path); also watches .git/HEAD, .git/index, .git/refs/ to emit git_status_changed

frontend/src/
  lib/
    api.ts        — All typed API fetch helpers (use these, never raw fetch in components)
    sse.ts        — useProjectEvents(), useInitSessionEvents(), useTerminalEvents() hooks
    navHistory.ts — pure back/forward bookkeeping (last 25 locations keyed by location.key; skips duplicate URLs); unit-tested in navHistory.test.ts (Vitest)
    navHistoryContext.tsx — NavHistoryProvider (wraps the app inside BrowserRouter) + useNavHistory(); browser history is the source of truth (arrows call navigate(±n)); also binds ⌘[ / ⌘] or ⌘← / ⌘→ (not while typing) and mouse back/forward buttons
    nodeSearch.ts — cross-project search helpers (nodeSearchUrl(): DAG by default, Files on ⌘; subtitle; unindexed-project notice), unit-tested; useNodeSearch.ts — debounced ['node-search', q] query over GET /projects/search
    dialogs.ts    — alertDialog/confirmDialog/promptDialog/alertError: promise-based in-app dialogs rendered by components/DialogHost.tsx (mounted once in App). Never use window.alert/confirm/prompt — the desktop app's WKWebView (wry) doesn't implement them, so confirm() silently returns false
    logLineTone.ts — logLineTone(line): error/warn/success/accent for dbt output; summary lines (`PASS=… WARN=… ERROR=… SKIP=…`, `Completed with …`) by their counts; used by LogPanel and Run History
    useUrlTab.ts  — useUrlTab(param, allowed, fallback, rememberKey?) — in-page tab state in a URL search param so tab switches are history entries. Used by Health (?tab=, remembered per project), project home file tabs (?file=), Docs browse tabs (?browse=) and Docs node/project detail tabs (?view=). Side/bottom pane tabs deliberately stay local state
  components/
    NavArrows.tsx — header back/forward buttons (right of the wickd home link)
    NodeSearchResults.tsx — Home page "Models & columns" results under the project grid while the search box has 2+ chars; HomeCommandPalette shows the same hits (Enter → DAG, ⌘Enter → Files)
  routes/
    Home.tsx      — Project list (respects WICKD_PROJECTS_PATH configured banner)
    Project/
      ProjectLayout.tsx  — Shared layout wrapper (outlet + BottomPane; outlet has overflow-auto for scrolling); global ⌘K listener
      lib/
        commandPaletteContext.tsx — React context + useCommandPalette() hook for open/close
        openInFiles.ts — useOpenInFiles(projectId) → { canOpen, open, handleClick }; shared Cmd+click "open node in Files" (used by Health drift/freshness panels and Run History detail pane)
        selectedNodeContext.tsx — SelectedNodeContext/SetSelectedNodeContext + useReportSelectedNode(uid) / useSelectedNodeId(); feeds the bottom pane's Node DAG tab. Also SelectedNodeIdsContext + useReportSelectedNodes(uids) for the DAG's Cmd+click multi-selection (empty unless 2+ nodes), which the Impact tab prefers over the single selection; and SelectedColumnsContext + useReportSelectedColumns(keys) for the DAG's column selection (`<uid>::<column>`), which in Selection mode starts column-level impact from those columns (picksFromColumnKeys() in columnImpact.ts)
        impact.ts — computeImpact(graph, seedIds) → seeds + downstream nodes grouped by shortest depth, per-node data/unit test counts, risk flags (untested/exposure/incremental/failing/stale) and summary; buildImpactSelector() → `a+ b+` for dbt build; unit-tested in impact.test.ts
        nodeTypeIcon.ts — typeIconFor(resource_type): glyph per node type, shared by ModelNode (DAG) and the Impact table
        wickyEvents.ts — openWicky({ question?, chatMode?, uniqueId?, mode? }) (uniqueId becomes Wicky's context until the page selection changes): `wickd:open-wicky` window event WickyPane listens for (opens the pane; sends the question once the chat is ready). Used by the command palette
        bottomPaneEvents.ts — openBottomTab(tab, { impactMode? }): `wickd:open-bottom-tab` window event BottomPane listens for (used by the SidePane impact card and the Git page ImpactSection)
        columnImpact.ts — computeColumnImpact(graph, lineage, seeds) → column-level reach (Pro): projection lineage narrows columns, row dependencies (filter/join/group) mark a model fully affected, untraced models assumed fully affected, affected tests; pickableColumns(); describeAffected() labels; unit-tested
        useColumnLineageData.ts — latest column lineage snapshot for impact (['column-lineage', id], shared with the DAG) + start(); `ready` needs lineage_version >= 2; `locked` on 403
        impactChanges.ts — ImpactMode ('selection' | 'working' | 'branch'); describeReason(s)() labels for why a node changed; seedIdsFrom()/reasonsByNode() over ImpactChangesDto; changeErrorMessage()
        useImpactChanges.ts — useImpactChanges(projectId, scope, base, enabled): query ['impact-changes', id, scope, base], invalidated on git_status_changed/files_changed/graph_changed
        nodeLineage.ts — buildNodeLineageGraph(graph, uid) → full `+uid+` subgraph; filterNodeLineage(lineage, uid, filter) applies Type/Materialization/Status (Type defaults to seed/source/model/exposure via defaultNodeDagFilter(); selected node always kept) and bridges edges across hidden nodes (dashed)
        useLiveRunStatuses.ts — main DAG's live run-status overlay parsed from run_log; holds each node in `running` ≥600ms (fast adapters finish in ms); owns the `statuses_changed` refetch and drops the overlay only after it lands, so nodes don't flash their pre-run color
        customCommand.ts — runCustomCommand() (POST /command, returns user-facing error or null) + per-project recent-command history in localStorage
      components/
        CommandPalette.tsx — VS Code-style palette; nav + project actions + model search; "Run custom dbt command…" (or typing `dbt …`) switches to CustomCommandMode.tsx; "Ask Wicky…" opens the Wicky pane, and any typed text is offered last as "Ask Wicky: …" / "Query data: …" (lib/wickyEvents.ts)
        CustomCommandMode.tsx — palette mode: free-form `dbt <command>` input + recent commands (lib/customCommand.ts)
      index.tsx          — Project homepage (README, dbt_project.yml, profiles.yml tabbed viewer)
      Models.tsx         — React Flow DAG page (/projects/:projectId/models); dragged node positions are kept per project until reload (lib/draggedPositions.ts, Reset layout button); ?model=<uid> is the selected node (clicking a node pushes it, so back/forward steps through selections; pane click clears it with replace; modifier-click multi-select doesn't touch it); uses SidePane(page="dag"); optional test coverage overlay with toggle in DagFilterBar; persists coverage state per-project in sessionStorage; optional Durations overlay (median run time badge per node, ranked within its resource type: lib/durationOverlay.ts, unit-tested; state + GET /node-durations in lib/useDurationOverlay.ts; DurationLegend)
      RunHistory/        — Run History page (folder; index.tsx + RunList, DetailPaneShell/useResizablePane, DetailPanel (Nodes / Timeline / Log / Failed Rows), TrendRow, FailedTestRow, shared). Runs / Performance tabs via useUrlTab (?tab=performance, remembered per project). RunTimeline.tsx: Gantt of one run (Base; lib/runTimeline.ts buildTimeline()/gapSegments(), unit-tested), with Pro the critical path highlighted, starvation waits marked and a wall/ideal/utilisation strip. PerformanceTab.tsx (Pro): recommendations (Open model, "Ask Wicky to draft it" for make_incremental), regressions and slowest nodes (RichTables in PerformanceTables.tsx: sortable; filters right above the Slowest nodes table: search + Type (that table) and Command (FilterDropdown `single`; scopes the whole tab), ⌘-click names → Files, hover Open in Files / Show in DAG, Sparkline of recent runs, Dumbbell usual→now, expand a row → NodeRunHistory.tsx: RunBarsChart of every recorded run + stats + Ask Wicky; durations via formatDuration() (ms under 1s); lib/performanceView.ts, unit-tested); locked state with ProFeatureButton. usePerformance.ts: ['run-analysis', id, inv] / ['performance', id, command] queries, invalidated on statuses_changed
      lib/dagExport/     — DAG exports: scene.ts (buildScene(): React Flow nodes + heights → positioned boxes/edge paths), config.ts (filter → header rows, filenames), svg.ts (renderDagSvg(), palettes, renderGraphBody() shared with HTML), html.ts (renderDagHtml(): self-contained page — subset or whole project (`includes.wholeProject`: every node, opening with the on-screen filter and positions); lineage pruned to the included nodes; inlines dagre's browser bundle, htmlFilter.js (vanilla port of dagFilter.ts — parity-tested against applyFilter) and htmlRuntime.js (filter bar, dagre re-layout, pan/zoom, lineage) via ?raw; CSS in htmlStyles.ts), png.ts (canvas rasterise, pngScale() keeps within WebKit canvas limits), prefs.ts (localStorage `wickd:dag-export-prefs`), index.ts renderExport(); unit-tested. components/DagExport/ExportDagModal.tsx (+ ExportOptions, FolderPickerModal; the column lineage option is Pro-gated via the license query) — opened from the filter bar's Export button; the file is written by POST /exports/dag (api/exports.py) since the desktop webview has no download manager
      Metrics/           — Metrics page (/projects/:id/metrics, nav item only when the project has metrics; Explore / Monitors tabs via useUrlTab `?tab=`): monitors/ (Pro, plan 10: MonitorsTab — cards (MonitorGrid: dnd-kit drag to reorder, same setup as Home's pinned projects, optimistic then PUT …/order; MonitorCard + MonitorSparkline: band + flagged points), Check now, auto-check interval, CreateMonitorDialog (also from the explorer's "Monitor this metric"); MonitorDetail (?monitor=<id>: MonitorChart Recharts line over the normal-range band, flagged periods with Mark as expected, restatements, stored-history DataTable, settings); useMonitors.ts ['metric-monitors', id] (+ 'series' sub-key) invalidated by metric_monitor_*; useMonitorStatuses() feeds the DAG metric-node badge (ModelNode `monitor`) and Impact (toolbar count + row badge); monitorView.ts tested; API in lib/monitorsApi.ts; health/MonitorsCard.tsx on the Health overview), MetricsSidebar (metrics by semantic model + saved queries; ⌘-click → YAML), QueryBar + FilterEditor (group by = intersection across metrics, grain, dates, order, limit, builder/advanced `where`), ResultsPane (Chart / Table / SQL tabs; Open in Workspace via lib/openInWorkspace.ts + Workspace/sessionKeys.ts), MetricChart (Recharts small multiples, colours from --series-N in styles.css), MetricsUnavailable (enable / compat dialog), ExploreButton + MetricPreview (SidePane, Docs). Query in the URL (lib/metricQuery.ts); useMetricExplorer.ts: ['semantic-catalog', id], ['semantic-explain', id, body], ['metric-result', id, body] (stored result, replaced by Run). lib/ unit-tested
      Docs.tsx           — Native docs browser (folder tree); MacroDetail includes "Try It" section with arg inputs, editable Jinja call textarea, and inline compile button; macros from installed packages are called with their namespace (lib/macroCall.ts macroCallName(), uses the docs data's adapter_type to leave dbt/adapter macros global). The last view (?node= + ?browse=/?view=) is remembered per project for the session and restored with replace when arriving without ?node= (lib/docsLastView.ts, unit-tested; falls back to the project overview if the node is gone)
      FileExplorer/      — File browser + editor; uses SidePane(page="files") with navigation to DAG. ?path=<file> is the open file (opening a file pushes it, so back/forward covers files); inbound ?model=<uid> deep-links (or the last-open file) are resolved to ?path= with replace on arrival. The tree is VS Code-style: FileTree.tsx (multi-select, keyboard, context menu, inline new/rename via InlineNameInput) over useFileTree.ts (path-based tree state, remembered expansion, reload on files_changed/git_status_changed/window focus), useFileOps.ts (move/copy/paste/duplicate/delete/upload/reveal + error toast + cut/copy clipboard), useTreeDnd.ts (drag rows to move, Alt to copy, OS drops → upload via osDrop.ts); pure helpers in treeOps.ts, unit-tested. Moving/renaming the open file keeps it open at the new path
      Git/               — Source Control page (VSCode-style SCM): ChangesList, DiffView (Monaco DiffEditor), CommitBox, BranchPicker, HistoryPanel. The changes panel is VS Code-style: BranchControls (branch chip + push/pull) in the title row, CommitBox (auto-growing message + slim Commit button) on top, then collapsible sections (PaneSection.tsx: PaneSectionHeader + usePersistedOpen in localStorage): Changes (open by default, `wickd:git-changes-open`; fills the free space so later sections sit at the bottom, split evenly with Commit History when both are open) → ImpactSection (impact of uncommitted changes, open, `wickd:git-impact-open`) → HistorySection "Commit History" (collapsed, `wickd:git-history-open`; when open it fills the rest of the panel)
      Workspace/         — SQL Workspace page: file tree + Monaco editor + Compiled SQL tab + resizable results pane; SQL/dbt autocomplete; cmd+click refs navigate to File Explorer
      Environment.tsx    — Env vars + profiles
      InitScripts.tsx    — Init pipeline management: steps drawn as a staggered flow (components/InitPipeline/: StepTile — blue/green/red by run status, StepConnector — animated SVG S-curve between tiles, AddStepTile — dashed "+" placeholder (create / link script), ScriptEditorModal — Monaco shell editor + Test (POST /init/test-script, api/init_script_test.py: runs unsaved content with the project env, persists nothing; ScriptTestOutput) + CapturedVarsSection (the only place captured vars are edited: explanation, per-var last-test status, suggestions from capturedVars.ts detectExports(), unit-tested; the tile shows them read-only); flow.ts lane offsets + connectorState(), unit-tested)
      Health.tsx         — Health page: Overview (default, ?tab=overview) + Connection + Schema Drift + Semantic Layer (?tab=semantic-layer, only for projects with a semantic layer: components/semantic/SemanticLayerPanel.tsx — Run check / Check against warehouse, SemanticIssues grouped by object with Open YAML, Enable MetricFlow, "Install the mf CLI…"; MetricFlowCompatDialog.tsx + ChangePreview.tsx (pick a compatible dbt-core: options/labels/recommendation in compatDialog.ts, tested; pip dry-run diff; pin updates; installs through useGlobalSetupRun(start) then verify + Revert; Escape = Continue without MetricFlow); useSemantic.ts ['semantic-status', id, wantCli] / ['semantic-check-latest', id] / sidecar progress from `metricflow_env`; API in lib/semanticApi.ts) + Test Gaps (Pro, ?tab=test-gaps: health/TestGapsPanel.tsx — ranked untested join-key/grain columns with evidence, row checkboxes, Generate tests for selected → batch proposal; useTestGaps.ts ['test-gaps', id] / ['test-gaps', id, 'ignored'] + useIgnoreGaps(); Gaps / Ignored sub-tabs in `?gaps=`, both RichTables (GapsTable.tsx: search + Test dropdown, selection bar with Generate tests / Ignore, per-row Ignore / Generate, expand for evidence + joining models + the full Used by lists (GapUsedBy.tsx; `used_by` on each row from wickd_pro: downstream models + columns, row-using models, exposures, capped at 50); IgnoredTable.tsx: Unignore; cells in gapCells.tsx); Refresh = re-trace lineage then re-rank; testGapsView.ts, tested; the tab carries the gap count (ignored excluded) as a badge via testGapsBadge()) + Source Freshness tabs; check tabs carry a status badge from the health summary
      components/
        refactor/        — RefactorHost.tsx (mounted once in ProjectLayout; handles `wickd:start-refactor` from lib/refactorEvents.ts startRefactor(): name prompt (refactorDialog.ts, tested) → POST /refactor → ProposalReviewModal → outcome toast with dbt parse status + Undo, or Review/Discard if closed unapplied). Entry points: side pane "Rename model…", Docs Columns tab rows (hover wand), Files editor context menu "Extract CTE to model…" (FileExplorer/panes/extractCteAction.ts)
        Wicky/           — Wicky, the AI assistant (Pro): WickyPane (right panel in ProjectLayout on every project page; ⌘I toggles; open state/width in localStorage; follows SelectedNodeContext, project-level context when nothing is selected) → WickyContent (unlock → AiSetup model download → QuickActions (Explain failure when the node or its tests failed, Document, Add tests) + AiChat; Explain failure sends a chat request with mode explain_failure); AiChat has Ask / Query data / Refactor modes (Refactor: refactorApi.parseRequest → RefactorCard confirm/cancel → action entry with RefactorOutcome: dbt parse status, Undo, manual-review list; QuickActions "Refactor…" switches to it) — QueryEntry shows the SQL (editable), Run, status, results in a DataTable and Answer from results (auto with the bundled model); ActionEntry renders a quick action inline in chat history (live descriptions / tests from `ai_proposal_progress` via lib/partialDocs.ts / lib/partialTests.ts, then Review/Discard, then the outcome + what was written, permanently), ProposalReviewModal (file list with op badges New/Deleted/Renamed + "Needs manual review" via ProposalFileList.tsx / proposalFiles.ts (tested); always "Reject all" / "Accept all" (whole proposal → POST .../reject / .../accept), plus Reject file / Accept file for multi-file proposals; Monaco diff + ChangeList of the proposal's items: click to reveal/highlight via findItemLine() in proposalItems.ts, ✓/✗/undo per item; the file is applied once every item is decided; Accept all / Reject all), useAi.ts (useAiStatus via useGlobalEvents, useAiProposals: project-wide proposals + live progress; useWickyConversation: open chat shared by AiChat and QuickActions); API in lib/aiApi.ts
        NavRail.tsx      — Collapsible left nav sidebar; persists collapsed state in localStorage; resizable when expanded; never re-opens on navigation
        ProjectNav.tsx   — Nav items (DAG/Files/Docs/Workspace/Git/Environment/Init/Health); icon-only when NavRail collapsed
        health/          — HealthOverview.tsx (three status cards + Run all, plus TestGapsCard.tsx: Pro gap count + top 3 from the same ['test-gaps', id, 50] query, Refresh lineage; not part of Run all; state in testGapsView.ts testGapsCardState(), tested), useHealth.ts (useHealthSummary: ['health-summary', id] for the overview, tab badges and the nav rail's Health dot; useHealthRuns: keyed start mutations so a run started anywhere shows as running everywhere), healthStatus.ts (tabBadge/navAlert, unit-tested), StaleNotice, RunButton, Spinner
        HealthCheckPanel.tsx — "Connection" tab: runs dbt debug; renders structured per-check pass/fail table + version info
        DriftPanel.tsx   — Schema drift scan: header (issues, checked vs skipped by materialization, target), stale notice, live progress. drift/DriftResults.tsx (search, filters, Drifted/Not built/Errors groups + expandable In sync; rows collapsed past 5) and drift/ModelDriftRow.tsx (re-check via POST /drift/{id}/recheck; Build model → re-check on run_finished; Open YAML; "Document N warehouse-only columns" → review window via POST .../document/propose (lib/useDocumentProposal.ts, shared with DocumentModelButton)); drift/driftView.ts pure helpers, unit-tested
        FreshnessPanel.tsx — Triggers dbt source freshness; renders per-source collapsible groups with age, thresholds, and pass/warn/error badges; resizable columns; filter pills; sources and tables ordered by urgency and passing tables near their warn threshold flagged (lib/freshnessUrgency.ts, unit-tested)
        FilterDropdown.tsx — Multi-select checkbox dropdown shared by DagFilterBar and the bottom pane's Node DAG
        CoverageLegend.tsx — Legend panel for test coverage overlay showing 4 buckets (untested/1 test/2 tests/3+ tests); rendered as ReactFlow Panel in top-right when coverage toggle is on
        SidePane/
          index.tsx      — Right collapsible/draggable panel (horizontal drag); tabs: Properties + Profile; props: projectId, model, graph, page, navigation callbacks, onNavigateToFile
          PropertiesTab.tsx — Model metadata; Refs/Sources + Referenced By chips (cmd+clickable → onNavigateToFile; Referenced By collapsed by default, header shows the count); run controls (run/build/test grid); test failures; Downstream impact card (ImpactSummary.tsx: counts + flags, Show impact / Build impacted); action buttons (incl. DocumentModelButton.tsx — "Generate docs YAML", probes the warehouse, then opens ProposalReviewModal on a Base `document_stub` proposal via POST .../document/propose)
          ProfilePanel.tsx — Column profile stats (row count, null%, distinct, min/max, samples) via dbt show
        BottomPane/
          RunPanel.tsx     — Execution DAG (parses run_log to show real-time status); shows full-run notice when no model is selected
          ImpactPanel.tsx — Impact tab: Selection / Uncommitted / Branch modes (mode + base held in BottomPane). Selection = downstream impact of the selected node(s) (multi-selection if any, else SelectedNodeContext); git modes = changed nodes from GET /impact/changes. ImpactToolbar.tsx (mode switch, base picker, Columns (Pro) toggle in Selection mode, selector, counts, flags, unaffected count, Build impacted + Copy selector) + ImpactColumnBar.tsx (unlock / load lineage / per-seed column picker) + useColumnLevelImpact.ts + ImpactNotices.tsx (what was compared, project-wide/unmapped files) over ImpactTable.tsx (depth-0 group "Selected"/"Changed" with per-node change reasons) — sticky column headers (Node/Type/Materialization/Status/Tests/Column coverage/Flags) and sticky per-depth group headers
          NodeSqlPanel.tsx — Node SQL tab: the selected node's uncompiled .sql/.py read from its file (['file-content', id, path], invalidated on files_changed), read-only Monaco
          NodeDagPanel.tsx — Node DAG tab: `+node+` lineage of the selected node (from SelectedNodeContext), centered on it; Type/Materialization/Status filter dropdowns (sessionStorage `node-dag-filter-{id}`); Cmd+click a node to open in Files
          TerminalPanel.tsx — xterm.js terminals (multi-instance tabs); optimized resize with lastSizeRef to prevent spurious SIGWINCH
          LogPanel.tsx     — Project and API logs
        Header.tsx         — Navigation + ProjectSelectors (Profile/Target dropdowns)
        StatusBadge        — Shared UI
      lib/
        testCoverage.ts  — Test coverage utility module; buildCoverageMap(), getModelCoverageStats(), bucketFor(), badgeClassesFor(); types: ColumnCoverage, CoverageMap, ModelCoverageStats, NodeCoverageData, CoverageBucket; derives coverage data client-side from GraphDto
  components/
    DataTable.tsx   — Shared table component (sticky header, row numbers, keyboard nav, copy); use for raw/tabular data
    RichTable.tsx   — Designed table for Pro insight views (Run History performance, Test gaps): component cells, sortable columns, row selection by key (shift-click ranges), expandable rows, hover row actions, ↑↓/Space/Enter; pure logic in lib/richTable.ts (tested); RichTableControls.tsx (TableSearch, RowAction); filters use FilterDropdown
    charts/         — SVG charts: Sparkline (area + median + hover readout), Dumbbell (usual → now on a shared scale), MeterBar, RunBarsChart (one bar per run, status colours, y ticks, median, tooltip); geometry in lib/charts.ts (tested)
```

## Database Tables

All 24 in `backend/app/db/models.py`:
- `projects` — discovered dbt projects (includes `init_script_path: str` per-project init dir; `ignored: bool` to hide from list; `last_init_status: str` (idle/running/success/error), `last_init_started_at`, `last_init_finished_at`, `last_init_failed_step` — persisted init pipeline status shown on the homepage and Initialization page; `metricflow_mode: str` '' = global default, auto, off — semantic layer)
- `init_steps` — ordered init pipeline steps per project (includes `script_path` for linked external scripts; `last_status: str` (idle/running/success/error), `last_started_at`, `last_finished_at`, `last_log: str` (capped at 200 lines) — persisted per-step run status)
- `model_statuses` — per-model run status (idle/pending/running/success/error/warn/stale)
- `run_invocations` — historical run records; `custom_args` (JSON list, nullable) holds the user-entered args of a custom dbt command so rerun replays them exactly; `threads`, `elapsed_time` from run_results.json (NULL before timing capture)
- `invocation_model_results` — per-node results per invocation (last 20 per node kept): `execution_time`, `status`, `message`, plus timing from run_results.json — `started_at`/`completed_at` (execute window), `thread_id`, `rows_affected`, `bytes_processed`, `adapter_response_json` (capped ~2 KB); timing columns NULL for older runs
- `env_profiles` — named environment profiles per project
- `profile_env_vars` — key/value vars belonging to a profile
- `project_env_vars` — project-level env vars (not profile-scoped); includes `dbt_target` for active target; `REQUIREMENTS_PATH` for per-project requirements; `WORKSPACE_PATH` for SQL workspace dir (default `wickd/workspace`)
- `app_settings` — global app config (key/value); keys: `dbt_projects_path`, `global_requirements_path`, `dbt_core_version`, `log_level`, `theme`, `python_path`, `setup_completed`, `ai_model`, `ai_endpoint_url`, `ai_endpoint_model`, `metricflow_mode` (auto/off)
- `global_env_vars` — default env vars (key unique) for every project and for global setup's pip install; precedence (low → high) is process env → global env vars → active profile → project env vars (`app/envvars.py` `layer_env()`, used by `load_project_env()`)
- `global_profiles` — named env var sets shared across all projects
- `global_profile_vars` — key/value vars belonging to a global profile
- `drift_snapshots` — schema drift scan results per project; stores status (running/done/error), progress counters, results_json (array of per-model column diffs, incl. `not_built` and `yaml_path`) and `skipped_json` ({materialization: count} of models not checked)
- `freshness_snapshots` — source freshness scan results per project; stores status (running/done/error), target, started_at, finished_at, results_json (array of per-source freshness results), and error_message
- `column_lineage_snapshots` — backgrounded column-level lineage scan results per project; stores status (running/done/error), total_models/checked_models progress counters, results_json (map of downstream unique_id → column → list of upstream `{node, column}` refs), `row_dependencies_json` (unique_id → upstream `{node, column}` refs it filters/joins/groups on), error_message, `manifest_mtime` and `lineage_version` (1 = projection only, 2 = with row dependencies, 3 = each results_json ref also has a transform `kind`: identity/rename/cast/derived, used by lineage propagation; 4 = also `join_keys_json`: per model `{join_pairs: [{left, right, type}], grain: {columns, via} | null}`, used by test suggestions; the re-scan short-circuit needs both the manifest mtime and the version to match)
- `ai_conversations` / `ai_messages` — Wicky chats per project (wickd Pro AI); messages store `role` (user/assistant/action/query), `payload_json` (query SQL + results), `content`, the `unique_id` in context and, for `action` messages (quick actions run from the chat), `proposal_id`
- `ai_proposals` / `ai_proposal_files` — AI-generated (or refactor) file changes awaiting review (`kind` document/tests/propagate/refactor; `status` generating/ready/applied/rejected/dismissed/error/empty/undone — empty = nothing needed changing; `result_json` keeps the generated descriptions for chat history; dismissing keeps the row; per file `op` (modify/create/delete/rename), `new_path` (rename target), `original_text` (null = new file), `proposed_text`, `applied_text` (what accepting wrote; Undo restores only while the file still holds it), `status` pending/accepted/rejected/undone); accept re-checks the file is unchanged
- `semantic_check_snapshots` — Health → Semantic Layer runs per project: status (running/done/error), started_at/finished_at, results_json (`{errors, warnings, future_errors: [issue], warehouse: [{metric, ok, error}] | null}`), error_message, `manifest_hash` (sha1 of semantic_manifest.json at the start; the summary flags it stale once the content differs — every dbt command rewrites the file, so mtime isn't used)
- `metric_query_results` — Metrics page result cache (`app/semantic/query_cache.py`): one row per (`project_id`, `target`, `env_fingerprint`, `sql_hash`) — the fingerprint hashes the env vars wickd layers in (global → profile → project + DBT_TARGET, plus the profiles.yml dbt reads; never the values), the SQL hash changes with definitions; `profile_name`, `metrics_json`, `group_by_json`, `columns_json`, `rows_json` (≤ 5000), `truncated`, `ran_at`, `elapsed_ms`; last 100 per project
- `metric_monitors` — metrics watched for anomalies (Pro; plan 10), per project: `metric`, `grain` (day/week/month), `dimension` (nullable; slices = its top 10 values in `slices_json`, recomputed weekly via `slices_refreshed_at`), `sensitivity` (low/normal/high), `lookback` (periods), `enabled`, `target` (pinned dbt target, NULL = active), `last_result_json` / `last_checked_at` (latest detection summary), `position` (Monitors tab order, drag to reorder via PUT …/order); at most 25 per project
- `metric_monitor_points` — a monitor's history: (`monitor_id`, `target`, `slice` ('' unsliced), `period` YYYY-MM-DD) unique; `value`, `previous_value` (set only for a restatement: the replaced value had been stored after its period ended), `suppressed` ("mark as expected"), `observed_at`; trimmed to the lookback
- `metric_monitor_runs` — one monitor check: `target`, `status` running/done/error, `trigger` build/manual/interval, `monitors_json`, `results_json` (per monitor summary + flagged points), `error_message`, timestamps
- `test_gap_ignores` — Test gaps rows the user ignored (Health → Test Gaps → Ignored), per project: `key` (row key `<unique_id>::<column>` or `<unique_id>::(a, b)`, unique per project), `unique_id`, `name`, `label` (kept to list the row once the gap is gone), `created_at`; hidden from GET /test-gaps and its count until unignored (`app/test_targets/ignores.py`)
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
| `run_started` | project | dbt command started |
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
| `column_lineage_started` | project | backgrounded column lineage scan started; payload includes `snapshot_id`, `total` |
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
| `metricflow_env` | global | MetricFlow sidecar setup; payload `state` (installing/ready/error), `phase`, `message` |
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
- Multi-tab interface, in order: "Node DAG", "Node SQL", "Execution DAG" (RunPanel), "Impact", "Terminal", "Project Logs", "API Logs"; Execution DAG is still the default tab, since runs open the pane to it
- **Node DAG** tab (`NodeDagPanel.tsx`) shows the `+node+` lineage of the selected node, centered on it. The selection is lifted into `ProjectLayout` via `lib/selectedNodeContext.tsx`: pages call `useReportSelectedNode(uid)` (Models.tsx, FileExplorer and the Git page — the selected changed file's node via `lib/nodeForPath.ts` `nodeForRepoPath()`, which strips the repo-relative project subpath) and it clears on unmount; `lib/nodeLineage.ts` `buildNodeLineageGraph()` builds the subgraph (tests excluded unless the selected node is a test). Mounted only while visible so centering uses the real pane size
- Terminal tab allows multiple instances with VSCode-style tabs on the right side
- `RunPanel` always mounted to continuously receive `run_log` SSE events
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
task release         # runs package:production signed with the Developer ID in .env.signing (gitignored; see .env.signing.example), notarizes, then creates the GitHub release; also uploads wickd_aarch64.dmg (stable name the lamphere-labs site's Download buttons link to)
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
