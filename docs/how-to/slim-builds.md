# Build only what changed (slim builds)

Slim CI builds only what a change needs instead of the whole project. wickd runs the same
build on your machine, before you push:

- **Build impacted**: build what the Impact view shows, or `dbt build --select state:modified+ --state <prod manifest>`, configured and previewed first.
- **Defer to prod**: parents you haven't built in dev are read from production (`--defer`).
- **Clone from prod**: copy a production table into your dev schema (`dbt clone`).
- **Retry**: re-run only what failed or was skipped in the last run (`dbt retry`).
- **Smallest safe set (Pro)**: skip downstream models that read none of the columns you changed.

## 1. Tell wickd where production's manifest comes from

Environment → Project settings → **STATE_SOURCE**:

| Value | Meaning |
|-------|---------|
| _(empty)_ | `git:` with your repo's base branch (origin/HEAD, `main` or `master`) |
| `git:main` | wickd parses that ref in a separate git worktree twice: for your active target, to work out what changed (so differences between targets, like a source's default database, don't count), and for the target in **DIFF_BASE_TARGET**, which defer and clone read. It assumes prod is deployed from that ref. |
| `path:/srv/dbt/prod-artifacts` | A folder of real prod artifacts (`manifest.json`, optionally `run_results.json` and `sources.json`) that you sync from your orchestrator. This is more accurate. |

Set **DIFF_BASE_TARGET** to your prod target (for example `prod`) when using `git:`. Otherwise
the manifest is parsed for your active target, and defer reads your own dev relations.

Click **Test** next to the setting to check that it resolves: wickd shows the commit or folder,
the dbt version that wrote the manifest, and any caveats.

> A manifest parsed from git isn't what prod actually ran. Configs that depend on the target
> (schemas, vars) can show up as modified. Prefer `path:` when you have the artifacts.

## 2. Build impacted

Open the bottom pane's **Impact** tab and click **Build impacted…**. It opens a dialog and
doesn't run anything until you click **Run build**. The dialog has three sections.

**Configuration**, step by step:

1. **What to build**
   - *What the Impact view shows*: the changed (or selected) nodes and everything downstream,
     exactly as listed in the Impact tab. Instant; no production reference needed.
   - *What changed compared with production*: dbt compares your project with the `STATE_SOURCE`
     manifest (`state:…`). Also catches config, macro and package changes git can't map.
2. **Which changes count** (production only): anything modified (`state:modified`), new nodes
   only (`state:new`), SQL changes only (`.body`), config changes only (`.configs`) or contract
   changes only (`.contract`).
3. **Downstream** (production only): include everything downstream (`+`), and optionally only
   what actually changed (the smallest safe set, Pro; below).
4. **Parents you haven't built in dev**: read them from dev (default), defer to production
   (`--defer`), or always read production (`--defer --favor-state`).

wickd remembers step 1 for the session.

**Command**: the exact `dbt build …` the build runs (state folders and target included), with
a **Copy** button so you can run it yourself. Below it: what it compares with, any caveats,
**Load column lineage** when the smallest safe set needs it, and where dbt and git disagree:
nodes dbt rebuilds although none of their files changed (a config, macro, package or vars
change), or files that changed but match production (nothing to do). Sources are shown as
`source:<source>.<table>`.

**Nodes**: every node with its status (changed, build, skip, or affected for nodes `dbt build`
doesn't build, like metrics and exposures) and why, with counts in the header.

A production preview is kept: reopening the dialog shows it again (with its age and a
**Refresh** button) until your files, git state or manifest change.

Click **Run build**. The run streams into the Execution DAG and is recorded on the Runs page with
its state settings, so **Rerun** replays it against the state again.

### Smallest safe set (Pro)

wickd compiles each changed model in your working copy and on the state side, and finds which
output columns changed. It then follows column lineage downstream and keeps only the models
that read one of those columns. It always keeps a model when:

- it filters, joins or groups on a changed column (every row may change),
- something outside the SELECT list changed (a filter, join or CTE), which counts as every column,
- there's no column lineage for it,
- it consumes a contracted or versioned model.

This needs column lineage loaded after your latest parse (Impact → Columns, or Docs). If
lineage is missing or out of date, the preview falls back to the full state selection and says so.

## 3. Defer to prod

In the side pane's run controls, turn on **Defer to prod** (and optionally **favor state**).
The choice is remembered per project and applies to every run, build and test until you turn
it off. While it's on, the Header shows a **Deferring to `<target>`** chip; click it to stop
deferring.

## 4. Clone from prod

For a table, incremental model or snapshot, the side pane has **Clone from prod**. It runs
`dbt clone --select <model> --state <dir>`. Snowflake, BigQuery and Databricks make a
zero-copy clone; other adapters create a view. This is useful before you work on an incremental
model, so its first dev run is incremental instead of a full rebuild.

## 5. Retry

When the latest run fails, **Retry** appears on it on the Runs page and as **Retry failed** in the
Execution DAG header. `dbt retry` reads `target/run_results.json`, so it only works on the
project's last run. If a later dbt command replaced that file, wickd says so and suggests Rerun.
