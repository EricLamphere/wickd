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

The query view (**Investigate** on a metric's page, a dashboard value's right-click **Investigate** or a widget's ⋯ **Investigate**, a saved query, Docs' **Explore**, ⌘K, or the box above the metric index) opens in a window over the metric's page, titled with the metric; close it (✕, Esc or a click outside) to get back to the page. It's one widget — any of the dashboard widget types — that you edit two ways, which always agree: type it in the line across the top, or click through its settings on the right, exactly as on a dashboard.

### Type it

The line across the top shows the query as chips, and you type into it:

```
revenue orders by customer__region · last 90 days vs last year · where customer__tier = gold · top 10
```

| Type | Means |
|------|-------|
| a metric's name or label (`revenue`, `order count`) | add the metric |
| `by <dimension>` (`by customer__region`, `by region` when only one dimension ends in `region`), several with `,` or `and` | break it down: a time series' split, a bar chart's bars then stacks, Top N's ranking, a table's rows |
| `over time`, `by day` / `week` / `month` / `quarter` / `year`, `daily`, `monthly`, … | over time (at that grain) |
| a period: `last 7 / 30 / 90 days`, `last 12 months`, `mtd` / `qtd` / `ytd`, `this month`, `last month`, `last quarter`, `all time`, `today`, `yesterday`, `last 2 weeks`, `this week`, `last week`, `last year`, `2025`, `2026-03`, `Q1`, `Q4 2025`, `March`, `since March`, `since 2026-01-15`, `2026-01-01 to 2026-03-31` | the current period |
| `vs previous`, `vs last year`, `vs nothing` / `no comparison`, `vs <a period>` | what it's compared with |
| `where <dimension> <op> <value>`: `=`, `!=`, `>`, `>=`, `<`, `<=`, `in (a, b)`, `not in`, `like`, `is null`, `is not null`; more with `and`. Quote values with spaces: `'New York'` | a filter |
| `top N` | how many lines, bars, ranked rows or table rows |

Suggestions follow what you type: metrics first, after `by` the dimensions every picked metric shares and the grains, after `where` the dimension, then the operator, then its values from your warehouse. ↑↓ pick one, Enter or Tab takes it. Nothing runs while you type: **Enter** on a finished line applies it (⌘↵ applies and runs, like **Refresh**), and so does clicking away. **Esc** puts the line back as it was. Click a chip to edit it as text; Backspace on an empty line removes the last chip, ←/→ walk the chips (Enter edits the selected one, Backspace removes it). The period and comparison chips are the usual date pickers. Anything the composer doesn't understand, or that the widget can't show (a second `by` on a Top N, a dimension one of the metrics doesn't have), is underlined red with the reason and nothing is applied until you fix it.

The line picks the widget's type from what you type — over time → time series, `by` a dimension → bar chart (plus `top N` on one metric → Top N), neither → metric summary — until you pick a type in the settings; after that it never changes it.

**Ask in words** (Pro): start the line with `?` (`? which regions grew revenue most last quarter`) and press Enter. Wicky writes the query with your metrics and fills in the chips; check them, then Enter runs it. If your metrics can't answer the question, it says so (ask in Wicky to get plain SQL instead). The questions also show in Wicky's history.

The box above the metric index takes the same line: Enter opens the query view with it.

### Or click it

1. **Metrics**: it starts with the page's metric; **Add a metric…** in Configure to put others beside it.
2. **Type**: time series, bar chart, Top N, table or metric summary.
3. **Break it down** with the type's settings: a time series' **Split by** (one line per value, top N), a bar chart's **Bars by** and **Stack by**, a table's **Rows by** dimensions and **Rows by period**, Top N's **Rank**. Only dimensions every picked metric has are offered.
4. **Filters**: **+ Filter** opens a builder (dimension, operator, value), or write a raw MetricFlow `where`.
5. **Period**: the date chips in the line above the chart are the same pickers as dashboards — a preset or calendar range, compared with the previous period, the same period last year, a custom range or nothing.

Its chart, previous period included, shows as you change it. Whenever there's no stored result for the settings, it runs on your warehouse with the active target and profile (`dbt show`); **Refresh** (⌘↵) runs it again anyway. Under it, the first tab, **Debug**, shows MetricFlow's plan step by step and checks it on the warehouse — see [Debug metrics](debug-metrics.md). **Table** has the rows and **SQL** the query MetricFlow generated (per query when it runs several: current and previous period, total and trend…); **Copy** the SQL or **Open in Workspace** to save it as a new file under your workspace's `metrics/` folder. **Compare** (Pro) runs the query two ways and shows what moved — see [Compare metrics](compare-metrics.md).

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
