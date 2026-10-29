# Explore metrics

The **Metrics** page answers "does my metric return what I think?" while you write it. Pick metrics, group-bys, a time grain, filters and a date range; wickd shows the SQL MetricFlow generates as you go, runs it on your warehouse when you ask, and charts the result.

The page appears in the left nav for projects that define metrics. It needs MetricFlow (see [Use the semantic layer](semantic-layer.md)); if MetricFlow is off or your dbt-core can't run it, the page offers the same "Enable MetricFlow" / "Choose a dbt-core version…" options as Health → Semantic Layer.

## Build a query

1. **Pick metrics** on the left. They're grouped by semantic model, with a type badge (simple, ratio, cumulative, derived, conversion). Search filters the list. ⌘-click a metric to open its YAML in Files.
2. **Group by**: only the dimensions valid for *every* selected metric are offered. `metric_time` comes first.
3. **Grain**: shown when a time dimension is selected. You can pick the dimension's own grain or anything coarser.
4. **Dates**: a preset (last 7/30/90 days, last 12 months, year to date) or a custom start/end. This sets MetricFlow's time constraint on `metric_time`.
5. **Filters**: **+ Filter** opens a builder (dimension, operator, value; comma-separate values for `in`). **Advanced** takes a raw MetricFlow `where`, e.g. `{{ Dimension('customer__country') }} = 'US'`, with buttons that insert dimension references.
6. **Order** and **Limit** (up to 5,000 rows).

The **SQL** tab updates as you change the query; this never touches the warehouse. **Copy** it, or **Open in Workspace** to save it as a new file under your workspace's `metrics/` folder and edit it in the SQL Workspace.

The whole query lives in the URL, so back/forward steps through your queries and you can share or bookmark a link.

## Run it

**Run on &lt;target&gt;** (⌘↵) explains the query, runs it with your dbt (`dbt show`, with the active target and profile) and shows:

- **Chart**: one chart per metric, each on its own scale (metrics are never stacked on a second axis). Grouping by a time dimension draws lines; otherwise bars. With a categorical group-by, each value gets its own series (the 8 largest are drawn and the rest are counted under the chart, never summed into "Other", since summing a ratio would be wrong). With no group-by you get a number tile per metric.
- **Table**: every row.
- **SQL**: the query that ran.

**Cancel** stops the run. If the result was cut at the row limit, a note suggests a coarser grain or a filter.

### Results are remembered

Every result is stored, keyed by the exact SQL, your dbt target, the environment variables wickd sets (global, profile and project vars) and your `profiles.yml`. So when you come back to a query, its last result shows right away ("Last run 4 min ago · target dev · profile prod") without hitting the warehouse. Switching to a profile that points the same target at another warehouse is a different environment, so it never shows the other environment's numbers. Only a hash of the variables is stored, never their values. Editing a metric's YAML changes its SQL, so the stored result no longer matches. If a parse lands after a result was shown, a "Definitions changed since this ran — Re-run" note appears.

## Saved queries

Saved queries are listed under the metrics. Click one to run it. The pencil opens its definition in the query builder so you can change it.

**Save as saved query…** writes the current query to your YAML as a `saved_queries:` entry. It goes in your existing saved-queries file, or else the file that defines the first metric. wickd only adds lines in the file's own indentation style and checks the result parses to exactly the old file plus the new entry before writing. A date range is saved as `metric_time` filters, since saved queries have no time constraint. The new saved query shows up in the list after dbt re-parses (wickd does that automatically).

## Add it to a dashboard

**Add to dashboard…** pins the current query to a dashboard as a tile. See [Build metric dashboards](metric-dashboards.md).

## Other ways in

- **Side pane** (DAG or Files) and **Docs**: metric, semantic model and saved query nodes have an **Explore** button. In Docs, a metric also shows its last stored result as a sparkline.
- **Command palette** (⌘K): "Explore metric: …", "Run saved query: …" and "Go to Metrics".
- **Monitor this metric** (Pro): with one metric picked, opens **Monitors** with the metric, grain and a categorical group-by filled in. See [Monitor metrics for anomalies](metric-monitors.md).
