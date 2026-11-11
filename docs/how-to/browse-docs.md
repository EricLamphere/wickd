# Browse project docs and Markdown pages

The **Docs** page shows your project's dbt documentation (models, sources, macros, columns, lineage) next to your team's own Markdown pages: onboarding guides, conventions, runbooks.

## Browse dbt docs

Open **Docs** in the project nav. If docs haven't been generated yet, wickd generates them; the refresh button in the panel header regenerates them.

The **Documentation** panel has tabs for browsing:

| Tab | Shows |
|---|---|
| **Project** | The project overview, then nodes grouped by resource type and folder |
| **Database** | Nodes grouped by database and schema |
| **Group** | Nodes grouped by dbt group |
| **Tags** | Tagged columns and where they flow (lineage propagation) |
| **Pages** | Markdown pages from the project's docs folder (see below) |

When the panel is narrow, only the selected tab shows its label; hovering another tab's icon slides its label open until you move away. The filter box narrows the current tree.

## Markdown pages

Put Markdown files (`.md` or `.markdown`) in a `docs/` folder and they appear in the **Pages** tab as a folder tree. Each page's title is its first `# ` heading (or the file name). `README.md` and `index.md` come first in their folder.

### Which folder

wickd looks in this order:

1. the folder set in the **DOCS_PATH** project setting (Environment → Settings → Project), relative to the dbt project. It may point elsewhere in the git repo, e.g. `../docs`;
2. the dbt project's `docs/` folder;
3. the git repo root's `docs/` folder (common when the dbt project is a subfolder of a monorepo).

The **Pages** tab is hidden when none of these exist. Files and folders starting with `.` or `_` are skipped.

### What renders

Pages render as GitHub-flavored Markdown:

- tables, task lists, strikethrough and autolinked URLs;
- images relative to the page (`![diagram](img/flow.png)`): PNG, JPEG, GIF, SVG and WebP from inside the docs folder;
- fenced code blocks with a language (` ```sql `, ` ```yaml `, ` ```bash `, ` ```python `, …) highlighted with the same colors as wickd's editors; ` ```jinja ` reads as SQL, and blocks without a language stay plain;
- ` ```mermaid ` code blocks, drawn as diagrams;
- headings with anchors, plus an **On this page** outline on wide windows.

Raw HTML isn't rendered.

### Links

| Write | Goes to |
|---|---|
| `[Setup](guides/setup.md)` or `[Setup](../setup.md#install)` | another page (and section), inside wickd |
| `[Naming](#naming)` | a section on the same page |
| `[orders](ref:orders)` or `[orders](ref:my_package.orders)` | the model's docs |
| `[raw orders](source:raw.orders)` | the source's docs |
| `` `ref('orders')` `` in inline code | the model's docs, when the model exists |
| `https://…` | your browser |

A `ref:` / `source:` link that doesn't match a node renders as plain text with a dotted underline; hover it to see "not in the manifest". Node links need generated docs. On the project home page they resolve once Docs has been opened in the session.

### dbt docs blocks

dbt reads `{% docs name %}…{% enddocs %}` blocks from `.md` files. A file that holds **only** docs blocks is a dbt docs file: its blocks already show on the nodes that use them, so it isn't listed as a page. In a page that mixes Markdown and docs blocks, each block shows as a labeled callout (**docs block `name`**) with links to the nodes whose descriptions use it.

### Editing

**Edit** in a page's header opens the file in **Files** (only for docs folders inside the dbt project). Saving there, or editing the file anywhere else, updates the rendered page right away.

## READMEs

The project's `README.md` (on the project home page and in the Docs project overview) uses the same renderer: tables, task lists, mermaid, images relative to the project, and links to `docs/…` pages open them in the **Pages** tab. Links to other project files open them in **Files**.
