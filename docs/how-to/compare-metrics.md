# Compare metrics (Pro)

Compare mode runs one metric query two ways and shows what differs: the change in numbers your work makes, before you merge it. Impact tells you *which models* a change touches; compare tells you *which numbers move*.

## Ways in

- **Metrics → a metric's page → Investigate**: the **Compare** tab under the widget, next to Debug. It compares the widget's query: its metrics, group-bys, filters and current period. Without Pro the tab says it's a Pro feature.
- **Impact** (bottom pane), in **Uncommitted** or **Branch** mode: metric rows get **Compare numbers**, which opens the Compare tab with the same base as Impact set (it still waits for **Run comparison**).

Compare mode lives in the URL with the widget (`cmp=` / `cmp_base=`), so a compare can be linked and back/forward steps through it.

## Modes

| Mode | "Now" | "Before" |
|---|---|---|
| **Uncommitted changes vs HEAD** | your working copy | the last commit |
| **This branch vs its base** | your working copy | the merge base with the base branch (default `origin/main`, `main` or `master`; type another) — what your branch changed, not what landed on main since |
| **Two targets** | your active target | another dbt target (e.g. `prod`), same definitions |
| **Two metrics** | the query's metric | another metric, same query otherwise (e.g. `revenue` vs `revenue_v2`) |

Nothing runs until you've chosen what to compare with and clicked **Run comparison** (each compare is two warehouse queries). After changing the widget or the options, the result is marked out of date; run it again.

## What you see

- A headline: how many rows differ, the largest change, and whether every period moved the same way (a **level shift**) or only some did.
- Which dimension values carry the change (`customer__region = north −40%`), when the query is grouped by a dimension.
- Both sides on one chart: now solid, before dashed gray (bars side by side for dimensions).
- The differences: a table with each row's now / before / Δ / Δ% and whether it exists only now or only before. **Only rows that differ** is on by default.
- **Show the SQL diff**: the two SQL queries MetricFlow generated, side by side. Comparing revisions shows exactly what your YAML change did to the query.
- A metric that doesn't exist before (new in your changes, or the semantic layer isn't committed yet) says so, and the "now" numbers still show.

## Model changes: set DIFF_BASE_TARGET

The "before" side of a revision compare uses the old *definitions*, but they have to read *some* tables. By default both sides read your active target's tables, so only semantic YAML changes (a metric's filter, expression, measures) can differ, and the panel says so.

To see model SQL changes too, set **DIFF_BASE_TARGET** on the Environment page to a target that holds the code as it was, usually `prod`. The "before" side is then parsed for that target and reads its tables, while "now" reads your dev tables. **Two targets** also defaults to it.

## How it works

- The earlier commit is checked out as a git worktree in wickd's data folder (never inside your repo; `git worktree list` shows it), once per commit, and parsed with `dbt parse` into wickd's data folder. The first compare against a commit takes a few seconds; later ones reuse it. wickd keeps the 3 most recently used per project and removes older ones.
- Packages (`dbt_packages/`) and an untracked `profiles.yml` aren't in git, so they're linked in from your working copy. If `packages.yml` / `dependencies.yml` differ between the two revisions, a note says the earlier side used your installed packages.
- Queries on another target write dbt's artifacts to wickd's data folder, so your project's `target/` keeps pointing at your active target.
- Compare results aren't stored; the numbers are fresh each time.
