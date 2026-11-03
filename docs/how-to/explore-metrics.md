# Explore metrics

The **Metrics** page answers "does my metric return what I think?" while you write it. Pick metrics, group-bys, a time grain, filters and a date range; wickd shows the SQL MetricFlow generates as you go, runs it on your warehouse when you ask, and charts the result.

The page appears in the left nav for projects that define metrics. It needs MetricFlow (see [Use the semantic layer](semantic-layer.md)); if MetricFlow is off or your dbt-core can't run it, the page offers the same "Enable MetricFlow" / "Choose a dbt-core version…" options as Health → Semantic Layer.

## Browse your metrics

The **Metrics** tab (first on the Metrics page) opens on **All metrics**: a card per metric, grouped by semantic model, with its type, a sparkline of its last result for the chosen period, how many places use it, and a warning count when the last semantic check found issues (Pro: a monitor badge when a monitor flagged it). Nothing runs when the page opens; the sparklines are stored results. **Run all** runs every metric's chart for the period on your warehouse in one batch. Search matches names, labels, descriptions, types and semantic models.

## A metric's page

Click a card (or a metric on the left, or **Metric page** in Docs and the side pane, or "Metric: …" in ⌘K, or a single-metric dashboard widget's ⋯ → **Open metric page**) to open its page. It reads like a doc page: the metric's name as the title, its type and description, then its facts:

- **How it's calculated** in words ("Sum of `amount`", "`revenue` divided by `orders`", "Running total of `revenue` over a 7 days window"), the **filter** it applies (MetricFlow's `{{ Dimension('…') }}` templates shown as plain dimension names), the metrics it's **built from** (each opens its page), its **semantic model** and its default grain.
- Actions: **Investigate** (opens the query view with the metric over the period; Debug and Compare are there), **YAML**, then the Pro ones: **Monitor** and **Ask Wicky**.
- **Numbers**, for a period you pick, compared with the previous period or the same period last year (gray): the **Total** (its own query, with the change), the metric **Over time**, and its **Top 10 by** a dimension you choose (current and previous bars). They fill in by themselves: stored results show right away, and whatever isn't stored yet runs on your warehouse in one batch when the page opens or you change the period or the dimension (once each; if a query fails, **Run** tries again). Each chart's ⋯ menu has **Add to dashboard** (the chart as a widget, following the dashboard's period), **Save as saved query** (reviewed before it's written, see below), **View SQL**, **Open in Workspace** (its SQL as a new file under your workspace's `metrics/` folder), **Download PNG** (the chart with a header naming the metric, the period and when the data was queried) and **Download CSV**. Downloads ask for a folder (remembered; `~/Downloads` by default) and never overwrite a file without asking. The period is remembered per project and also drives the index's sparklines.
- **Dimensions**: what you can slice it by, grouped by entity.
- **Where it comes from**: input metrics, semantic models, the dbt models they're built on and those models' parents. Click to show one in the DAG; ⌘-click to open its file.
- **Where it's used**: dashboards, saved queries, exposures and metrics built on it.
- **Health**: issues from the last Health → Semantic Layer check for the metric or its semantic models, and (Pro) its monitors' status.

Back and forward step between the index, pages and queries.

## Build a query

The query view (**Investigate** on a metric's page, a dashboard value's right-click **Open in Investigate, filtered**, a saved query, Docs' **Explore**, ⌘K) opens in a window over the metric's page, titled with the metric; close it (✕, Esc or a click outside) to get back to the page. It's one widget — any of the dashboard widget types — with its settings on the right, exactly as on a dashboard:

1. **Metrics**: it starts with the page's metric; **Add a metric…** in Configure to put others beside it.
2. **Type**: time series, bar chart, Top N, table or metric summary.
3. **Break it down** with the type's settings: a time series' **Split by** (one line per value, top N), a bar chart's **Bars by** and **Stack by**, a table's **Rows by** dimensions and **Rows by period**, Top N's **Rank**. Only dimensions every picked metric has are offered.
4. **Filters**: **+ Filter** opens a builder (dimension, operator, value), or write a raw MetricFlow `where`.
5. **Period** in the bar above the chart: the same pickers as dashboards — a preset or calendar range, compared with the previous period, the same period last year, a custom range or nothing.

Its chart, previous period included, shows as you change it. Whenever there's no stored result for the settings, it runs on your warehouse with the active target and profile (`dbt show`); **Refresh** (⌘↵) runs it again anyway. Under it, **Table** has the rows and **SQL** the query MetricFlow generated (per query when it runs several: current and previous period, total and trend…); **Copy** the SQL or **Open in Workspace** to save it as a new file under your workspace's `metrics/` folder. **Debug** shows MetricFlow's plan step by step and checks it on the warehouse — see [Debug metrics](debug-metrics.md). **Compare** (Pro) runs the query two ways and shows what moved — see [Compare metrics](compare-metrics.md).

The widget lives in the URL, so back/forward steps through your queries and you can share or bookmark a link.

### Results are remembered

Every result is stored, keyed by the exact SQL, your dbt target, the environment variables wickd sets (global, profile and project vars) and your `profiles.yml`. So when you come back to a query, its last result shows right away without hitting the warehouse. Switching to a profile that points the same target at another warehouse is a different environment, so it never shows the other environment's numbers. Only a hash of the variables is stored, never their values. Editing a metric's YAML changes its SQL, so a stored result no longer matches; use **Refresh** after a parse to see the new numbers.

## Saved queries

Saved queries are listed under the metrics. Click one (or its pencil) to open its definition in the query view.

**Save as saved query** is in every chart's ⋯ menu (the metric page's charts, the Investigate widget, dashboard widgets). It asks for a name (suggested from the metrics and group-bys, like `revenue_by_week`), then shows the change in the review window: nothing is written until you **Accept**. It saves the chart's query (its metrics, group-bys and filters) as a `saved_queries:` entry in your existing saved-queries file, or else the file that defines the first metric. wickd only adds lines in the file's own indentation style and checks the result parses to exactly the old file plus the new entry. The new saved query shows up in the list after dbt re-parses (wickd does that automatically).

## Add it to a dashboard

The widget's ⋯ menu (top right) has **Add to dashboard**, which adds it to a dashboard as configured, **Save as saved query**, then the data items every chart menu shares: **View SQL**, **Open in Workspace**, **Download PNG** and **Download CSV**. See [Build metric dashboards](metric-dashboards.md).

## Other ways in

- **Side pane** (DAG or Files) and **Docs**: metric, semantic model and saved query nodes have an **Explore** button, and metrics a **Metric page** button. In Docs, a metric also shows its last stored result as a sparkline.
- **Command palette** (⌘K): "Metric: …" (its page), "Explore metric: …", "Run saved query: …" and "Go to Metrics".
- **Monitor** (Pro) on a metric's page: opens **Monitors** with the metric and grain filled in. See [Monitor metrics for anomalies](metric-monitors.md).
