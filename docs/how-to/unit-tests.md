# Write and debug unit tests

dbt 1.8+ [unit tests](https://docs.getdbt.com/docs/build/unit-tests) check a model's
logic on fixed input rows: given these rows in `stg_orders`, the model should produce
these rows. wickd shows their results next to the model, explains failures row by row,
and (with Pro) drafts new ones from your real data.

## See unit test results

Select a model in the DAG or Files. The side pane's **Unit tests** section lists the
model's unit tests with the status of their last run:

- **Run all** runs `dbt test --select <model>,test_type:unit`; the ▶ on a row runs that
  test alone. Results land in the Run panel and on the Runs page like any other test.
- Click a test to see its inputs (`given`), how many rows it expects, and whether it
  uses `overrides`. The file icon opens the YAML that defines it.
- In the DAG, turn on the test coverage overlay to see a **UT n** badge on each model
  with unit tests (red, with the failing count, when one failed).
- The Runs page counts unit tests separately and can filter to them.

## Understand a failure

A failed unit test opens on the table dbt printed: the rows the test expected next to
the rows the model produced.

- A changed cell reads `expected → actual`.
- **+ actual** rows were produced but not expected; **− expected** rows were expected but
  missing.
- dbt leaves unchanged rows out of long tables; the header says so ("unchanged rows
  hidden").

Then decide which side is wrong:

- **The model is wrong**: open it (Open in Files) and fix the SQL, then Run all again.
- **The test is out of date**: click **Accept actual as expected…**. wickd proposes the
  test's YAML with `expect.rows` replaced by what the model produced (the rows dbt hid
  are unchanged, so they're kept), shown as a diff with the old and new rows as tables.
  Accepting writes the file and runs the test again. This works for `format: dict`
  expectations; csv or fixture-file expectations need editing by hand.

## Generate a unit test (Pro)

**Add unit test…** in the side pane (or Wicky's quick actions on a model) opens the
unit test options:

- **Logic to cover**: the whole model, one of its CTEs, or a CASE column. In Files,
  select some SQL and right-click **Unit test this logic…**; wickd preselects the CASE
  column or CTE your selection is about, or else the CTE it sits inside.
- **Mask text values**: see [Sampled rows and your repo](#sampled-rows-and-your-repo).
- **Write to**: by default the test goes next to the model's other unit tests, or into
  its schema YAML. You can pick a file that already has this model's unit tests, or
  choose **Another file…**: **Existing file** lists every YAML file in your model folders
  (type to filter, click one), and **New file** takes a name. A bare name like
  `orders_checks` goes in the model's folder as `orders_checks.yml`; the panel says
  whether it adds to an existing file or creates one. The file has to be inside your model paths (usually `models/`), or dbt wouldn't
  read it. wickd remembers the choice per model and offers it again next time.

Then wickd, in the background:

1. Compiles the model and reads each input's columns and types from the warehouse.
2. Picks up to 5 real rows per input that exercise the logic: one row for each simple
   condition (a `CASE WHEN`, a `WHERE`, a join condition), a row with a NULL in a column
   that filters rows, a row whose join key has no match on the other side, and a couple
   of plain rows. Joined tables are sampled for the keys already picked, so the
   fixtures actually join. Only the columns the model reads are kept.
3. Runs the model's SQL once over just those rows, with every other column NULL, which
   is what dbt does with a unit test's `given` rows. Its output becomes `expect:`.
4. Proposes the `unit_tests:` entry for review.

All the queries are read-only `dbt show` queries. No AI model is needed.

Review it like any other proposal. The window shows the rows given to each input and
the rows expected as tables above the YAML diff. **The expected rows are what the model
produces today, not proof that it's right.** Check them: a unit test that locks in a
bug will keep passing. Accepting writes the YAML and runs the new test.

Columns built from the current date or time, or from random values (`current_date`,
`now()`, `random()`), are left out of `expect:` with a note: their value would change
the next day and the test would fail. If the model filters or joins on the current
date, wickd warns you that the test may need updating as dates move.

### What can't be generated

wickd says why instead of proposing something wrong:

- ephemeral models, and models with ephemeral inputs (their fixtures must be written as
  `format: sql`)
- models that read their own table (`{{ this }}`)
- projects on dbt older than 1.8
- inputs that aren't built in the warehouse yet

Incremental models get a test for the full-refresh run (`is_incremental()` false), which
is what dbt runs by default. Add `overrides: {macros: {is_incremental: true}}` and a
`this` input by hand for the incremental run. Models that read hard-coded tables (not
refs or sources) get a note, because the test will query those tables live.

### Sampled rows and your repo

The fixture rows come from your warehouse and get committed with the test. If they could
hold personal data, tick **Mask text values**. Text is replaced with stable fakes
(`text_1a2b3c4d`), and the same value always becomes the same fake, so join keys still
match. Dates, numbers and values the SQL compares against (like `status = 'returned'`)
are kept, so the test still hits the same branches. The expected rows are computed from
the masked fixtures.
