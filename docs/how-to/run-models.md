# How to Run, Build, and Test Models

This guide explains how to execute dbt commands against your models using wickd.

## Overview

wickd exposes three dbt commands:
- **run** — executes model SQL and materializes results
- **build** — runs models, tests, seeds, and snapshots together
- **test** — executes tests without building models

All three support the same selection modes and use the active dbt target.

## Running from the DAG (SidePane)

1. Navigate to **Models** in the project nav.
2. Click any node in the DAG to open the **SidePane** on the right.
3. The SidePane shows a 3×3 run grid with rows (run / build / test) and columns (upstream / only / downstream).
4. Click a button to start the command. The button highlights and the Run panel opens at the bottom.

**Selection modes:**
- **upstream** (`+model`) — runs the model and all its ancestors
- **only** (`model`) — runs just the selected model
- **downstream** (`model+`) — runs the model and all its descendants

**Unit tests:** the SidePane's **Unit tests** section lists the model's dbt unit tests with their last result; **Run all** runs `dbt test --select <model>,test_type:unit`, and ▶ on a row runs one. See [Write and debug unit tests](unit-tests.md).

## Running from the File Explorer

1. Navigate to **Files** in the project nav.
2. Open any `.sql` model file. The SidePane appears on the right with the same run grid.
3. Use the same buttons to trigger runs.

## Watching the run in real time

The **Run panel** at the bottom of the screen shows an **Execution DAG** — a live mini-graph of the models involved in the current run:
- **Blue** — model is currently executing
- **Green** — model succeeded
- **Red** — model errored
- **Yellow/orange** — model warned or partially failed

The panel updates line-by-line as dbt emits output. You don't need to wait for the full run to finish to see results.

Click any node in the Execution DAG to jump to that model in the main DAG and see its details.

Commands that don't run models — compile, docs generate, debug, source freshness, deps, run-operation and other custom commands — show a single node instead: the project's name with the operation under it, blue while running, then green on success, red on failure, or yellow if dbt printed warnings.

The bottom pane never opens by itself when something runs: it stays open or closed as you left it. Open the **Execution DAG** tab whenever you want to watch.

## Reading run output

The **Project Logs** tab (next to the Run tab in the bottom panel) shows full stdout/stderr from dbt. This is useful for debugging failing models.

## Switching dbt targets before a run

Use the **Target** dropdown in the top-right header to switch between targets defined in `profiles.yml` (e.g. `dev`, `prod`). The selected target is stored per-project and applied automatically to every dbt command.

## Running all models

To run all models in the project, click the top node in the DAG (or use the DAG selection bar) to run without a `--select` filter. Alternatively, use the terminal to run `dbt run` directly.

## Building only what changed, deferring, cloning and retrying

- **Defer to prod** (side pane run controls, below Options): adds `--defer --state <prod manifest>` to every run, build and test until you turn it off; the Header shows a "Deferring to …" chip meanwhile.
- **Build impacted…** (bottom pane → Impact, or the side pane's Downstream impact card): a dialog to build what the Impact view shows or what changed vs production (`state:modified+`), with the exact command and nodes before anything runs.
- **Clone from prod** (side pane, tables / incrementals / snapshots): `dbt clone` of that model.
- **Retry failed** (Execution DAG header, after a failed run): `dbt retry`.

See [Build only what changed](slim-builds.md) for the STATE_SOURCE setting and the details.

## Running any dbt command

For anything the buttons don't cover (`ls`, `parse`, `source freshness`, `run-operation`, `snapshot`, unusual flags), type the command yourself:

- **Command palette** — press ⌘K, choose **Run custom dbt command…**, type the command (the `dbt` prefix is optional) and press Enter. You can also type `dbt ls -s +orders` straight into the palette search and pick **Run: dbt …**. Recent commands are listed below the input; arrow keys recall them.
- **Project homepage** — the **dbt Command** row at the bottom of the Quick Run card. Press ↑/↓ in the input to recall recent commands.

The command runs in the project directory with the active env profile, and `--target` is added from the target dropdown unless you pass `--target`/`-t` yourself. Output streams to the Run panel, and the invocation is recorded on the Runs page, where **Rerun** replays the exact command. Commands that don't write `run_results.json` (e.g. `ls`, `parse`) are marked success/error from dbt's exit code and don't change model statuses.

`dbt init` (interactive; use **New Project**) and `dbt docs serve` (never exits; use the **Docs** page) are rejected. Commands run without a shell, so pipes and `&&` are passed to dbt as literal arguments.

## Scheduling runs

Runs → **Schedule** runs any dbt command on a schedule, for example `build -s tag:nightly` on weekdays at 7:00.

> Schedules run **only while wickd is open**. wickd isn't a cron daemon: if it is closed (or the Mac is asleep) at a scheduled time, that run doesn't happen.

1. Click **New schedule**, or start from a past run's **Schedule this…**, or type a command in the command palette's custom command mode and press **Schedule** (⌘↵).
2. Give it a name and the dbt command (anything the custom command box accepts).
3. Choose **When**: every 1, 3, 6, 12 or 24 hours, or **Custom schedule…** for a cron expression (`minute hour day-of-month month day-of-week`, local time, presets included). The next three run times are shown as you type. Schedules can run at most every 15 minutes.
4. Pick a **Target**: the active target when it runs (default) or a fixed one such as `prod`. A `--target` in the command wins, and the picker is disabled.
5. **Wait if busy** (default 30 min): if another dbt command is running when the schedule is due, wickd waits up to this long, then records the run as *skipped (busy)*. `0` skips right away. A schedule never has more than one run waiting.
6. **Catch up missed run** (off by default): when on, a run missed while wickd was closed starts once when wickd next opens. When off, it's recorded as *missed*.

Scheduled runs are ordinary runs: they wait for the project's run lock, stream into the Execution DAG, appear on the Runs tab (with a clock and the schedule's name) and update model statuses.

Each row shows the schedule, its next run and its last outcome (click it to open that run). Hover for **Run now**, **Edit**, **Duplicate** and **Delete**; the checkbox enables or disables it; drag to reorder. Click a row for its settings and history, including missed and skipped runs. **Pause all schedules** stops every schedule in the project; when you resume, they count from then, so the paused time isn't reported as missed.

When a scheduled run fails, is skipped or its command is no longer valid, a red dot appears on **Runs** in the nav and on the Schedule tab until you look, and a toast appears if wickd is in front.

## Viewing model status after a run

After a run completes, the main DAG tiles update to show the final status:
- **Green** — success
- **Red** — error
- **Yellow** — warn
- **Gray** — not run / stale

Click any tile to see the model's last run message in the SidePane.

## Test failures

When tests fail, the SidePane shows a **Test Failures** section listing each failing test with its name and failure message. The **test** run controls in the SidePane let you re-run tests in isolation.

## Reviewing past runs

Every invocation is recorded on the **Runs** page (clock icon in the left nav). From there you can browse past runs, inspect per-node execution times and trends, and view the raw dbt log. See [View run history](view-run-history.md) for details.

## Troubleshooting

**Run button does nothing** — Check the Project Logs tab for errors. The dbt binary may not be found, or there may be a configuration issue.

**Model stays blue** — The run is still executing. Long-running models may take time. Check Project Logs for progress.

**`--target` is wrong** — Verify the Target dropdown in the header matches your intended environment.
