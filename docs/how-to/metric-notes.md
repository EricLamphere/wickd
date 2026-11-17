# Write metric notes

"Revenue dropped on Nov 3 because EU checkout was down." Write it once as a **metric note**, and
everyone who looks at that metric sees it: on dashboards, metric pages and monitors.

## What a note holds

- a **date range** (required; a single day is fine);
- optionally **one metric**: with none, the note applies to every metric (a company-wide event);
- optionally **one dimension value**, e.g. `order__region = EU`: the note then applies wherever
  that dimension isn't filtered to another value. A note with a dimension but no metric applies
  to every metric that has that dimension;
- a **title** and a **Markdown** body, with screenshots.

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

Write the body in Markdown; **Preview** shows it rendered (the tab you use is remembered). Paste
or drop a screenshot into the editor: it's saved to the images folder and linked at the cursor.
Images may be PNG, JPEG, GIF or WebP, up to 5 MB.

## Where notes show up

- **Time series** (dashboard widgets, metric pages, the query view, monitor charts): a shaded band
  over the note's periods with a pin on top; a single period is a dashed line. A one-day note on
  a weekly chart covers that week.
- **Summary, Top N, table and bar widgets**: a pin with a count in the header when a note covers
  the widget's current period. Bar charts also mark the bar a note's dimension value is about.
- **Monitors** (Pro): a pin on the card when a note covers its latest flagged period, and
  "Explained by a note" on flagged periods in the detail.

Hover a pin for the titles; click it to read the note (or pick one when several share it).

## The Notes tab

**Metrics → Notes** lists every note, newest first, grouped by month. Filter by text, metric,
dimension or dates. Open one to read it, **Edit** it, **Open file** in Files, or **Delete** it
(deleting offers to remove the screenshots only that note uses). A metric or dimension that's no
longer in the semantic layer shows a warning on the note rather than breaking it.

## Mark as expected → note (Pro)

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
created: '2026-11-05T14:02:00Z'
---

Checkout returned 500s for EU cards from 09:10–15:40 UTC.

![error rate](../img/eu-checkout-outage-1.png)
```

`end` is inclusive. `metrics: [revenue, orders]` ties a note to several metrics. Keys wickd doesn't
know are kept when it saves. Change the folders with the **NOTES_PATH** and **NOTES_IMG_PATH**
project settings (Environment → Settings → Project); both must be inside the project. Files edited
by hand or changed through git reload in the app; saving over a note that changed on disk since
you opened it asks you to reload instead.
