# Monitor metrics for anomalies (Pro)

Metric monitors watch metrics from your [semantic layer](semantic-layer.md) and flag
periods that look wrong: spikes and drops against a seasonal baseline, level shifts,
missing or zero periods, and past periods whose values changed (restatements). After a
build, they tell you whether the change you just made moved a metric.

> **Checked when you build or look.** wickd runs only while it's open, so monitors are
> checked after a build that touches them, when you press **Check now**, or on an
> interval you set while the app is open. This isn't 3 a.m. alerting.

## Create a monitor

1. Open **Metrics → Monitors** and click **New monitor**, or pick one metric in the
   explorer and click **Monitor this metric** (the grain and a categorical group-by
   carry over).
2. Choose:
   - **Grain**: day, week or month.
   - **Slice by** (optional): one categorical dimension. wickd watches its top 10
     values separately (by total over the history window), recomputed weekly.
   - **Sensitivity**: low, normal or high. This is the only detection setting.
   - **Target** (shown when `profiles.yml` has more than one): follow the active target,
     or always check one (e.g. `prod`).
3. **Create monitor** runs the first check. It loads up to 180 days, 52 weeks or 24
   months of history. Later checks only re-read the last 35 days, 14 weeks or 14 months,
   so warehouse cost stays flat.

A project can have up to 25 monitors.

## Read a monitor

Each card shows a sparkline of recent periods over the shaded **normal range**, the
latest complete value compared with what was expected, the status, and each slice's
status.

| Status | Meaning |
|---|---|
| Normal | Recent periods are inside the normal range |
| Warning | The latest period is unusual, or a past period was restated in this check |
| Anomaly | A spike or drop, a missing or zero period, or a level shift that hasn't recovered, in the last 7 days / 4 weeks / 3 months |
| Learning | Not enough history yet: 7 weeks of days, 16 weeks, or 12 months |
| Refresh failed | The query for this monitor failed (the card shows dbt's error) |

Drag a card to reorder the monitors; the order is saved for the project. Click a card
for the detail view: a larger chart (hover any period for its value, normal
range, flag and score), the flagged periods, restated periods, every stored value, and
the settings.

### How periods are scored

- **Baseline:** for day grain, the median of the same weekday over the last 8 weeks;
  for week and month, the median of the last 8 or 6 periods. Recent residuals correct
  for a trend the median lags behind.
- **Score:** the distance from the expected value in robust standard deviations. Each
  sensitivity sets the warning and anomaly thresholds.
- **Level shift:** a run of periods consistently above or below expected.
- **Missing / zero:** no row, or a 0, where the series normally has values.
- **The current period** is drawn hollow and never scored, since it's still filling.
- **Restatement:** a past period whose value changed by more than 1% after it ended.
  Late-arriving data typically shows up as a drop in the latest period first, then as a
  restatement once it lands.

### Mark as expected

If a flagged period isn't a problem (a promotion, a known outage), click **Mark as
expected** in the detail view. The period stops being flagged and is left out of future
baselines. **Undo** flags it again.

## When monitors are checked

- **After a build:** a successful `run` or `build` that includes a model upstream of a
  monitored metric checks those monitors in the background.
- **Check now:** on the Monitors tab, in a monitor's detail view, or on the Health
  overview card.
- **Auto-check:** set an interval (1, 3, 6, 12 or 24 hours) on the Monitors tab, or
  `MONITOR_INTERVAL_HOURS` in **Environment → Settings → Project**. It's off by default
  and only runs while wickd is open.

Every check runs all due monitors in one `dbt show` per target. Only one check runs per
project at a time; requests that arrive meanwhile are combined into one follow-up.

## Targets

Monitors run on the active target (often `dev`) unless you pin one. History is stored
per target, so dev and prod never share a baseline. A card checked on another target
than the active one says so.

## Where else monitors show up

- **Health → Overview:** a Metric Monitors card (worst status first) and the nav rail's
  Health dot.
- **DAG:** monitored metric nodes carry a status badge (show metrics with the Type
  filter).
- **Impact:** the toolbar counts monitored metrics downstream of the selection or your
  changes and names any that look wrong; each metric row shows its monitor's status.
