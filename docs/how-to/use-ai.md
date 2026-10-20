# Use Wicky, the AI assistant (Pro)

Wicky is wickd's AI assistant. It runs on your machine, so your SQL, docs and questions never leave it. It answers questions about your project and your data, explains failures, and writes model and column descriptions and tests, which you review before anything is saved.

For what Wicky sees, what it can't do, and its safety and privacy guarantees, see [How Wicky works](../wicky.md).

## Open Wicky

Wicky is the panel on the far right of every project page. Click the ✨ **Wicky** strip or press **⌘I** to open or close it; drag its left edge to resize. It remembers whether it was open.

Wicky follows what you have selected: pick a node in the DAG, open a model's file, or select a changed file in Source Control, and that node becomes the context (shown in Wicky's header). With nothing selected, as on the project homepage, it answers about the project as a whole.

## Set it up

1. Without a Pro license, Wicky shows **Unlock Wicky**. Enter your license key there.
2. Pick a model and click **Download** (once, a few GB):
   - **Qwen3.5 4B**: fast, fine on machines with 8 GB+ of memory.
   - **Qwen3.5 9B**: better results, needs 16 GB+.

   Downloads can be cancelled and resumed. The model loads the first time you use Wicky (a few seconds) and unloads after 10 idle minutes.

**Already run Ollama or LM Studio?** In Global Settings set `WICKD_AI_ENDPOINT_URL` (e.g. `http://localhost:11434`) and `WICKD_AI_ENDPOINT_MODEL` (e.g. `qwen3:8b`). Wicky then uses that server instead of downloading a model. Clear the URL to go back.

## Document a model

1. Select a model, seed or snapshot and open Wicky.
2. Under **Quick actions**, click **Document**, then choose **Fill in missing** (only the model and columns without a description) or **Rewrite all** (replace existing descriptions too).
3. Watch the descriptions being written in the chat. When they're done (usually under a minute), click **Review** in that message to see a side-by-side diff of the schema YAML.
4. Accept or reject each description from the list on the left (click one to jump to it in the diff), or use **Accept all**. The file is written once everything is decided, and the model recompiles so docs update. **Reject** discards it. With several files, use **Next file**.

Wicky reads the model's real columns from the warehouse when it's built, and otherwise uses the columns your project already knows about. With **Fill in missing**, Wicky only writes descriptions for columns that don't have one yet; if everything is already described, it says so straight away. If the YAML file changed after the docs were generated, accepting is refused so your edits aren't lost; generate again.

## Add tests

1. Select a model, seed or snapshot and click **Add tests** under **Quick actions**.
2. Wicky samples the model's data, picks tests (`unique`, `not_null`, `accepted_values` using the values it saw, `relationships` to upstream models), skips tests you already have, and runs each one against the warehouse.
3. In the chat, each suggestion shows why it was chosen and whether it **passes** today or has **failing rows**. A failing suggestion can still be worth adding: it found a data problem.
4. Click **Review** to see the schema YAML diff. The changes are listed on the left: click one to jump to it in the diff, then ✓ accept or ✗ reject it (rejecting removes it from the diff; ↺ undoes). Once every change is decided, the file is written with the ones you accepted. **Accept all** / **Reject all** decide everything at once.

The model must be built for sampling and checking; otherwise Wicky suggests tests from the SQL alone and marks them unchecked.

## Explain a failure

When the selected model, or one of its tests, failed in the latest run, **Explain failure** appears under **Quick actions**. Wicky reads the error, the test's SQL and a few of the failing rows, then answers with what failed, the likely cause and how to fix it. Everyday questions also see the latest run results, so you can ask "is this model healthy?".

## Query your data

Switch the chat box from **Ask** to **Query data**, then ask a question about the data itself ("What is total revenue per month?").

1. Wicky writes one read-only SQL query (using `{{ ref() }}`) and explains it. **Nothing runs yet.**
2. Review the SQL — edit it if you like — and click **Run**. It runs with `dbt show` against your active target, returning at most 100 rows. If another dbt command is running, it waits for it first.
3. The rows appear in a table. With the bundled model, Wicky then answers your question from them automatically; with a remote endpoint, click **Answer from results** (the rows are sent to that server).

Only single `SELECT` queries can run: wickd checks the SQL and refuses anything that writes, changes settings or uses Jinja other than `ref()` / `source()`. Small models do best with one question at a time.

## Ask questions

Type in the box at the bottom of Wicky. The selected node's SQL, columns, tests and upstream docs (or a project overview) are sent as context. Wicky can't query your warehouse.

Chats are saved per project and carry on as you move between pages. Quick actions are part of the chat too: each one stays in the conversation with what Wicky wrote and whether you applied (all, or some — skipped items are struck through), rejected or discarded it. Use **+** for a new chat, the dropdown to reopen an old one, and the trash icon to delete it. Enter sends; Shift+Enter adds a new line.
