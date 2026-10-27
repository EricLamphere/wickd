# How to Use the File Explorer and Editor

The **Files** page provides a file browser for your dbt project with an integrated Monaco editor for editing SQL and YAML files directly in the browser.

## Opening the File Explorer

Click **Files** in the project nav. The left panel shows the project directory tree.

## Browsing files

The file tree shows every file in your dbt project (except `.git`, `dbt_packages`, `logs`, virtualenvs and `__pycache__`). Click a file to open it in the editor; click a folder to expand or collapse it.

- The open file is highlighted, and its folders open automatically when you arrive from a deep link or with back/forward
- Text files open in the editor (including extensionless ones such as `.gitignore`); binary files such as `dev.duckdb` show a "binary file" notice instead
- The tree refreshes on its own when files change on disk (dbt, git, another editor), and when the window regains focus. The header also has **New File**, **New Folder**, **Refresh** and **Collapse all** buttons

## Managing files and folders

The tree works like VS Code's explorer.

**Selecting.** Click selects one item. Cmd/Ctrl+click adds or removes items; Shift+click selects a range. Cmd/Ctrl+A selects everything visible.

**Drag and drop.** Drag files or folders onto a folder to move them there. Dropping on a file drops into that file's folder, and dropping on the empty space below the tree moves to the project root. Hold Alt/Option while dropping to copy instead. Hovering a closed folder while dragging opens it. You can also drag files or whole folders in from Finder/Explorer to add them; if a file already exists you're asked before it's replaced.

**Right-click menu.** New File, New Folder, Reveal in Finder (Explorer on Windows), Cut, Copy, Paste, Duplicate, Copy Path (absolute), Copy Relative Path, Rename and Delete. Right-clicking empty space acts on the project root. When several items are selected, Cut/Copy/Delete apply to all of them.

**Keyboard** (with the tree focused):

| Key | Action |
|-----|--------|
| ↑ / ↓ (Shift to extend) | Move the selection |
| → / ← | Expand / collapse a folder, or go to its first child / parent |
| Space, or Enter on Windows/Linux | Open the file or toggle the folder |
| Enter on macOS, or F2 | Rename inline (the name is selected without its extension) |
| ⌘⌫ / Delete | Delete (with confirmation) |
| ⌘C / ⌘X / ⌘V | Copy / cut / paste into the selected folder (or the selected file's folder) |
| ⌥⌘C / ⌥⇧⌘C | Copy path / copy relative path |
| Esc | Clear the cut and the multi-selection |

New files and folders are named inline in the tree, and a new file opens straight away. Pasting or duplicating where the name is taken adds ` copy` (then ` copy 2`, …), like VS Code. A move that would overwrite something is refused, and nothing moves. If you move or rename the open file, it stays open (unsaved edits included) at its new path.

## Editing a file

Click any `.sql` or `.yml` file to open it in the Monaco editor. The editor supports:
- Syntax highlighting for SQL and YAML
- Auto-indentation
- Find/replace (`Cmd+F` / `Ctrl+F`)
- Multi-cursor editing
- Undo/redo

**To save changes:** Press `Cmd+S` (macOS) or `Ctrl+S` (Windows/Linux). Changes are written to disk immediately.

The file watcher detects saved changes and publishes a `files_changed` event, which may trigger the DAG to re-render if a manifest change follows.

**Extract a CTE into a model (Pro).** In a model's SQL, put the cursor on a CTE's name, right-click and choose **Extract CTE to model…**. Save the file first. See [Refactor models and columns](refactor.md).

## Navigating to the DAG from a file

When a model is open in the editor, the **SidePane** on the right shows the model's DAG metadata:
- Model name, type, materialization, schema
- Upstream dependencies and tags
- Run controls (3×3 grid)

Click **Open in DAG** in the SidePane to navigate to the Models page with that model pre-selected.

Click **Generate docs YAML** to add the model and its warehouse columns to the schema YAML in its folder (see [navigate-dag.md](navigate-dag.md#selecting-a-model) for how the file is chosen).

## Running a model from the File Explorer

With a model open, use the SidePane run grid to execute `dbt run`, `dbt build`, or `dbt test` with upstream/only/downstream selection. This is identical to running from the DAG.

The Run panel at the bottom updates in real time.

## Creating a new model

1. Click **+ New Model** (if available in the header or file tree context).
2. Enter the model name and optional folder path.
3. The model is created as an empty `.sql` file and opened in the editor.

## Deleting a model

1. Select the model in the file tree or open it in the editor.
2. Click **Delete** in the SidePane action buttons.
3. Confirm deletion.

The model file is deleted from disk and removed from the DAG on the next graph refresh.

## The SQL editor modal

Some views (e.g. the SidePane "SQL" action) open the SQL editor in a fullscreen modal for a larger editing surface. This is the same Monaco editor but with more screen space.

## Compiled SQL preview

For models with `{{ ref() }}` and Jinja expressions, you can view the compiled SQL:
- Click **Compile** (or the compiled SQL button) in the SidePane or editor toolbar
- wickd runs `dbt compile` for that specific model and shows the rendered SQL

This is useful for debugging Jinja templating and verifying macro output without running a full build.

## File watcher integration

wickd watches your project directory for changes. If you edit files outside wickd (e.g. in VS Code), the UI updates automatically:
- SQL/YAML changes trigger a `files_changed` event
- Manifest changes (after a compile or run) trigger a `graph_changed` event and re-render the DAG

No manual refresh is needed.
