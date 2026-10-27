# Inherit docs and trace tagged columns (wickd Pro)

Column lineage knows which upstream column each of your columns comes from, and
whether it was passed through unchanged, renamed, cast, or computed. wickd uses
that to:

- **fill empty column descriptions** from the documented column they came from, and
- **trace tagged columns** (for example `pii`) to every model, column and exposure
  their data reaches.

Nothing is written to your YAML until you review and accept it.

## Before you start

Both features need an up-to-date column lineage scan. If one hasn't been run (or
was run by an older wickd), you'll see **Refresh column lineage** where the
feature would be. Click it and wait for the scan to finish; the project is
compiled first if needed.

## Fill descriptions from lineage

1. Open **Docs** and select the project at the top of the tree. The overview
   shows **Fill descriptions from lineage (N)**, where N is how many empty column
   descriptions can be filled. To do just one model, select it in the DAG or
   Files and use **Inherit descriptions from upstream (N)** in the side panel
   (it only appears when that model has something to fill).
2. Click it. wickd prepares the changes and opens the review window.
3. The review window lists the changed schema files. For each file, the left
   list shows every column it would fill: the description, where it comes from,
   and how (same column, renamed, or cast). Click one to find it in the diff;
   ✓ / ✗ to keep or drop it. Use **Next file** to move on.
4. **Accept file** writes that file; the models in it are recompiled so the docs
   pick up the new descriptions.

What gets filled:

- Only columns with no description yet.
- Only when the column passes through unchanged, renamed, or cast. Computed
  columns (functions, arithmetic, CASE, aggregates) are left alone.
- The description is copied as written in the source YAML, so `{{ doc('…') }}`
  blocks stay doc blocks. Multi-line descriptions are written on one line.
- If a column could get different descriptions from different upstream columns
  (a UNION, a COALESCE of two columns), it's skipped and counted under
  "upstream descriptions disagree".

## Trace where tagged data ends up

1. Tag the sensitive columns in their schema YAML, for example:

   ```yaml
   columns:
     - name: email
       tags: [pii]
   ```

2. Open **Docs → Tags**. Pick a tag on the left. The tags listed come from the
   **PROPAGATE_TAGS** project setting on the Environment page (default
   `pii,sensitive`).
3. The table lists every column the tagged data reaches:
   - **Declared** — the column has the tag in its YAML.
   - **Inherited** — the data reaches it unchanged, renamed or cast.
   - **Derived** — it's computed from tagged data (for example `lower(email)` or
     a hash). Usually still sensitive, but judge each one.

   The **Path** column shows how the data gets there. Below the table, the
   exposures (dashboards, reports, syncs) that depend on any of these models.
4. **Show in DAG** opens the DAG with all these columns selected.
5. **Write inherited tags to YAML** proposes adding the tag to every inherited
   and derived column, reviewed the same way as descriptions.
