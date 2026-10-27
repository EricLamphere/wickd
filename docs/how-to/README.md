# How-To Guides

Step-by-step guides for using wickd.

| Guide | What it covers |
|---|---|
| [First-run setup](first-run-setup.md) | The setup wizard: projects folder, Python, dbt packages, preferences, and installing dbt |
| [Create a project](create-project.md) | Run `dbt init` interactively, set up profiles.yml, and open your first project |
| [Run, build, and test models](run-models.md) | Select models in the DAG, execute runs, and read output from the Run panel |
| [Configure environment and targets](configure-environment.md) | Set env vars, switch dbt targets, manage profiles, and install requirements |
| [Customize the init pipeline](init-pipeline.md) | Add, reorder, and link init steps; capture env vars from custom shell scripts |
| [Navigate and filter the DAG](navigate-dag.md) | Use the DAG view, filter bar (selectors and dropdowns), and the side panel |
| [Use the file explorer and editor](use-file-explorer.md) | Browse files, edit SQL/YAML with Monaco, and navigate between files and the DAG |
| [Use the integrated terminal](use-terminal.md) | Open terminal sessions, manage multiple tabs, and use the terminal during development |
| [Use source control (Git)](use-git.md) | Stage, commit, push/pull, switch branches, and view diffs in the built-in SCM panel |
| [Use the SQL workspace](use-sql-workspace.md) | Write and run ad-hoc SQL queries, inspect compiled SQL, and manage workspace files |
| [View run history](view-run-history.md) | Browse past invocations, inspect per-node timings and logs, and track execution trends |
| [Analyze run performance](analyze-run-performance.md) | Run timeline per thread, DAG durations overlay, and (Pro) critical path, regressions and recommendations |
| [Inherit docs and trace tagged columns (Pro)](inherit-docs-and-trace-tags.md) | Fill empty column descriptions from upstream columns, and follow tagged (e.g. `pii`) columns to every model and exposure they reach |
| [Refactor models and columns (Pro)](refactor.md) | Rename a model or a column across the project, or extract a CTE into its own model; review every edit, then apply, check with dbt parse, and undo |
| [Use Wicky, the AI assistant (Pro)](use-ai.md) | Download a local model, generate model/column docs and review them as a diff, and ask questions about your project |
| [Use the AI assistant (Pro)](use-ai.md) | Download a local model, generate model/column docs and review them as a diff, and ask questions about your project |
