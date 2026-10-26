# How to Analyze Run Performance

Find out why a dbt run is slow and what to change. The run timeline and the DAG
durations overlay are free; the critical path, regressions and recommendations
are part of wickd Pro.

wickd reads timing from `target/run_results.json` after each run it starts, so
timing details exist only for runs recorded from this version on. Older runs show
"No timing details for this run."

## See a run as a timeline

1. Open **Run History** in the left nav rail.
2. Click a run, then the **Timeline** tab in the detail panel.

Each lane is one dbt thread (`T1`, `T2`, …), and each bar is a node, from when it
started executing to when it finished. Bars are green for success and red for
errors; tests are drawn lighter. Hover a bar for its duration, rows affected and
bytes processed (when the adapter reports them). **Cmd+click** (Ctrl+click) a bar
to open the node in Files. Widen the panel by dragging its left edge when a run
has many threads.

## Find the critical path (Pro)

With Pro, the Timeline tab also shows:

- **The critical path**, outlined in amber: the chain of nodes that set the run's
  wall-clock time. Making anything else faster doesn't shorten the run.
- **Waits for a free thread**, a dashed amber strip under a lane: a critical-path
  node was ready but every thread was busy.
- **A summary strip**: wall time, *ideal* time (how long the run would take with
  unlimited threads), thread utilisation, and total time spent waiting for threads.

Without Pro, click **Find the critical path** to see the upgrade options.

## Performance tab (Pro)

Click **Performance** at the top right of Run History (the tab is kept in the URL,
`?tab=performance`). Pick a command to narrow it to, for example, `build` runs.
It looks at the last 20 finished runs:

- **Recommendations**: concrete changes, each with the evidence behind it:
  - *Make a model incremental*: a table on the critical path (or among the slowest
    nodes) that has been slow for at least 3 runs. Rated *high* confidence when it
    has a timestamp-like column (`updated_at`, `order_date`, …) to filter on.
    **Ask Wicky to draft it** opens Wicky with a request for an incremental version.
  - *Materialize a view as a table*: a view read by 3+ nodes in the run that took
    30s+ combined (a view's query runs again inside every model that selects from it).
  - *Raise threads*: threads were busy less than 60% of the run and the critical
    path waited for a free thread. Shows the most time it could save.
  - *Break up a bottleneck*: one node took more than 40% of a run of 30s or longer.
- **Regressions**: nodes at least 50% **and** at least 5 seconds slower than the
  median of their last 10 successful runs (3 earlier runs needed).
- **Slowest nodes**: median time over recent successful runs, with a trend.

Runs selected with `+model` only cover part of the DAG, so nodes are compared with
their own history, never one invocation with another.

## Durations overlay on the DAG

On the **DAG** page, click **Durations** in the filter bar. Each node gets a badge
with its median successful run time, colored by how it ranks against nodes of the same
type (models vs models, tests vs tests, seeds vs seeds): green (fastest half), yellow (top 50%), orange
(top 20%) and red (top 5%). Nodes under a second are never marked slow. The overlay
updates after every run.
