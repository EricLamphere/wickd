# Refactor models and columns (wickd Pro)

wickd can make three refactors across your whole project, shown as one diff you review
before anything is written:

- **Rename a model**: its file, every `ref()` to it (models, tests, snapshots,
  analyses, macros, exposures, semantic models, `relationships` tests), its YAML entry
  and unit tests' `model:`.
- **Rename a column**: the model's output column, its YAML entry and tests, downstream
  models that select it, `relationships` tests that point at it, and unit-test rows.
  Downstream models keep their own column names: `c.customer_id` becomes
  `c.customer_key as customer_id`.
- **Extract a CTE into its own model**: the CTE's body becomes a new model file in the
  same folder (with a YAML entry), and the original model selects from
  `{{ ref('new_model') }}` under the CTE's old name.

The edits come from a deterministic engine that works on your SQL as written, Jinja
included. No AI writes them, and formatting and comments stay as they are.

## Start a refactor

From a menu (no AI model needed):

- **Rename a model:** select it in the DAG or Files and click **Rename model…** in the
  side panel.
- **Rename a column:** in **Docs**, open the model's **Columns** tab, hover the column
  and click the wand icon.
- **Extract a CTE:** in **Files**, put the cursor on the CTE's name in the model's SQL,
  right-click and choose **Extract CTE to model…**. Save the file first: the refactor
  works from what's on disk.

Enter the new name. wickd prepares the changes and opens the review window.

From Wicky: switch the chat to **Refactor** (or click **Refactor…** under Quick
actions) and describe it, e.g. *rename customer_id to customer_key*. Wicky shows what it
understood as a card. Click **Prepare refactor** to continue, or **Cancel**.

## Review and apply

The review window lists every file on the left, marked **New**, **Renamed** (with both
paths) or **Deleted** where it isn't a plain edit. Click a file to see its diff.

**Needs manual review** lists what wickd found but didn't change because it couldn't be
sure, for example:

- `select *` passing the column into a model's output, which changes that model's
  output column name too;
- an unqualified column name when another table in the query might have a column with
  that name;
- `using (customer_id)` joins;
- the name inside Jinja, a string literal, a `dbt_project.yml` config key or a docs
  block;
- SQL wickd can't parse, such as `{% if %}` around the select list.

Click an item to jump to its line. Fix these yourself after applying.

**Accept all** writes every file at once. If any file changed since the refactor was
prepared, nothing is written and the window lists those files; start the refactor again.
**Reject all** discards the refactor without writing anything. You can also accept or
reject files one at a time.

## After applying

wickd runs `dbt parse` and shows the result in the chat entry, or in the card at the
bottom right for refactors started from a menu:

- **dbt parse passed**: done. Rebuild the changed models when you're ready.
- **dbt parse failed**: the error is shown. Fix it by hand, or click **Undo**.

**Undo** restores every file the refactor changed: original text back, new files
removed, renames reversed. It only works while none of those files has been edited
since. Otherwise it lists the files that changed and leaves everything as it is.

Renaming a model builds it into a new relation in the warehouse. The old relation
isn't dropped.

## Good to know

- Column lineage helps. With a recent scan, wickd knows other tables' columns and can
  rename more unqualified references safely. Without one, more of them go to manual
  review.
- Only your project's own files change. Installed packages (`dbt_packages/`) are never
  edited.
- A CTE that reads other CTEs of the same model can't be extracted on its own. Extract
  the CTEs it reads first.
- Python models can be renamed, but their columns can't.
