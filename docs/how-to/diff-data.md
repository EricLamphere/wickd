# Diff data between dev and prod (Pro)

Before you merge, see what your changes do to the **data**, not just the SQL. Data diff builds the
changed models on your dev target and compares each one with its production relation, row by row:

- **Rows**: added (only in dev), removed (only in prod), changed and unchanged, matched on a key.
- **Columns**: how many rows changed per column, and the total change for numeric columns.
- **Schema**: columns only in dev, only in prod, or with a different type.
- **Sample rows**: up to 20 per category, with dev and prod values side by side and the changed cells highlighted.

## Setup

1. In **Environment → Project settings**, set `DIFF_BASE_TARGET` to the target you compare with,
   usually `prod`. Both targets must be in `profiles.yml` and use the same adapter. (Metric compare
   uses the same setting.)
2. Switch the header's **Target** to your dev target. Data diff refuses to run when the active
   target is the same as `DIFF_BASE_TARGET`.

Nothing is ever built on prod. wickd only reads it.

## Run a diff

1. Open the bottom pane's **Impact** tab, pick **Uncommitted** or **Branch** and turn on **Data diff**
   (Pro) in the toolbar, next to **Contracts**. The **Data diff** section appears above the impact
   table, laid out like the Contracts section: collapse it with its chevron and the header still
   shows the last result and the Diff buttons. Without `DIFF_BASE_TARGET` it links to Environment.
2. Click **Diff changed (N)** to diff just the changed models, or **Diff all impacted (N)** to also
   diff every built model downstream of them (to see how a change ripples through). With **Build in
   dev first** on (the default; remembered), wickd runs `dbt run --select <models>` on your active target first; the run shows in Run History.
   Turn it off to compare what's already built in dev.
3. The section's header sums up the result (`1 differs · 3 unchanged · 2 min ago`) and lists each
   diffed model (changed or downstream) with its result, what needs attention first. The **Data** column in the impact
   table shows the same per model: `+12 −3 ~140 rows`, `no changes`, `schema changed`, `not in prod`, …
   Click a result for the details. Any other built model in the table has a **Diff** button to diff just that one.

After **Build impacted…** finishes a build in Uncommitted / Branch, Data diff turns on and the
section (and the Git page) offers **Diff now**: the models are already built, so it skips the build.

### Elsewhere

- **Git page → Impact**: the uncommitted changes' latest result, with each model clickable, or a
  **Diff N changed models vs prod** button, so you can check the data before committing.
- **Side pane** (DAG and Files): any built model shows its latest result and **Diff vs prod** /
  **Diff again**. **Details** opens the result in the Impact tab.

A result goes **stale** when the model is rebuilt in dev after the diff, by a run, build, seed,
snapshot or **Clone from prod**. Its badge is then dashed and marked `· stale`, and the side pane
says which command rebuilt it. Diff again to compare the current data. A clone that kept an existing
dev relation (dbt reports it as `No-op`) doesn't count.

**Cancel** stops the diff and the dbt command it's waiting on.

## How rows are matched

The key comes from, in order:

1. the key you picked for that model (remembered in this browser),
2. a contract `primary_key` constraint,
3. a column with a `unique` test,
4. a `dbt_utils.unique_combination_of_columns` test,
5. the grain column lineage detected from the SQL (shown as "detected from SQL"; needs column lineage loaded).

Without a key, only row counts and the schema are compared. If the key isn't unique on either side,
the diff stops and shows the duplicated keys. Pick another key under **Diff again** in the details.

## How wickd reads both sides

wickd picks one of two strategies for each model and shows which one it used:

- **Compared in-warehouse**: your dev connection can read the prod relation (same Snowflake
  account, BigQuery cross-project, Databricks Unity Catalog, same Postgres database, Athena/Trino
  catalog, …). One query joins dev and prod on the key, and only the summary and sample rows come back.
- **Compared across connections**: dev and prod are different warehouses or files (separate
  Postgres databases, two duckdb files, locked-down accounts). Each side is read on its own target.
  Rows are grouped into buckets by a hash of the key. Each bucket's row count and checksum are
  compared, and only the rows of buckets that differ are fetched (up to 50,000 per side) and
  compared in wickd. Row counts are always exact. When more rows differ than can be fetched,
  added / removed / changed are scaled up from the fetched buckets and marked **estimated**.

How wickd decides:

1. It compares both targets' connection details from `dbt debug` (host, port, account, path, …;
   never passwords). If they point at different warehouses, it compares across connections.
2. If they point at the same warehouse, it tries `select * from <prod relation> where 1 = 0` on
   the dev connection. If that works, the comparison runs in-warehouse. If not, the error is shown
   in the details and it compares across connections.
3. In-warehouse diffs also count the prod relation's rows on both connections and fall back to
   across connections if the counts disagree, in case the name points at a different table from dev.

To force the second strategy, tick **Compare across connections** under **Diff again**.

## Options (Diff again)

- **Key columns**: comma-separated; remembered for the model.
- **Filter**: a SQL condition applied to both sides, e.g. `order_date >= '2026-10-01'`. It must be
  a single plain condition (no subqueries, comments or Jinja). Use it for incremental models: dev is
  often built from scratch and holds a different history than prod, and wickd warns about that.
- **Numeric tolerance**: numbers closer than this count as equal. Floating-point columns already
  ignore rounding noise (a relative difference below 1e-9).

## Notes and limits

- Diffs read whole tables (or the filtered part). On large warehouses that costs what a
  `count(*)` plus a join or a grouped hash scan costs. Use a filter to narrow it.
- When building in dev, the model's parents are read from dev. If they're older than prod's, their
  differences show up in the diff too.
- Time zones aren't normalised: the same instant stored in different zones counts as changed.
- Comparing across connections needs a row hash in the adapter's SQL: supported for duckdb,
  Postgres, Redshift, Snowflake, BigQuery, Databricks / Spark, Trino / Athena, ClickHouse and MySQL.
- For models with metrics on top, the details link to **Compare metrics** on the two targets
  ([Compare metrics](compare-metrics.md)).
