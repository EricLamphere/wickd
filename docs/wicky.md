# Wicky — wickd's AI assistant

Wicky is the AI assistant built into wickd (a Pro feature). It answers questions about your dbt
project and your data, explains failures, and writes documentation and tests — which you review
before anything is saved. It runs on your machine by default.

This page explains what Wicky does, exactly what it sees, what it can't do, and the safety and
privacy guarantees built into it. For step-by-step usage, see
[Use Wicky, the AI assistant](how-to/use-ai.md).

## At a glance

| | |
|---|---|
| **Where** | A panel on the right of every project page (⌘I) |
| **Model** | A local open model (Qwen3.5 4B or 9B, Apache-2.0) run by a bundled llama.cpp server — or your own OpenAI-compatible server |
| **Sees** | Your project's compiled manifest, run results, and — only for specific actions — a sample of warehouse data |
| **Writes** | Nothing on its own. File changes are proposals you accept or reject change by change |
| **Runs in the warehouse** | Only read-only `dbt show` queries, and only the ones listed below |
| **Agent?** | No. Every feature is a fixed, single-purpose flow — Wicky never decides on its own to run something or edit a file |

## What Wicky does

### Ask
Chat about the selected node, or about the whole project when nothing is selected (e.g. on the
project homepage). Answers stream in and are grounded in the context described below. Chats are
saved per project and carry on as you move between pages.

### Query data
Switch the chat box to **Query data** and ask about the data itself. Two fixed steps:

1. Wicky writes **one** read-only SQL query (using `{{ ref() }}` / `{{ source() }}`) and a
   one-sentence explanation. Nothing runs yet.
2. You review — and can edit — the SQL, then click **Run**. Results (at most 100 rows) appear in
   a table, and Wicky answers your question from them.

### Refactor
Switch the chat box to **Refactor** (or click **Refactor…** in Quick actions) and describe a
rename or an extraction, e.g. *rename customer_id to customer_key in stg_customers*. Wicky only
works out **which** refactor you mean; it shows it as a card (*Rename column `customer_id` →
`customer_key` in `stg_customers` (3 downstream models)*) for you to confirm. wickd's refactor
engine then prepares every edit deterministically, with no AI involved, and you review them as one
multi-file diff. See [Refactor models and columns](how-to/refactor.md).

### Quick actions (for the selected node)

| Action | What happens |
|---|---|
| **Explain failure** | Shown when the node or one of its tests failed in the latest run. Wicky reads the error, the test's SQL and a few failing rows, then explains what failed, the likely cause and how to fix it. |
| **Document** | Writes the model and column descriptions that are missing (or rewrites all of them, if you choose *Rewrite all*). |
| **Add tests** | Suggests generic tests (`unique`, `not_null`, `accepted_values`, `relationships`), checks each one against the warehouse, and shows which pass today. With a column lineage scan, tests backed by the project's structure come first: `relationships` and `not_null` on join keys, `unique` (or `unique_combination_of_columns` with dbt_utils) on the model's grain, each with its evidence ("joined to `dim_customers.customer_id` in 4 models"). These don't need the AI model. |
| **Refactor…** | Switches the chat to Refactor mode for the selected model. |

Document and Add tests produce a **proposal**: a diff of your schema YAML. In the review window
each change is listed on the left — click it to find it in the diff, then accept or reject it.
The file is written only when every change is decided. Each action stays in the chat history with
its outcome (e.g. *Applied 2 of 3*).

## How Wicky gets its context

Every request is built fresh from your project's **last compiled `target/manifest.json`** (plus
run results stored by wickd). Local models have small context windows, so each feature works to a
budget and puts the most relevant material first. Budgets are approximate (about 4 characters per
token).

### Ask

About 6,000 tokens of context, plus the last ~3,000 tokens of the current chat.

**With a node selected** (≈ ¾ of the budget):

- Name, type, materialization, file path and description
- Documented columns (name, data type, description) — only columns listed in your YAML
- Data tests attached to it
- Its SQL as written (up to 12,000 characters), and the compiled SQL when it differs and fits
- **Latest run results**: the node's status and error message, and each test's status (with the
  message for failing ones)
- Up to 8 direct parents: their descriptions and up to 40 documented columns each (not their SQL)
- Up to 30 direct children, by name

**Project overview** (the remaining ¼, or all of it with nothing selected):

- Warehouse type and node counts
- **Documentation coverage, computed exactly** — how many models have no description or no
  documented columns, with their names (up to 60). Computed up front so it's accurate even on
  large projects.
- A list of models, sources, seeds and snapshots with descriptions (up to 200, then cut to the
  budget — Wicky is told when the list is incomplete)

### Explain failure
About 7,000 tokens: everything above for the node, plus each failing test's compiled SQL (up to
3,000 characters) and **up to 10 failing rows from each of up to 2 failing tests**, fetched by
re-running those tests with `dbt show`.

### Why is it slow (Run History → Performance)
About 8,000 tokens: everything above for the node, plus its performance-relevant config
(materialization, incremental strategy, partitioning/clustering, …), its **last 20 recorded runs**
(when, command, status, duration, rows, bytes, adapter response), its upstream nodes' median
durations, and the **git commits since the oldest of those runs that touched its SQL or schema
YAML** (up to 5, with their diffs, about 6,000 characters) plus any uncommitted edits to them.
Nothing is sent to the warehouse. Outside a git repo the code-change part is just left out.

### Document
About 7,000 tokens of node context, plus the list of columns to describe. Column names come from
the warehouse (`dbt show --limit 1`; only the names are used) or, if the model isn't built, from
your YAML and `catalog.json`. Up to 150 columns per request; with *Fill in missing*, only
columns that have no description are sent.

### Add tests
About 6,000 tokens of node context, plus:

- **A 500-row sample**, summarised per column: null count, distinct count, and the actual values
  when there are 12 or fewer. The summary is sent — not the raw rows.
- The tests that already exist, and the lineage-backed tests already being added (so they aren't repeated)
- The node's parents and grandparents, as the only allowed `relationships` targets
- With column lineage: the columns ranked by how much of the project depends on them (downstream
  columns, models that filter or join on them, exposures, grain), so the important ones come first

Join-key and grain tests are worked out from the column lineage scan, not by the model, and
nothing about them is sent anywhere. Without a downloaded model, Add tests isn't available in
Wicky, but Health → **Test Gaps** proposes the same lineage-backed tests for many models at once.

### Query data
About 6,000 tokens: the selected node's context, then a list of queryable relations — each with
the exact `{{ ref() }}` / `{{ source() }}` to use and its documented columns — nearest to the
selected node first. For the answer step, the question, the SQL and **the result rows (up to
100)** are sent.

### What's never sent

`profiles.yml`, targets, connection details, environment variables and secrets; files other than
what the manifest contains; other projects; anything from previous chats.

## What Wicky can't do

- **Change anything on its own.** It can't edit files, run `dbt run`/`build`/`test`, or run a
  query you haven't approved. There's no agent loop.
- **Edit SQL models with AI.** Quick actions only write schema YAML (descriptions and tests). Any
  SQL in an answer is text for you to copy. Refactors do edit SQL, but the edits come from a
  deterministic engine, not the model, and you review them before anything is written.
- **See the data in Ask.** Only Query data, Add tests and Explain failure touch the warehouse, as
  described above.
- **See unsaved or uncompiled edits.** It reads the last compiled manifest.
- **See columns that aren't in your YAML** when answering questions (Document and Add tests read
  them from the warehouse).
- **Read parents' SQL, or anything beyond direct parents and children** (except relationships
  targets for tests and the relations list for queries).
- **Remember across chats**, browse the internet, or see other projects.

It can also be wrong. Small local models sometimes misread logic or invent detail, especially in
long or multi-part questions — ask one thing at a time. That's why everything that changes a file
goes through review, and every query is shown to you before it runs. The 9B model gives better
results on machines with 16 GB+ of memory.

## Safety

### Files: proposals, never direct writes
- Nothing is written until you accept it in the review window.
- Changes are **spliced into your YAML as new lines in the file's own indentation**. The file is
  never re-serialised, so comments, ordering and formatting are untouched.
- After every edit, the result is **re-parsed and compared** against the original plus exactly
  the intended additions. If anything else would change, the edit is refused.
- When you reject some changes, the file is **rebuilt from the original** with only the accepted
  ones — never by patching the diff text.
- Accepting is **refused if the file changed** since the proposal was made (you edited it,
  switched branches…), so your work is never overwritten.
- Only files inside the project can be written.

### Warehouse: read-only, approved, bounded
Every warehouse interaction is a `dbt show`:

| When | Query | Limit |
|---|---|---|
| Document / Add tests | the model's columns (`select *`) | 1 row, 30 s |
| Add tests | a sample of the model | 500 rows, 60 s |
| Add tests | one query counting each suggested test's failing rows | 60 s |
| Explain failure | the failing tests themselves | 10 rows each, 2 tests, 30 s |
| Query data | the SQL you approved | 100 rows, 120 s |

For Query data, the SQL must pass a check before it runs — when Wicky writes it and again when
you click Run (so edited SQL is checked too):

- **Jinja**: only literal `{{ ref('…') }}` and `{{ source('…', '…') }}`. `{% %}` blocks and any
  other macro are rejected — macros such as `run_query` could execute SQL while dbt compiles.
- **SQL**: parsed with sqlglot in your warehouse's dialect, it must be exactly **one** query
  (SELECT, CTEs and UNION are fine) with no INSERT/UPDATE/DELETE/MERGE, DDL, `SELECT INTO`,
  COPY, GRANT, session (`SET`/`USE`) or transaction statements anywhere in it.

All of these go through wickd's per-project dbt lock, so they never run alongside another dbt
command (a query waits, and says so). A command that times out is stopped, not left running.

### Gating
Wicky requires a Pro license and the Pro package. Without them, its routes refuse every request
(403 / 503) and no model is downloaded.

## Locality and privacy

**By default, nothing leaves your machine.**

- **The model runs locally.** wickd starts llama.cpp's `llama-server` (bundled with the app) on
  `127.0.0.1` on a random port, in offline mode, with its web UI turned off. It starts on first
  use and stops after 10 idle minutes, freeing its memory.
- **The model file** is downloaded once from Hugging Face into wickd's data folder, pinned to an
  exact file and **verified by SHA-256** before it's ever loaded.
- **Your SQL, docs, data samples and query results** go only to that local process.
- **History stays local** in wickd's own database: chats, the SQL Wicky wrote, query results
  (up to 100 rows per query) and proposals. Deleting a chat deletes its messages and stored
  query results.
- **The only network calls** are the one-time model download and the Pro license check (shared
  by all Pro features).

**If you set `WICKD_AI_ENDPOINT_URL`** (to use Ollama, LM Studio or another server), all of the
context described above — including data samples, failing rows and query results — is sent to
that server instead. On your own machine that's still local; if the URL points elsewhere, your
data goes there. Wicky warns you before sending query results to a remote endpoint, and doesn't
answer from them automatically.

## Where the code lives

| | Repo |
|---|---|
| Model runtime, downloads, API, safety checks, YAML editing, review flow, UI | wickd (this repo) — `backend/app/ai/`, `backend/app/api/ai_*.py`, `backend/app/dbt/schema_*.py`, `frontend/src/routes/Project/components/Wicky/` |
| Prompts, context building, output validation | `wickd-pro` (private) — `wickd_pro/ai/` |
| Refactor engine (rename model / column, extract CTE) | `wickd-pro` (private) — `wickd_pro/refactor/`; public side `backend/app/refactor/`, `backend/app/api/refactor.py` |

See [architecture.md](architecture.md) → *Local AI — Wicky* for the technical flow and API routes.
