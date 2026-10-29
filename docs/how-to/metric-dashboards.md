# Build metric dashboards

A dashboard is a working view of the metrics you own. You lay metrics out as widgets, pick a current period and what to compare it with, and refresh everything in one warehouse run. It isn't a BI tool: there are no viewers, sharing, permissions or schedules. Each dashboard is a YAML file in your project, so it's versioned, reviewed in Source Control and shared with your team like any other code.

Dashboards are on **Metrics → Dashboards**. Like the rest of the Metrics page, they need MetricFlow (see [Use the semantic layer](semantic-layer.md)).

## The builder

Open a dashboard (or **New dashboard**) and you get three panes:

- **Metrics** (left): every metric grouped by semantic model, plus saved queries. Metrics already on the dashboard have a teal dot; with wickd Pro, a second dot shows a monitor's status.
- **The canvas** (middle): your widgets, flowing left to right, each at the size you drag it to. The dashboard has a fixed width (1200 px unless you change it), so widgets keep their size whatever the window or the rails do.
- **Widgets** (right): the widget types. When a widget is selected, the **Configure** tab shows its settings.

The rails float over the canvas. Drag a rail's inner edge to make it wider or narrower (double-click the edge to reset); wickd remembers the widths, and the widgets don't move or resize. When the dashboard is wider than the space between the rails, scroll it out from under them. Change the dashboard's width under **Widgets → Dashboard width**, or drag the dashboard's right edge.

There's no Edit button. Every change is saved to the file a moment later ("Saving… / Saved" next to the title), and **⌘Z** / **⇧⌘Z** (or the arrows) undo and redo. **Present** hides both rails for a clean view; **Esc** brings them back.

### Add metrics

- **Drag a metric onto empty space** to start a Metric summary for it. When the canvas is full, a "Drop here for a new widget" zone appears at the bottom of the visible canvas while you drag.
- **Drag a metric onto a widget** to add it there. The widget says "Add Orders" while you hover, or why it can't take it ("Top N shows one metric", "orders can't be broken down by order__channel").
- **Click a metric** to add it to the selected widget, or to start a new summary when nothing is selected.
- **Drag a saved query** onto empty space to make a widget from it. Its metrics, group-bys and filters are copied, so you can change them.

### Add widgets

Drag a widget type from the right rail onto the canvas (it's inserted before the widget you drop it on, or at the end), or click it to add it at the end. A new widget waits for a metric: "Drag a metric from the left onto this widget."

| Widget | Shows |
|---|---|
| **Metric summary** | The period's total, the previous period's total and the change (green or red, depending on whether higher is better), and the trend with the previous period dashed underneath. The total is its own query, so ratios and averages are right, never a sum of the trend. |
| **Time series** | Each metric over time, with the previous period as a faded dashed gray line lined up period by period (this Tuesday over last period's Tuesday). Line, area or stacked area; optionally split by a dimension (its top N values). |
| **Bar chart** | One bar per value of a dimension, with a gray bar for the previous period beside each. Vertical or horizontal, sorted by value or name, top N, or stacked by a second dimension: the previous period's bar stands beside each stacked bar, split the same way in the same colors, faded; with several metrics, each gets its own stacked chart. |
| **Top N** | A dimension's top values for one metric, with an inline bar and the change vs the previous period ("new" when it wasn't there before). |
| **Table** | Metrics by period (optional) and up to five dimensions, with "previous" and "change" columns per metric. |
| **Text** | A heading or a note: `#`, `##`, `###` headings, `-` bullets and `**bold**`. |

With several metrics, a time series or bar chart draws them on one chart when their scales are close, and gives each its own chart when one is 10× the other (revenue next to a conversion rate). **Several metrics** in the settings forces either.

### Arrange

- **Move**: drag a widget by the grip that appears at the left of its header on hover. A copy follows the pointer, the other widgets move into the order it would make (a dashed outline shows where it lands), and it's saved when you drop; **Esc** puts everything back.
- **Resize**: drag its right edge (width), bottom edge (height) or bottom-right corner (both), to any size. The widget follows the pointer and shows its size ("50% × 300px · locked"). A widget stops at the dashboard's right edge rather than dropping to the next row; widgets to its right move down to make room. Lock points make sizes easy to match: a widget's right edge locks to the dashboard's grid — every 100 px from the dashboard's left edge, the quarter lines (25%, 50%, 75%) and the right edge — wherever the widget is, so edges line up across widgets; heights lock at every 100 px from the top of the widget's row and at the bottoms of the other widgets in the row, so bottoms line up. Dashed guides show the lock points while you drag: the whole dashboard's vertical lines, labelled 100, 200, … (at the top of the view) and 25% / 50% / 75% (at the bottom), with the labels staying in view as you scroll, horizontal lines labelled 100, 200, … and "row" for a neighbour's bottom. Between lock points the size moves freely. Dragging past the edge of the view scrolls it; **Esc** cancels a resize.
- **⋯ menu**: Open in explorer, View SQL (every query the widget runs), Copy CSV, Refresh, Duplicate, Remove. **Delete** / **Backspace** removes the selected widget.

Widgets flow left to right in the order they're listed in the file. A widget that doesn't fit on the rest of a row starts the next row (widths that add up to 100% fill a row exactly). 
### Configure a widget

Select a widget (click it) and the right rail switches to **Configure**:

- **Shared**: title, type, metrics, filters (added to the dashboard's filters, for this widget only), and a **period** and **compare to** that override the dashboard's. The first option in each, **Use the dashboard's …**, goes back to following the dashboard. Changing the type keeps what fits: a Bar chart or Top N picks a dimension, and Top N keeps the first metric.
- **Type-specific**: number format (number, currency with a currency code, percent) and decimals; higher is better; the change %, the previous period's value and dates, the trend and the previous period on the trend, each on/off (summary; all on by default); style, grain, split by, top N, start the y-axis at zero (time series); bars by, stack by, orientation, sort, top N, show the previous period (bar chart); rank by, top N, show the change (Top N); rows by period (the dashboard's grain or its own; oldest first, compared period by period), rows by, row count, comparison columns (table); the text (text).

## Period, comparison and filters

The bar under the title applies to every widget:

- **Current period**: last 7 / 30 / 90 days, last 12 months, month, quarter or year to date, last month, last quarter, all time, or pick a start and end date in the calendar. Presets are stored as presets, so "Last 30 days" stays current.
- **vs**: the previous period (same length, right before), the same period last year, no comparison, or custom dates. Both buttons show the actual dates ("Sep 29 – Oct 28, 2026").
- **Grain**: Auto follows the period's length (day up to a month, week up to six months, month up to three years, else quarter), or pick one.
- **Filters**: the value box suggests the dimension's values (largest first). A filter applies to every widget whose metrics all have that dimension; elsewhere the widget skips it and says so under the chart.
- **Show a value over time**: click a bar or a Top N row and the widget splits top and bottom to show its metrics over time for that value across the full width, with the previous period dashed in gray; the value stays highlighted. Click another value to switch, the same one (or ×) to close. These aren't saved to the file.
- **Stacked bars**: every segment can be hovered and clicked, the previous period's faded ones included (they pick the same bar and stack value). A segment stands for both values, the bar's and the stack's: clicking it shows that combination over time, and right-click → Apply as dashboard filter adds both filters. Hover above a bar (outside its segments) and click or right-click to pick the bar's value alone.
- **Right-click a value** (a bar, a stacked segment, a Top N row or a table row) for **Show timeseries**, **Apply as dashboard filter**, **Drill into…** and **Open in explorer, filtered**. Drill into… opens a window of widgets filtered to the value: a metric summary beside a time series, a horizontal bar chart (top 15) by the first dimension its metrics share that no filter already uses (the dashboard's, the widget's or the value's own; change it in its settings), and a table by period. Click any of them to configure it in the side pane with the same settings as a dashboard widget (title, type, metrics, filters — including the value's own —, period, comparison and its type's settings); Escape in the pane closes it. **Add to dashboard** (bottom right) lets you tick which of them to add, as configured, with Select all / Deselect all. They're inserted after the widget you drilled into. They start with that widget's own filters, period and number format.

## Refresh

Opening a dashboard shows each widget's last stored result straight away, with how long ago it ran. Nothing runs on the warehouse until you ask:

- **Refresh on &lt;target&gt;** runs every widget in **one** `dbt show` (identical queries run once).
- When you add or change a widget (or the period, grain or filters), the widgets that have no stored result for their new queries run on their own.
- A widget's **Run** button or **⋯ → Refresh** runs just that widget.

Results are shared with the explorer and kept per dbt target and environment. A widget says "No result for these settings yet" when its queries changed, including when a dbt run re-parsed your project and changed the metric's SQL.

When a metric a widget uses is renamed or deleted, only that widget shows "metric `revenue` no longer exists — remove it from the widget".

## Monitor overlays (Pro)

With wickd Pro, widgets show the status of [metric monitors](metric-monitors.md) on their metrics (Anomaly, Warning, Learning). A time series of one metric, unfiltered and not split, at the same grain as an unsliced monitor also draws the monitor's expected band and its flagged periods. Without Pro, widgets look the same without the overlays.

## Register as exposure

**Register as exposure** asks for an owner, then opens the review window with the change: a dbt exposure for the dashboard, plus `exposure: <name>` in the dashboard's file. Nothing is written until you accept (all at once, or file by file); reject and nothing changes. The exposure looks like this:

```yaml
exposures:
  - name: revenue_overview
    type: dashboard
    description: "Revenue overview"
    owner:
      name: "Data team"
    depends_on:
      - metric('revenue')
      - metric('order_count')
    meta:
      wickd_dashboard: "wickd/dashboards/revenue-overview.yml"
```

It goes in your project's existing exposures file, or else a new `exposures.yml` in your first model path. wickd only adds lines, in the file's own indentation style, and checks the result before writing. After dbt re-parses (automatic), the dashboard appears in the DAG, Docs and Impact like any downstream consumer. The exposure's name shows next to the dashboard's title as a chip: **green** while the exposure lists exactly the dashboard's metrics, **yellow** ("out of date") when you've added a metric to the dashboard (or removed one), and **red** ("dead link") when the exposure isn't in the project any more (wickd re-parses automatically after YAML changes). When it's yellow, **Update exposure** opens the review window with the exposure's `depends_on` updated to the dashboard's metrics (other entries, like `ref('orders')`, are kept). Click the chip for:

- **Open the exposure YAML**
- **Update the exposure YAML** (when it's out of date)
- **Unlink**: removes `exposure:` from the dashboard file and leaves the exposure itself alone (undoable like any edit)
- **Unlink and delete exposure**: opens the review window with the exposure removed from its YAML (the file is deleted when nothing else is left in it) and the dashboard unlinked; nothing changes until you accept

When the link is dead, **Register again** writes a new exposure.

## Export

**Export** writes a file to a folder you choose (default `~/Downloads`):

- **HTML**: one self-contained file that opens in any browser, offline. The charts look as they do in wickd, hover shows values, and the data is embedded. It loads nothing from the internet.
- **PNG**: an image of the dashboard.

Both say which target, which period and comparison, and when the data was queried. They export what's shown, so refresh first if widgets have no data.

## The file

Dashboards live in `wickd/dashboards/<name>.yml`. Change the folder with the **DASHBOARDS_PATH** project setting (Environment → Settings → Project); it must be inside the project. Files you edit by hand (or that change through git) reload in the app automatically; if one changes while you have unsaved edits, wickd says so instead of overwriting it.

```yaml
version: 1
title: Revenue overview
period:
  current: last_30_days          # a preset, or {start: 2026-01-01, end: 2026-03-31}
  compare: previous_period       # previous_period | previous_year | none | {start, end}
grain: auto                      # auto | day | week | month | quarter | year
canvas_width: 1200               # px; widget widths are a share of it
filters: ["{{ Dimension('customer__region') }} = 'north'"]
widgets:
  - id: revenue
    type: summary                # summary | timeseries | bar | leaderboard | table | text
    width: 25                    # percent of the canvas width
    height: 200                  # px
    metrics: [revenue]
    options: {format: currency}
  - id: revenue_trend
    type: timeseries
    width: 75
    height: 300
    metrics: [revenue, orders]
    period: {compare: previous_year}   # overrides the dashboard's, per key
  - id: by_channel
    type: bar
    width: 50
    height: 300
    metrics: [revenue]
    filters: ["{{ Dimension('order__status') }} = 'paid'"]
    options: {dimension: order__channel, top_n: 5}
  - id: notes
    type: text
    width: 50
    height: 90
    options: {body: "## Notes\n- Revenue is gross"}
```

- Widget ids and file names use lowercase letters, digits, `-` and `_`.
- Keys wickd doesn't know are kept when it saves the file. Comments aren't: a save from the app rewrites the file.
- A file that isn't valid still appears in the list, with the problem (e.g. `widgets.0.width: Input should be less than or equal to 100`), so you can fix it.
- Older files are read too: the first release's `tiles:` become widgets, and grid sizes (`w` columns of 12, `h` rows) become `width` / `height`. They're saved in this format the next time they change.
