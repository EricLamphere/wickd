# Explore metrics

The **Metrics** page answers "does my metric return what I think?" while you write it. Pick metrics, group-bys, a time grain, filters and a date range; wickd shows the SQL MetricFlow generates as you go, runs it on your warehouse when you ask, and charts the result.

The page appears in the left nav for projects that define metrics. It needs MetricFlow (see [Use the semantic layer](semantic-layer.md)); if MetricFlow is off or your dbt-core can't run it, the page offers the same "Enable MetricFlow" / "Choose a dbt-core version…" options as Health → Semantic Layer.

## Browse your metrics

The **Explore** tab opens on **All metrics**: a card per metric, grouped by semantic model, with its type, a sparkline of its last result for the chosen period, how many places use it, and a warning count when the last semantic check found issues (Pro: a monitor badge when a monitor flagged it). Nothing runs when the page opens; the sparklines are stored results. **Run all** runs every metric's chart for the period on your warehouse in one batch. Search matches names, labels, descriptions, types and semantic models.

## A metric's page

Click a card (or a metric on the left, or **Metric page** in Docs and the side pane, or "Metric: …" in ⌘K, or a single-metric dashboard widget's ⋯ → **Open metric page**) to open its page:

- **Over time**: the metric over a period you pick, compared with the previous period or the same period last year (dashed gray), from the last stored result; **Run** refreshes it. The period is remembered per project and also drives the index's sparklines.
- **Definition**: label, how it's calculated (`sum(amount)`, `ratio: revenue / orders`, …), filter, input metrics.
- **Slice it by**: its dimensions, grouped by entity, and its time dimensions.
- **Where it comes from**: input metrics (each opens its own page), semantic models, the dbt models they're built on and those models' parents. Click to show one in the DAG; ⌘-click to open its file.
- **Where it's used**: dashboards, saved queries, exposures and metrics built on it.
- **Health**: issues from the last Health → Semantic Layer check for the metric or its semantic models, and (Pro) its monitors' status.
- Actions: **Explore** (opens the query view below with the metric over the period), **Add to dashboard**, **Monitor** (Pro), **Save as saved query**, **Ask Wicky** (Pro) and **YAML**.

Back and forward step between the index, pages and queries.

## Build a query

The query view (**Explore** on the index or on a metric's page, a dashboard widget's **Open in explorer**, Docs' **Explore**, ⌘K) is one widget — any of the dashboard widget types — with its settings on the right, exactly as on a dashboard:

1. **Pick metrics** on the left (in the query view a click adds or removes one; elsewhere it opens the metric's page), or **Add a metric…** in Configure. ⌘-click opens a metric's YAML in Files.
2. **Type**: time series, bar chart, Top N, table or metric summary.
3. **Break it down** with the type's settings: a time series' **Split by** (one line per value, top N), a bar chart's **Bars by** and **Stack by**, a table's **Rows by** dimensions and **Rows by period**, Top N's **Rank**. Only dimensions every picked metric has are offered.
4. **Filters**: **+ Filter** opens a builder (dimension, operator, value), or write a raw MetricFlow `where`.
5. **Period** in the top bar: the same pickers as dashboards — a preset or calendar range, compared with the previous period, the same period last year, a custom range or nothing.

Its chart, previous period included, shows as you change it. Whenever there's no stored result for the settings, it runs on your warehouse with the active target and profile (`dbt show`); **Refresh** (⌘↵) runs it again anyway. Under it, **Table** has the rows and **SQL** the query MetricFlow generated (per query when it runs several: current and previous period, total and trend…); **Copy** the SQL or **Open in Workspace** to save it as a new file under your workspace's `metrics/` folder.

The widget lives in the URL, so back/forward steps through your queries and you can share or bookmark a link. The metric chips above the title open each metric's page; **All metrics** goes back to the index.

### Results are remembered

Every result is stored, keyed by the exact SQL, your dbt target, the environment variables wickd sets (global, profile and project vars) and your `profiles.yml`. So when you come back to a query, its last result shows right away without hitting the warehouse. Switching to a profile that points the same target at another warehouse is a different environment, so it never shows the other environment's numbers. Only a hash of the variables is stored, never their values. Editing a metric's YAML changes its SQL, so a stored result no longer matches; use **Refresh** after a parse to see the new numbers.

## Saved queries

Saved queries are listed under the metrics. Click one (or its pencil) to open its definition in the query view.

**Save as saved query…** writes the current query to your YAML as a `saved_queries:` entry. It goes in your existing saved-queries file, or else the file that defines the first metric. wickd only adds lines in the file's own indentation style and checks the result parses to exactly the old file plus the new entry before writing. A date range is saved as `metric_time` filters, since saved queries have no time constraint. The new saved query shows up in the list after dbt re-parses (wickd does that automatically).

## Add it to a dashboard

**Add to dashboard…** pins the current query to a dashboard as a tile. See [Build metric dashboards](metric-dashboards.md).

## Other ways in

- **Side pane** (DAG or Files) and **Docs**: metric, semantic model and saved query nodes have an **Explore** button, and metrics a **Metric page** button. In Docs, a metric also shows its last stored result as a sparkline.
- **Command palette** (⌘K): "Metric: …" (its page), "Explore metric: …", "Run saved query: …" and "Go to Metrics".
- **Monitor this metric** (Pro): with one metric picked, opens **Monitors** with the metric, grain and a categorical group-by filled in. See [Monitor metrics for anomalies](metric-monitors.md).
