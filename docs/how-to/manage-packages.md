# Manage dbt packages

The **Environment** page has a **Packages** tab (next to Settings and Variables). It shows your dbt packages, which dbt-core they support, and newer releases on [dbt Hub](https://hub.getdbt.com). You can add, upgrade and remove packages without editing YAML by hand.

## What the table shows

One row per entry in `packages.yml` (or `dependencies.yml`, if that's where your packages are), then the packages installed only as dependencies of other packages.

| Column | Meaning |
|---|---|
| Requested | What the file asks for: an exact version, a range like `>=1.0.0, <2.0.0`, or a git revision |
| Locked | What `package-lock.yml` resolved (dbt 1.7+) |
| Installed | What `dbt deps` put in `dbt_packages/` (or your `packages-install-path`) |
| Latest | The newest stable release on dbt Hub. An arrow means a newer release supports your dbt-core; `dbt` means the newest one needs a different dbt-core |
| dbt X.Y.Z | Whether the installed package's `require-dbt-version` accepts the installed dbt-core |

Click a row for details: its `require-dbt-version`, the folder it's installed as, the newest release for your dbt-core, and notes such as "Not installed: run dbt deps".

Version checks cover dbt Hub packages and git packages pinned to a release tag (such as `revision: 1.1.1` or `v0.9.0`). Git packages on a branch or commit, local packages and tarballs are listed without them.

dbt Hub data is cached for a day. If the Hub can't be reached, the table still lists your packages, and the latest versions show as unknown.

## Add a package

1. Click **Add package**.
2. Search dbt Hub by name and pick a package. Its description and README appear on the right.
3. Pick a version. The newest one that supports your dbt-core is preselected, and incompatible versions are marked.
4. Click **Add package** and review the change to `packages.yml` (a new file is created if there isn't one).

## Upgrade or remove

- Hover a row and click the arrow to upgrade it to the newest release your dbt-core supports, or the bin to remove it.
- **Upgrade all compatible** upgrades every package that has such a release, in one change.

Every edit opens the review window with the diff of your packages file. Nothing is written until you accept it, and comments and formatting elsewhere in the file are kept.

## Install with dbt deps

After you accept a change, a bar offers **Run dbt deps** (with `--upgrade` when versions changed, so the lock file is updated). You can also click **Run dbt deps** at any time. The output goes to the run log (Execution DAG and Project Logs tabs). When it finishes, the tab lists what changed in `package-lock.yml`: packages added, removed or moved to another version.

## Compatibility warnings

wickd warns about packages that don't support your dbt-core in several places:

- **Home page**: a red "N packages" badge on the project's card.
- **Health → Overview**: a Packages card (click it to open Environment → Packages), which fails when an installed package rejects the installed dbt-core and warns when a package isn't installed.
- **Before changing dbt-core**: the setup wizard's version picker, the MetricFlow version dialog, and the "dbt-core drifted" banner list installed packages that wouldn't support the version you're choosing.

Git URLs with credentials (`https://user:token@…` or `{{ env_var(...) }}`) are never shown or logged in full.
