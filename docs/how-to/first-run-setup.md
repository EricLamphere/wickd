# First-run setup

While wickd's local server is starting, you'll see a **Getting things ready…** screen. The first time wickd starts, a setup wizard walks you through the settings it needs and then installs dbt. Every choice can be changed later in **Global Settings**.

## The steps

1. **Projects folder** (required). wickd scans this folder and its subfolders for `dbt_project.yml` files, and creates new projects here. `~` is expanded. Leave **Create this folder if it doesn't exist** ticked to have wickd create it for you.
2. **Python**: the interpreter dbt's isolated environment is built from. **Auto-detect** (the default) picks the newest of `python3.13`, `python3.12` or `python3.11` it finds. You can also pick any Python 3.11+ install from the list (Homebrew, pyenv, python.org, or anything on your `PATH`).
3. **dbt packages** (optional). This is a global `requirements.txt` to install. It's prefilled with `<projects folder>/requirements.txt` and follows the projects folder until you edit it. If that file doesn't exist, wickd creates it (untick **Create this file if it doesn't exist** to turn that off).

   **dbt-core version.** Unless the file already lists dbt-core (then that line decides, and the step shows it), pick a dbt-core release from the list (newest first, fetched from PyPI; the newest is preselected, and **Always the newest release** leaves it unpinned). A new file starts with `dbt-core==<version>`; an existing file without dbt-core gets that line added at the end. **If you clear the file field**, Run global setup installs the version you picked (saved as `WICKD_DBT_CORE_VERSION` in Global Settings). If PyPI can't be reached, type the version instead. You still need an adapter for your warehouse (e.g. `dbt-duckdb`). Add it to this file, or give each project its own `REQUIREMENTS_PATH` (see [Configure environment](configure-environment.md)).
4. **Default environment variables** (optional): key/value pairs set for global setup's pip install (e.g. `PIP_INDEX_URL` for a private package index) and for every project's dbt and init runs. A project's active profile overrides them, and project env vars override both. Blank rows are ignored. They're managed later under **Global Settings → Profiles → Global Environment Variables** (see [Configure environment](configure-environment.md#global-environment-variables)).
5. **Preferences**: dark or light theme, previewed as you choose.
6. **Review**. **Save & install dbt** checks and saves everything in one go. If something is wrong, such as a path that doesn't exist, a Python that's too old, or an invalid or duplicate variable name, the wizard jumps back to that step and shows the error there.
7. **Install**: runs global setup and streams pip's output. If the install fails, you can **Retry**, or **Continue anyway** and run global setup later from the home page.

## Running it again

Open **Global Settings → Settings → Run setup again**. The wizard opens with your current settings filled in, and you can close it without saving.

If you upgrade from a version without the wizard and already have a projects folder configured, wickd marks setup as done and doesn't show the wizard.

## Global setup without a requirements file

**Run global setup** (home page header) always has something to install. It installs your global requirements file if one is set, otherwise `dbt-core` at the version chosen in setup (`WICKD_DBT_CORE_VERSION` in Global Settings), or the latest if none was chosen.

Only one place decides the dbt-core version: your global requirements file when one is set (then WICKD_DBT_CORE_VERSION is cleared and shown as "Set by your requirements file"), otherwise WICKD_DBT_CORE_VERSION. Changing the dbt-core line in your requirements file takes effect the next time it's installed (Run global setup, or opening a project).

## When the installed dbt-core drifts

Every project shares one dbt installation, and a project's own requirements (`REQUIREMENTS_PATH`) or a newer adapter can change dbt-core while installing. The home page compares the installed dbt-core with what your requirements file asks for (version ranges like `>=1.8,<1.11` are understood) or with the version you chose in setup. If they don't match, a warning says which version is installed and which is expected; **Reinstall dbt-core** runs global setup to put it back. A plain `dbt-core` line with no version never warns.
