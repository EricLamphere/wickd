# Use the semantic layer (MetricFlow)

wickd reads your dbt semantic layer (semantic models, metrics and saved queries) and
checks it with [MetricFlow](https://docs.getdbt.com/docs/build/about-metricflow), the
engine behind dbt's semantic layer. This is part of Base (free).

## What wickd needs

- **dbt-core 1.7 or newer.** The latest semantic-layer YAML spec (a `semantic_model:`
  block under a model, metrics under the model) needs **dbt-core 1.12**. Older dbt
  versions can't parse it.
- **A supported adapter** to turn metrics into SQL: DuckDB, Postgres, Snowflake,
  BigQuery, Databricks/Spark, Redshift, Trino or Athena. With any other adapter you can
  still browse and validate the semantic layer, but metrics can't be queried.

wickd doesn't install anything into your dbt environment for this. It runs MetricFlow in
its own small environment (`<data dir>/metricflow-venv`, about 30 MB, no dbt). Building it
the first time needs network access and takes about a minute. The **Health → Semantic
Layer** tab shows the progress. Queries run on your warehouse through your own dbt
(`dbt show`), with your active target.

## See the semantic layer

- **DAG**: semantic models (◇), metrics (∑) and saved queries (⧉) are nodes. They're
  hidden by default; turn them on in the **Type** filter. Opening one from Docs or search
  shows them automatically. The side pane shows a metric's definition, filter and input
  metrics, a semantic model's entities, dimensions and measures, and a saved query's
  metrics and group-bys. **Open in Files** jumps to the YAML that defines it.
- **Docs**: Semantic models, Metrics and Saved queries sections in the project tree, each
  with its definition and what it depends on.
- **Impact**: changing a model now reaches the semantic models, metrics and saved
  queries built on it, and the summary flags how many metrics are affected. **Build
  impacted** leaves semantic nodes out, since dbt has nothing to build for them.
- **Search** (home page and ⌘K) finds metrics, semantic models and saved queries by name.

MetricFlow only sees what dbt last parsed. When you save a YAML file in a project with a
semantic layer, wickd runs a silent `dbt parse` 1.5 seconds later, unless dbt is already
busy.

## Check it (Health → Semantic Layer)

**Run check** runs MetricFlow's validations, the same checks as `mf validate-configs
--skip-dw`, and lists errors and warnings by semantic model, metric and saved query, each
with **Open YAML**. **Check against warehouse** also runs every metric with `LIMIT 0`
through `dbt show`, so broken columns or relations show up too. The Health overview gets a
Semantic Layer card, and the tab shows a badge with the number of issues.

## When your dbt-core can't run MetricFlow

If MetricFlow can't run with the installed dbt-core (for example, the project uses the
latest YAML spec on dbt 1.11), wickd asks you to **pick a compatible dbt-core version or
continue without MetricFlow**. It never changes dbt-core on its own.

The dialog shows:

- **Why**, in one sentence.
- **Compatible versions**: the latest patch of each compatible dbt-core minor, both older
  and newer, with the closest one preselected. **Other version…** takes any published
  release.
- **What will change**: pip's dry run for that version, with the dbt-core, adapter and
  dependency upgrades and downgrades. It needs network access and takes a few seconds.
- **Requirement pins**: if your global requirements file or the project's
  `REQUIREMENTS_PATH` pins dbt-core, the dialog offers to update the pin. Otherwise the
  next setup would reinstall the old version.

**Install dbt-core X** installs through the same stream as Run global setup. Then wickd
runs `dbt --version` and `dbt parse` and checks MetricFlow again. If something fails,
**Revert to <old version>** puts things back. wickd uses one dbt environment for every
project, so the change applies to all of them.

**Continue without MetricFlow** (or Escape) turns MetricFlow off for this project. The
Semantic Layer tab then offers **Enable MetricFlow**.

**Install the mf CLI into my dbt environment…** (at the bottom of the tab) installs
`dbt-metricflow` next to dbt, so you can use `mf` in the terminal. It goes through the
same dialog, because each `dbt-metricflow` release only supports a narrow range of
dbt-core versions.

## Turn MetricFlow on or off

- **Global default**: `WICKD_METRICFLOW_MODE` in Global Settings, `auto` (default) or `off`.
- **Per project**: `METRICFLOW_MODE` in **Environment → Settings → Project**: `auto`,
  `off`, or empty to use the global default.
