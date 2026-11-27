# Write metric notes

"Revenue dropped on Nov 3 because EU checkout was down." Write it once as a **metric note**, and
everyone who looks at that metric sees it: on dashboards, metric pages and monitors.

## What a note holds

- a **date range** (required; a single day is fine);
- optionally **one metric**: with none, the note applies to every metric (a company-wide event);
- optionally **one dimension value**, e.g. `order__region = EU`: the note then applies wherever
  that dimension isn't filtered to another value. A note with a dimension but no metric applies
  to every metric that has that dimension;
- a **title** and a **Markdown** body, with screenshots;
- optionally **tags** (`#outage`, `#release`), to filter by;
- a **type**: **Note** (sticky note), **Release** (rocket) or **Incident** (a red circle with a dot while open, a yellow circle with a check once resolved). An incident is
  **Open** (shown red instead of amber everywhere) or **Resolved** (with the date). The type's icon
  shows on the note, in the Notes list, in pins' lists and in a model's side pane;
- optionally **Repeats every year**, for holidays and other dates that are unusual every year;
- the **widget it was written about**, saved when you add a note from a widget, a value or the
  query view.

## Add a note

Choose **Add note…** where a metric appears. The New note dialog opens filled in from where you
clicked:

| Where | How | Filled in with |
|-------|-----|----------------|
| Dashboard widget | ⋯ → Add note… | its metric, its current period, a dimension value its filters pin |
| A value (bar, row, time series period) | right-click → Add note… | the value and its period |
| Drill into… | Add note… | the drilled value |
| Metric page | Add note, a chart's ⋯, or right-click the time series | the metric (and the period clicked) |
| Query view | the chart's ⋯ → Add note… | its metric, period and filters |
| Metrics sidebar | right-click a metric | the metric, today |
| Monitor card or chart | right-click (a period on the chart) | the metric, that period, the slice's value |
| Files | right-click inside a metric's YAML definition → Add metric note… | the metric under the cursor |
| Metrics → Notes | New note | — |

A new note can **Start from** a template: **Incident** (type Incident, open), **Release** (type
Release), **Backfill** or **Definition change**. Each sets the type and adds its tags and a body
outline. Picking another template replaces what the last one put in that you haven't changed (its
title, outline, tags and type); anything you edited stays, and the new outline goes after it.

Write the body in Markdown; **Preview** shows it rendered (the tab you use is remembered). Paste
or drop a screenshot into the editor: it's saved to the images folder and linked at the cursor.
Images may be PNG, JPEG, GIF or WebP, up to 5 MB.

### Links and mentions

While you type in the body, wickd suggests:

| Type | Suggests | Shows as |
|------|----------|----------|
| `note:` | other notes | the note's title, linking to it (it lists this note under **Linked from**) |
| `model:` | the project's models, seeds, snapshots and sources | the node's name, linking to it in the DAG; the note is listed in that node's side pane under **Notes** |
| `commit:` | the repository's last 100 commits | the short hash, linking to the commit's message, author and date |

Use ↑ ↓ to move, Enter or Tab to choose, Esc to close. The saved note and Preview show only the
linked name (`note:eu-rollback` reads as the note's title, `model:fct_orders` as `fct_orders`).
Mentions inside code are left alone. Older `[[slug]]` note links still work.

Following a link to another note opens it in the same window, with **back** and **forward** arrows
in its header (or ⌘[ / ⌘]) to return along the notes you followed. On the Notes tab, the browser's
back and forward move along them too.

## Where notes show up

- **Time series** (dashboard widgets, metric pages, the query view, monitor charts): a shaded band
  over the note's periods with a pin on top; a single period is a dashed line. A one-day note on
  a weekly chart covers that week.
- **Summary, Top N, table and bar widgets**: a pin with a count in the header when a note covers
  the widget's current period. Bar charts also mark the bar a note's dimension value is about.
- **Monitors** (Pro): a pin on the card when a note covers its latest flagged period, and
  "Explained by a note" on flagged periods in the detail.

Open incidents are red instead of amber. A note that repeats every year shows on every year a
chart covers. Hover a pin for the titles; click it to read the note (or pick one when several share it).

On a dashboard, the **Notes** button in the header hides or shows notes on its widgets, while
editing and in Present mode; the choice is remembered per dashboard. **Export** has **Include
metric notes** (on unless the toggle is off): included, the HTML and PNG keep the bands and pins
and list the notes under the dashboard; left out, the file has none.

## Reading a note

A note shows its type, dates, metric, dimension value, tags and whether it repeats.
Below the body:

- **Written about**: the widget the note was written about, drawn from stored results (opening a
  note never queries the warehouse; **Run** runs it), and **Open as it was** to open it in the
  query view with the same dates and filters;
- **Linked from**: notes that link to this one;
- the monitor periods marked as expected that link to it.

**Resolve** closes an open incident (dated today) and **Reopen** opens it again, from the note or in the note dialog beside the type (where the resolved date can be changed).

## Recurring notes and monitors

A note that **repeats every year** applies on the same dates every year, before and after the year
it was written (Feb 29 falls on Feb 28 in other years). Monitors using the **seasonal** algorithm
(Pro) don't flag periods such a note covers and leave them out of their baselines, the same as
marking them as expected. The note's metric and dimension value still apply. Threshold, change
and no-data monitors aren't affected: a threshold still fires on Black Friday.

## The Notes tab

**Metrics → Notes** lists every note, grouped by month. Sort by start date (the default), end date or date added, newest or oldest first (the arrow button); the choice is remembered per project. Filter by text, metric,
dimension, tag, type (notes, releases, incidents, or open incidents only) or dates.

**Timeline** (beside List) puts the filtered notes on one date axis over the last 3, 6, 12 or 24
months: a row per metric ("Every metric" first), a bar per note (red for open incidents, one per
year for recurring notes), and a line for today. Click a bar to open the note. The view and span
are remembered per project. Open one to read it, **Edit** it, **Open file** in Files, or **Delete** it
(deleting offers to remove the screenshots only that note uses). A metric or dimension that's no
longer in the semantic layer shows a warning on the note rather than breaking it.

## Mark as expected → note (Pro)

**Draft** (Wicky, Pro) on a flagged period writes a first draft of the note: a title and a few
sentences from the value against what was expected, the periods around it and any notes near it.
It opens in New note for you to check and save; nothing is saved until you do.

Wicky's **Ask** also reads your notes, so "what happened to revenue in November?" can cite them.


When you mark a monitor's flagged period as expected, wickd offers to write a note about it,
prefilled with the metric, the period, the slice and the value against what was expected.
**Save** links the note to the period; **Skip** leaves it marked without one. Tick **Don't ask
again** to stop the question for this project.

Every period marked as expected is listed under **Marked as expected** on the Monitors tab: the
monitor, the period, what it was flagged as, value vs expected, when it was marked, and its note
(or **Add note**). The list outlives the monitor's stored history. Undoing a mark removes its
entry but keeps the note, which is a file in your repo.

## Files

Notes are Markdown files with YAML frontmatter in `wickd/notes/<name>.md`, and screenshots go in
`wickd/img/`, so they're reviewed and shared through git like dashboards:

```markdown
---
title: EU checkout outage
start: 2026-11-03
end: 2026-11-04
metric: revenue
dimension: order__region
value: EU
tags:
- outage
type: incident
status: resolved
resolved: 2026-11-05
widget: {type: timeseries, metrics: [revenue], period: {current: {start: '2026-10-01', end: '2026-11-30'}}}
source: {dashboard: weekly-kpis, widget: w3}
created: '2026-11-05T14:02:00Z'
---

Checkout returned 500s for EU cards from 09:10–15:40 UTC, caused by model:stg_payments
(commit:3f2a9c1). The fix is in note:eu-checkout-rollback.

![error rate](../img/eu-checkout-outage-1.png)
```

`end` is inclusive. `metrics: [revenue, orders]` ties a note to several metrics. `recurs: yearly`
repeats it every year; `type` is `note` (the default), `release` or `incident`, and an incident's
`status` is `open` or `resolved` (a `status` without a `type` reads as an incident). `models:` and `commits:` lists in the
frontmatter count as mentions too. Keys wickd doesn't
know are kept when it saves. Change the folders with the **NOTES_PATH** and **NOTES_IMG_PATH**
project settings (Environment → Settings → Project); both must be inside the project. Files edited
by hand or changed through git reload in the app; saving over a note that changed on disk since
you opened it asks you to reload instead.
