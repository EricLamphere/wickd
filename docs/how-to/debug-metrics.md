# Debug metrics

When a metric looks wrong, the **Debug** tab shows what MetricFlow does to compute it and checks each step on your warehouse: how many rows go in, what the filter drops, where nulls are, whether a join multiplies rows, and whether a dimension is missing or spelled several ways. The plan and checks are free (Base). **Explain this number**, a written summary with the most likely cause, is Pro.

## Ways in

- **Metrics → a metric's page → Investigate**: the **Debug** tab under the widget, next to Table and SQL. Debug checks the widget's main query: its metrics, group-bys, filters and period.
- **A dashboard widget's ⋯ → Debug in Investigate**: opens the widget in the query view, as it ran on the dashboard (its filters and dates), straight on the Debug tab.

The tab is sticky like the others. Saved queries can't be debugged directly: pick their metrics in Configure.

## Cost

Nothing runs until you open the tab. Then every check runs together in one `dbt show`, and the header says how many check queries there are. Results are stored like metric results, so reopening Debug for the same query costs nothing. **Rerun checks** runs them all again; **Cancel** stops the batch (the dbt process is killed). Counts are cheap on columnar warehouses but scan whole tables, which can be slow on Postgres.

## The plan

**How MetricFlow computes it** is the plan drawn as a small graph, left to right: **Read** each semantic model → **Metric time** (which date is the metric's time) → **Time range** → **Join** (which models, on which entity, join type) → **Filter** → **Aggregate** → **Compute**. Ratio and derived metrics have one branch per input, joined by **Combine**; cumulative metrics add a **Cumulative window** step and offsets a **Time spine** step. Each box says what the step does with your names (*Reads mart_sales*, *Uses order_date as the time*); steps wickd checks carry their status (a warning colours the box). Hover a box for more.

**Quality checks** (left) lists every check, grouped by what it's about: each table MetricFlow reads and each join, worst group first. Those are the only steps wickd checks; the others (metric time, time range, aggregate, compute) only reshape the query. Click any box in the graph to highlight its part of **MetricFlow's SQL** (right): the SELECT it's written in, faintly, and the lines doing that step's work, strongly:

| Step | Lines |
|---|---|
| Read | the table in `FROM` / `JOIN` |
| Metric time | the `… AS metric_time__<grain>` column (without one, where its date column is used) |
| Time range | the `WHERE` line with the period's dates |
| Filter | the other `WHERE` lines |
| Join | the `JOIN … ON …` lines |
| Aggregate | the aggregate functions (`SUM`, `COUNT`, …) and `GROUP BY` |
| Compute | the `… AS <metric>` columns |
| Order & limit | `ORDER BY` / `LIMIT` |

MetricFlow writes several steps into one SELECT and only names them in the comments above it, so when a step's lines can't be told apart the comment naming it is highlighted instead; a step the query's SQL doesn't use (say, another table's time column in a breakdown) says so. Other steps' SELECTs nested inside aren't highlighted. A step without a SELECT of its own is shown in the SELECT of the step it feeds. **Open in Workspace** opens the whole query. If the plan isn't available (another MetricFlow version), the steps are listed from the SQL's comments instead.

## Checks

| Step | Check | Flags |
|---|---|---|
| Read (per table) | Rows in the table and in the requested range (with the query's filters when they only use that model) | an empty table, or no rows in range |
| | Rows kept by the metric's own filter | a filter that drops every row; skipped when the filter needs a joined dimension |
| | Nulls in the input's expression (`amount`) | any: the aggregation skips them |
| | The agg time dimension's min / max vs the requested range | no overlap (fail), partial coverage (warning) |
| Join (per entity join) | Rows before and after joining, keys repeated on the right side | **fan-out**: the join multiplies rows, so sums count them twice (the entity isn't unique where it's declared primary) |
| | Left rows with no match | they show under **∅** for the joined model's dimensions |
| Read (per categorical group-by) | Null and empty values | they show as **∅** |
| | Values that differ only by case or whitespace (`US` / `us `) | they are split into several groups |

Problems are listed at the top, worst first, as what they mean for the number and what to do. Time coverage problems are spelled out and offer a fix that changes the query's period:

- *Data ends Oct 28, 2026: the last 5 days of your period are empty.* → **End the period on Oct 28**
- *Data starts …: the first N days of your period are empty.* → **Start the period on …**
- *No data in your period: mart_sales has data from … to ….* → **Show its last 30 days of data**

The usual cause is a model that hasn't been rebuilt or a source that's behind, not the metric's definition. **Show the check** scrolls to it in Quality checks. Each check shows the SQL it ran (**Check SQL**, **Open in Workspace**).

## Reconcile with SQL

Checks the metric against your own calculation. The two queries are side by side: **MetricFlow's SQL** (the metric, read-only) on the left and **Your SQL** (editable) on the right. **Run and compare** runs both:

1. **the metric**: the SQL MetricFlow generates for this query (its stored result when there is one), and
2. **your SQL**: the query in the box.

It then matches their rows on the group-by columns (e.g. `metric_time__day`) and lists the rows where the numbers differ, exist only in the metric, or exist only in your SQL.

The box starts with a draft written from the metric's definition without MetricFlow, which runs as-is: simple metrics as their aggregation (with the metric's filter as a `case when`), ratios as `1.0 * numerator / nullif(denominator, 0)`, derived metrics with each input substituted into the expression; plus the time grain and the period. Edit it to the calculation you trust. Group-bys from another semantic model are marked `…` for you to join. Cumulative and conversion metrics, offsets, and inputs on several tables get a skeleton instead; Run and compare stays disabled until every `…` is replaced. Your SQL must be a single SELECT (`ref()` / `source()` allowed). Don't put Jinja in comments: dbt renders it there too. The draft is kept for the session.

## Explain this number (Pro)

Builds a short explanation from the stored checks and the definition, for example: *"`revenue` sums `amount` from orders, only where status = 'completed' — that excludes 3% of its rows. 3% of orders rows have no customers match, so they fall under ∅ for `customer__region`."* It names the most likely cause first (a fan-out outranks a missing range, which outranks unmatched rows or nulls) and links each point to the check behind it. Run the checks first: explaining never queries the warehouse.
