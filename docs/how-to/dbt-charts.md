# View dbt Charts boards

[dbt Charts](https://docs.getdbt.com/guides/dbt-charts) (the open-source `dct` CLI from dbt Labs) keeps dashboards as YAML "boards" in a `charts/` folder next to `dbt_project.yml`. Each board's queries read your dbt models with `{{ ref('…') }}`. wickd finds these boards, shows them, checks them and builds them. It can also turn a wickd metric dashboard into a board.

## Before you start

- Put boards in `<project>/charts/`, e.g. `charts/sales.yml`. Subfolders work (`charts/ops/inventory.yml`). Files starting with `_` and `meta.yml` are partials or folder defaults, not boards.
- Build the models a board reads (`dbt run` / `dbt build`), so `target/manifest.json` and the tables exist.
- The **Charts** item appears in the project nav once the project has at least one board.

On first use wickd installs the pinned dbt Charts version (shown at the bottom of the board list) into its own environment. This takes a few seconds to a minute, and the board list shows the progress. Your dbt installation is untouched. DuckDB works out of the box. For Snowflake, BigQuery, Postgres, Redshift, Databricks and the other warehouses dbt Charts supports, wickd adds the matching extra the first time a project needs it.

## Browse and build boards

1. Open **Charts**. The left rail lists the boards, grouped by folder. A warning icon marks a board that doesn't parse, fails validation or failed its last build.
2. Click a board to select it. The selection is in the URL (`?board=`), so back/forward steps through boards, and wickd remembers the last board for the session. ⌘-click a board, or **Open YAML**, to edit its file in Files.
3. In **Static** mode, click **Build** (later **Rebuild**). wickd runs `dct render`, which runs every query on the board against the active target. While it runs, wickd holds the project's dbt lock, so builds and dbt commands never overlap. The result is a snapshot of the board. The header says when, on which target and how long it took.

Builds only happen when you ask for one, never on file changes, so the warehouse isn't queried behind your back.

## Live boards

Switch to **Live** to see the board as `dct serve` renders it: variables, filters and drill links work, and the board reloads when you save its YAML. wickd starts one server per project on a free `127.0.0.1` port. It restarts the server when you change the target or the project's environment, and stops it after 10 minutes nobody is looking. Your Static/Live choice is remembered per project.

On DuckDB, a live board can't read the database while a dbt command is writing to it. Reload the board once the run finishes.

## Check boards

**Validate** (top of the board list) runs `dct validate` on every board: unknown fields, missing queries and charts, bad references. No warehouse is needed. Validation runs when the page opens and again whenever a board file changes. Problems appear above the board with dct's hint and the line number (click the line to open the file), together with the warnings from the last build.

## Export a metric dashboard as a board

Open a dashboard under **Metrics → Dashboards**, click **Export**, pick **dbt Charts** (next to HTML and PNG), then **Review…**. wickd writes `charts/<dashboard>.yml` as a change to review, and nothing is written until you accept it:

- Each widget becomes a query with the SQL MetricFlow generates for it at the dashboard's period. Tables are written as `{{ ref('…') }}`, so the board follows your dbt target.
- Summary → KPIs (one per metric), time series → line or area, bar → bar, Top N → horizontal bar, table → table, text → a text row. Widths become the board's columns.
- Some things don't carry over: previous-period comparisons, a period picker, and dashboard filters as board variables (the filters are applied inside the queries). The review lists them under **Not exported**.

The exported board uses the dashboard's dates at the time of export. Export again to refresh it.
