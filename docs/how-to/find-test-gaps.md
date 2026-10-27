# Find and fill test gaps (Pro)

wickd Pro reads your models' SQL to find the columns that most need a test:

- **Join keys**: columns other models join on. A null key silently drops rows from an inner
  join, and a key with no match upstream points at missing data.
- **Grain**: the columns a model is unique on: its `GROUP BY`, `SELECT DISTINCT`, or a
  `row_number() over (partition by …) = 1` dedupe.

Each column is ranked by how much of the project depends on it: downstream columns built from it,
models that filter or join on it, exposures it reaches, and whether it's part of the grain.

## Before you start

Test gaps come from the column lineage scan. If the tab says column lineage is missing or needs a
refresh, click **Refresh column lineage** (scans from before this feature don't record join keys
and grain). The project needs a compiled `manifest.json`.

No AI model is needed.

## See the gaps

The **Health** overview has a Test Gaps card with the number of gaps and the top three; click
it to open the full list, or use **Refresh lineage** on the card to re-scan.

1. Open **Health → Test Gaps**.
2. Each row is a column, or a group of columns for a model-level test, with:
   - **Suggested tests**: `not_null`, `unique`, `relationships → model.column`, or
     `unique_combination_of_columns` (offered only when `dbt_utils` is installed).
   - **Used by**: what depends on it.
   - **Evidence**: why the test was suggested, e.g. "joined to `dim_customers.customer_id` in
     4 models" or "one row per `order_id` (deduplicated)".
3. Click a row to see all of its evidence and the models that join on the column; ⌘-click a model name
   to open it in Files. Columns sort by clicking their headers (Risk is the default).
4. Use **Show 50 / 100 / 200 / 500** to see more. Columns that already have the test are left out.

`relationships` is suggested only from the many side of a join to a column known to be unique (the
other model's single-column grain, or an existing `unique` test). When neither side is known to be
unique, only `not_null` is suggested.

## Ignore a gap

If a suggestion doesn't fit (say a column is nullable on purpose), hover the row and click its
**Ignore** button (or tick several rows and use **Ignore** in the selection bar). It disappears from **Gaps** and from the count, and stays hidden even as the
ranking changes. Ignoring hides every suggested test for that column (or column combination).

The **Ignored** tab lists everything you've ignored, with what would be suggested now and whether it's
still a gap. Use a row's **Unignore** button, or tick several and click **Unignore**, to bring them back.

## Refresh

**Refresh** (top right) re-traces column lineage and re-ranks. Use it after changing a model's joins
or GROUP BY. Tests you add drop off the list on their own once dbt rewrites the manifest (accepting a
proposal in wickd compiles the models for you).

## Add the tests

1. Narrow the list with the search box or the **Test** dropdown, then tick the rows you want (the
   header checkbox selects all; Shift-click selects a range). To add one row's tests, hover it and
   click its flask button instead.
2. Click **Generate tests** in the selection bar. wickd checks each test against your warehouse, one model
   at a time, so you can see which pass today.
3. Review the change in the review window: one file per schema YAML, each test with its evidence and
   ✓ passes / ✗ N failing. Accept or reject tests one by one, per file, or all at once.

Nothing is written until you accept.

## From Wicky

**Add tests** in Wicky uses the same evidence for one model: lineage-backed tests come first, then
the AI model suggests the rest (such as `accepted_values`), with the important columns listed first.
