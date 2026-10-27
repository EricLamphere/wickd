from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import SessionLocal, ensure_db_initialized


async def _column_exists(session: AsyncSession, table: str, column: str) -> bool:
    result = await session.execute(text(f"PRAGMA table_info({table})"))
    return any(row[1] == column for row in result.fetchall())


async def _table_exists(session: AsyncSession, table: str) -> bool:
    result = await session.execute(
        text("SELECT name FROM sqlite_master WHERE type='table' AND name=:t"),
        {"t": table},
    )
    return result.scalar_one_or_none() is not None


async def run_migrations() -> None:
    await ensure_db_initialized()
    async with SessionLocal() as session:
        if not await _column_exists(session, "projects", "init_script_path"):
            await session.execute(
                text("ALTER TABLE projects ADD COLUMN init_script_path TEXT NOT NULL DEFAULT 'init'")
            )
            await session.commit()
        if not await _table_exists(session, "app_settings"):
            await session.execute(
                text("CREATE TABLE app_settings (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL DEFAULT '')")
            )
            await session.commit()
        if not await _column_exists(session, "projects", "ignored"):
            await session.execute(
                text("ALTER TABLE projects ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0")
            )
            await session.commit()
        if not await _table_exists(session, "global_profiles"):
            await session.execute(text(
                "CREATE TABLE global_profiles ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "name TEXT NOT NULL UNIQUE, "
                "created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
            ))
            await session.commit()
        if not await _table_exists(session, "global_profile_vars"):
            await session.execute(text(
                "CREATE TABLE global_profile_vars ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "profile_id INTEGER NOT NULL REFERENCES global_profiles(id) ON DELETE CASCADE, "
                "key TEXT NOT NULL, "
                "value TEXT NOT NULL DEFAULT '', "
                "UNIQUE(profile_id, key))"
            ))
            await session.commit()


        if not await _table_exists(session, "drift_snapshots"):
            await session.execute(text(
                "CREATE TABLE drift_snapshots ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, "
                "started_at DATETIME DEFAULT CURRENT_TIMESTAMP, "
                "finished_at DATETIME, "
                "status TEXT NOT NULL DEFAULT 'running', "
                "target TEXT, "
                "total_models INTEGER NOT NULL DEFAULT 0, "
                "checked_models INTEGER NOT NULL DEFAULT 0, "
                "results_json TEXT NOT NULL DEFAULT '[]', "
                "error_message TEXT)"
            ))
            await session.commit()

        # Reset any snapshots that were left in 'running' state from a previous server process
        await session.execute(
            text(
                "UPDATE drift_snapshots SET status = 'error', error_message = 'interrupted by server restart'"
                " WHERE status = 'running'"
            )
        )
        await session.commit()

        if not await _table_exists(session, "freshness_snapshots"):
            await session.execute(text(
                "CREATE TABLE freshness_snapshots ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, "
                "started_at DATETIME DEFAULT CURRENT_TIMESTAMP, "
                "finished_at DATETIME, "
                "status TEXT NOT NULL DEFAULT 'running', "
                "target TEXT, "
                "results_json TEXT NOT NULL DEFAULT '[]', "
                "error_message TEXT)"
            ))
            await session.commit()

        # Reset any freshness snapshots left running from a crashed server process
        await session.execute(
            text(
                "UPDATE freshness_snapshots SET status = 'error', error_message = 'interrupted by server restart'"
                " WHERE status = 'running'"
            )
        )
        await session.commit()

        if not await _column_exists(session, "projects", "pinned"):
            await session.execute(
                text("ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
            )
            await session.commit()

        if not await _column_exists(session, "projects", "last_opened_at"):
            await session.execute(
                text("ALTER TABLE projects ADD COLUMN last_opened_at DATETIME")
            )
            await session.commit()

        # Migrate old default 'init' to '' (empty = use runtime default 'wickd/init')
        await session.execute(
            text("UPDATE projects SET init_script_path = '' WHERE init_script_path = 'init'")
        )
        await session.commit()

        if not await _column_exists(session, "init_steps", "captured_vars"):
            await session.execute(
                text("ALTER TABLE init_steps ADD COLUMN captured_vars TEXT NOT NULL DEFAULT ''")
            )
            await session.commit()

        if not await _table_exists(session, "run_invocations"):
            await session.execute(text(
                "CREATE TABLE run_invocations ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, "
                "command TEXT NOT NULL, "
                "selector TEXT, "
                "status TEXT NOT NULL DEFAULT 'pending', "
                "log_path TEXT, "
                "started_at DATETIME, "
                "finished_at DATETIME)"
            ))
            await session.commit()

        if not await _column_exists(session, "model_statuses", "execution_time"):
            await session.execute(
                text("ALTER TABLE model_statuses ADD COLUMN execution_time REAL")
            )
            await session.commit()

        if not await _column_exists(session, "model_statuses", "invocation_id"):
            await session.execute(
                text(
                    "ALTER TABLE model_statuses ADD COLUMN invocation_id INTEGER"
                    " REFERENCES run_invocations(id) ON DELETE SET NULL"
                )
            )
            await session.commit()

        # Reset any run invocations left in running/pending state from a crashed server process
        await session.execute(
            text(
                "UPDATE run_invocations SET status = 'error'"
                " WHERE status IN ('running', 'pending')"
            )
        )
        await session.commit()

        # Per-invocation per-node result history (replaces overwriting model_statuses)
        if not await _table_exists(session, "invocation_model_results"):
            await session.execute(text(
                "CREATE TABLE invocation_model_results ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "invocation_id INTEGER NOT NULL REFERENCES run_invocations(id) ON DELETE CASCADE, "
                "project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, "
                "unique_id TEXT NOT NULL, "
                "name TEXT NOT NULL, "
                "kind TEXT NOT NULL, "
                "status TEXT NOT NULL, "
                "execution_time REAL, "
                "message TEXT)"
            ))
            await session.commit()
            await session.execute(text(
                "CREATE INDEX idx_imr_invocation ON invocation_model_results(invocation_id)"
            ))
            await session.execute(text(
                "CREATE INDEX idx_imr_project_uid ON invocation_model_results(project_id, unique_id)"
            ))
            await session.commit()

        if not await _column_exists(session, "run_invocations", "cli_command"):
            await session.execute(
                text("ALTER TABLE run_invocations ADD COLUMN cli_command TEXT")
            )
            await session.commit()

        if not await _column_exists(session, "run_invocations", "profile"):
            await session.execute(
                text("ALTER TABLE run_invocations ADD COLUMN profile TEXT")
            )
            await session.commit()

        if not await _column_exists(session, "run_invocations", "target"):
            await session.execute(
                text("ALTER TABLE run_invocations ADD COLUMN target TEXT")
            )
            await session.commit()

        if not await _column_exists(session, "projects", "pin_order"):
            await session.execute(
                text("ALTER TABLE projects ADD COLUMN pin_order INTEGER")
            )
            await session.commit()

        if not await _column_exists(session, "projects", "last_init_status"):
            await session.execute(
                text("ALTER TABLE projects ADD COLUMN last_init_status TEXT NOT NULL DEFAULT 'idle'")
            )
            await session.commit()

        if not await _column_exists(session, "projects", "last_init_started_at"):
            await session.execute(
                text("ALTER TABLE projects ADD COLUMN last_init_started_at DATETIME")
            )
            await session.commit()

        if not await _column_exists(session, "projects", "last_init_finished_at"):
            await session.execute(
                text("ALTER TABLE projects ADD COLUMN last_init_finished_at DATETIME")
            )
            await session.commit()

        if not await _column_exists(session, "projects", "last_init_failed_step"):
            await session.execute(
                text("ALTER TABLE projects ADD COLUMN last_init_failed_step TEXT")
            )
            await session.commit()

        if not await _column_exists(session, "init_steps", "last_status"):
            await session.execute(
                text("ALTER TABLE init_steps ADD COLUMN last_status TEXT NOT NULL DEFAULT 'idle'")
            )
            await session.commit()

        if not await _column_exists(session, "init_steps", "last_started_at"):
            await session.execute(
                text("ALTER TABLE init_steps ADD COLUMN last_started_at DATETIME")
            )
            await session.commit()

        if not await _column_exists(session, "init_steps", "last_finished_at"):
            await session.execute(
                text("ALTER TABLE init_steps ADD COLUMN last_finished_at DATETIME")
            )
            await session.commit()

        if not await _column_exists(session, "init_steps", "last_log"):
            await session.execute(
                text("ALTER TABLE init_steps ADD COLUMN last_log TEXT NOT NULL DEFAULT ''")
            )
            await session.commit()

        # Reset any init runs left in 'running' state from a previous server process
        await session.execute(
            text(
                "UPDATE projects SET last_init_status = 'error',"
                " last_init_failed_step = COALESCE(last_init_failed_step, 'interrupted by server restart')"
                " WHERE last_init_status = 'running'"
            )
        )
        await session.commit()

        await session.execute(
            text("UPDATE init_steps SET last_status = 'error' WHERE last_status = 'running'")
        )
        await session.commit()

        if not await _table_exists(session, "column_lineage_snapshots"):
            await session.execute(text(
                "CREATE TABLE column_lineage_snapshots ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, "
                "started_at DATETIME DEFAULT CURRENT_TIMESTAMP, "
                "finished_at DATETIME, "
                "status TEXT NOT NULL DEFAULT 'running', "
                "total_models INTEGER NOT NULL DEFAULT 0, "
                "checked_models INTEGER NOT NULL DEFAULT 0, "
                "results_json TEXT NOT NULL DEFAULT '{}', "
                "error_message TEXT, "
                "manifest_mtime REAL NOT NULL DEFAULT 0)"
            ))
            await session.commit()

        # Reset any column lineage scans left running from a crashed server process
        await session.execute(
            text(
                "UPDATE column_lineage_snapshots SET status = 'error',"
                " error_message = 'interrupted by server restart'"
                " WHERE status = 'running'"
            )
        )
        await session.commit()

        # One-time fixup: a bug in _sync_steps_from_disk (fixed in code) could
        # assign a newly-appearing base step (e.g. "base: pip install", which
        # only appears once REQUIREMENTS_PATH is set) the same `order` value
        # as an unrelated pre-existing step, since the old counter advanced
        # once per BASE_STEPS entry *visited* rather than being derived from
        # order values actually already in use. Duplicate orders made
        # ORDER BY init_steps.order non-deterministic across identical
        # queries, which surfaced as steps silently reordering themselves
        # and drag-and-drop reordering appearing broken. Renumber, per
        # project, using each row's existing (order, id) as the stable sort
        # key — this only breaks ties; it never changes the relative order
        # of two rows that already had distinct order values, so a real
        # user-driven reorder from before this fixup is preserved.
        if await _table_exists(session, "init_steps"):
            result = await session.execute(
                text('SELECT id, project_id, "order" FROM init_steps ORDER BY project_id, "order", id')
            )
            rows = result.fetchall()
            by_project: dict[int, list[tuple[int, int]]] = {}
            for row_id, project_id, order in rows:
                by_project.setdefault(project_id, []).append((row_id, order))
            for project_id, project_rows in by_project.items():
                has_collision = len({order for _, order in project_rows}) != len(project_rows)
                if not has_collision:
                    continue
                for new_order, (row_id, _old_order) in enumerate(project_rows):
                    await session.execute(
                        text('UPDATE init_steps SET "order" = :new_order WHERE id = :row_id'),
                        {"new_order": new_order, "row_id": row_id},
                    )
            await session.commit()

        if not await _table_exists(session, "license_state"):
            await session.execute(text(
                "CREATE TABLE license_state ("
                "id INTEGER PRIMARY KEY CHECK (id = 1), "
                "license_key TEXT, "
                "activation_id TEXT, "
                "device_id TEXT NOT NULL, "
                "entitled BOOLEAN NOT NULL DEFAULT 0, "
                "status TEXT NOT NULL DEFAULT 'unset', "
                "checked_at DATETIME)"
            ))
            await session.commit()

        if not await _column_exists(session, "license_state", "customer_id"):
            await session.execute(
                text("ALTER TABLE license_state ADD COLUMN customer_id TEXT")
            )
            await session.commit()

        if not await _column_exists(session, "license_state", "license_key_id"):
            await session.execute(
                text("ALTER TABLE license_state ADD COLUMN license_key_id TEXT")
            )
            await session.commit()

        if not await _column_exists(session, "license_state", "limit_activations"):
            await session.execute(
                text("ALTER TABLE license_state ADD COLUMN limit_activations INTEGER")
            )
            await session.commit()

        if not await _column_exists(session, "run_invocations", "custom_args"):
            await session.execute(
                text("ALTER TABLE run_invocations ADD COLUMN custom_args TEXT")
            )
            await session.commit()

        if not await _column_exists(session, "column_lineage_snapshots", "row_dependencies_json"):
            await session.execute(
                text("ALTER TABLE column_lineage_snapshots ADD COLUMN row_dependencies_json TEXT NOT NULL DEFAULT '{}'")
            )
            await session.commit()

        if not await _column_exists(session, "column_lineage_snapshots", "lineage_version"):
            await session.execute(
                text("ALTER TABLE column_lineage_snapshots ADD COLUMN lineage_version INTEGER NOT NULL DEFAULT 1")
            )
            await session.commit()

        if not await _table_exists(session, "ai_conversations"):
            await session.execute(text(
                "CREATE TABLE ai_conversations ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, "
                "title VARCHAR(255) NOT NULL DEFAULT '', "
                "created_at DATETIME DEFAULT CURRENT_TIMESTAMP, "
                "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
            ))
            await session.commit()

        if not await _table_exists(session, "ai_messages"):
            await session.execute(text(
                "CREATE TABLE ai_messages ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE, "
                "role VARCHAR(16) NOT NULL, "
                "content TEXT NOT NULL DEFAULT '', "
                "unique_id VARCHAR(512), "
                "created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
            ))
            await session.commit()

        if not await _table_exists(session, "ai_proposals"):
            await session.execute(text(
                "CREATE TABLE ai_proposals ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, "
                "kind VARCHAR(32) NOT NULL, "
                "unique_id VARCHAR(512), "
                "title VARCHAR(255) NOT NULL DEFAULT '', "
                "status VARCHAR(16) NOT NULL DEFAULT 'generating', "
                "error_message TEXT, "
                "created_at DATETIME DEFAULT CURRENT_TIMESTAMP, "
                "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
            ))
            await session.commit()

        if not await _table_exists(session, "ai_proposal_files"):
            await session.execute(text(
                "CREATE TABLE ai_proposal_files ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "proposal_id INTEGER NOT NULL REFERENCES ai_proposals(id) ON DELETE CASCADE, "
                "path VARCHAR(1024) NOT NULL, "
                "original_text TEXT, "
                "proposed_text TEXT NOT NULL, "
                "status VARCHAR(16) NOT NULL DEFAULT 'pending')"
            ))
            await session.commit()

        if not await _column_exists(session, "ai_messages", "proposal_id"):
            await session.execute(text(
                "ALTER TABLE ai_messages ADD COLUMN proposal_id INTEGER "
                "REFERENCES ai_proposals(id) ON DELETE SET NULL"
            ))
            await session.commit()

        if not await _column_exists(session, "ai_proposals", "result_json"):
            await session.execute(
                text("ALTER TABLE ai_proposals ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}'")
            )
            await session.commit()

        if not await _column_exists(session, "ai_messages", "payload_json"):
            await session.execute(text("ALTER TABLE ai_messages ADD COLUMN payload_json TEXT"))
            await session.commit()

        # Queries run in-process, so one still waiting/running at startup was interrupted
        await session.execute(
            text(
                "UPDATE ai_messages SET payload_json = json_set(payload_json, '$.status', 'error',"
                " '$.error', 'interrupted by server restart')"
                " WHERE role = 'query' AND json_extract(payload_json, '$.status') IN ('waiting', 'running')"
            )
        )
        await session.commit()

        # Generation runs in-process, so a proposal still generating at startup was interrupted
        await session.execute(
            text(
                "UPDATE ai_proposals SET status = 'error',"
                " error_message = 'interrupted by server restart'"
                " WHERE status = 'generating'"
            )
        )
        await session.commit()

        if not await _table_exists(session, "global_env_vars"):
            await session.execute(text(
                "CREATE TABLE global_env_vars ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "key TEXT NOT NULL UNIQUE, "
                "value TEXT NOT NULL DEFAULT '')"
            ))
            await session.commit()

        if not await _column_exists(session, "drift_snapshots", "skipped_json"):
            await session.execute(
                text("ALTER TABLE drift_snapshots ADD COLUMN skipped_json TEXT NOT NULL DEFAULT '{}'")
            )
            await session.commit()

        # Run performance: timing captured from run_results.json (older rows stay NULL)
        if not await _column_exists(session, "run_invocations", "threads"):
            await session.execute(text("ALTER TABLE run_invocations ADD COLUMN threads INTEGER"))
            await session.commit()
        if not await _column_exists(session, "run_invocations", "elapsed_time"):
            await session.execute(text("ALTER TABLE run_invocations ADD COLUMN elapsed_time REAL"))
            await session.commit()
        if not await _column_exists(session, "invocation_model_results", "started_at"):
            await session.execute(text("ALTER TABLE invocation_model_results ADD COLUMN started_at DATETIME"))
            await session.commit()
        if not await _column_exists(session, "invocation_model_results", "completed_at"):
            await session.execute(text("ALTER TABLE invocation_model_results ADD COLUMN completed_at DATETIME"))
            await session.commit()
        if not await _column_exists(session, "invocation_model_results", "thread_id"):
            await session.execute(text("ALTER TABLE invocation_model_results ADD COLUMN thread_id TEXT"))
            await session.commit()
        if not await _column_exists(session, "invocation_model_results", "rows_affected"):
            await session.execute(text("ALTER TABLE invocation_model_results ADD COLUMN rows_affected INTEGER"))
            await session.commit()
        if not await _column_exists(session, "invocation_model_results", "bytes_processed"):
            await session.execute(text("ALTER TABLE invocation_model_results ADD COLUMN bytes_processed INTEGER"))
            await session.commit()
        if not await _column_exists(session, "invocation_model_results", "adapter_response_json"):
            await session.execute(text("ALTER TABLE invocation_model_results ADD COLUMN adapter_response_json TEXT"))
            await session.commit()

        # Refactors: proposal files can create / delete / rename, and remember what was applied (Undo)
        if not await _column_exists(session, "ai_proposal_files", "op"):
            await session.execute(
                text("ALTER TABLE ai_proposal_files ADD COLUMN op TEXT NOT NULL DEFAULT 'modify'")
            )
            await session.commit()
        if not await _column_exists(session, "ai_proposal_files", "new_path"):
            await session.execute(text("ALTER TABLE ai_proposal_files ADD COLUMN new_path TEXT"))
            await session.commit()
        if not await _column_exists(session, "ai_proposal_files", "applied_text"):
            await session.execute(text("ALTER TABLE ai_proposal_files ADD COLUMN applied_text TEXT"))
            await session.commit()

        # Smarter test suggestions: join pairs + grain per model (lineage_version 4)
        if not await _column_exists(session, "column_lineage_snapshots", "join_keys_json"):
            await session.execute(
                text("ALTER TABLE column_lineage_snapshots ADD COLUMN join_keys_json TEXT NOT NULL DEFAULT '{}'")
            )
            await session.commit()

        # Test gaps the user chose not to test (Health → Test Gaps → Ignored)
        if not await _table_exists(session, "test_gap_ignores"):
            await session.execute(text(
                "CREATE TABLE test_gap_ignores ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, "
                "key TEXT NOT NULL, "
                "unique_id TEXT NOT NULL, "
                "name TEXT NOT NULL, "
                "label TEXT NOT NULL, "
                "created_at DATETIME DEFAULT CURRENT_TIMESTAMP, "
                "UNIQUE(project_id, key))"
            ))
            await session.commit()


async def init_db() -> None:
    await ensure_db_initialized()
    await run_migrations()
