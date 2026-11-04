---
name: screenshots
description: Take or refresh wickd's README and website screenshots in the real desktop app, showing the current working tree (unreleased and Pro features included) without packaging, then update the images and gallery on the lamphere-labs site. Use when the user asks for new or updated screenshots, to update the website's screenshots, or to add a shot for a new feature.
argument-hint: "[shot names]  (default: every shot)"
---

# Screenshots

Arguments: `$ARGUMENTS`: shot names from `shots.json`, or empty for all of them.

## How it works

| Piece | What it does |
|-------|--------------|
| Debug Tauri shell (`src-tauri/target/debug/wickd`) | The same Rust and WKWebView as the release app. `WICKD_SHELL_URL` and `WICKD_SHELL_SIZE` attach it to a backend; both are compiled out of release builds |
| Backend on `:8002` | Runs the working tree, with live `../wickd-pro` on `PYTHONPATH` for Pro sessions |
| `data/screenshots/<tier>/` | Fresh copy of the dev database. Base sessions drop `license_state`, so the app is really unlicensed |
| `/Users/Shared/wickd-demo/` | Copies of the demo projects, and the backend's `HOME`. Keeps the username out of shots and the real project untouched |
| `driver.js` | Injected only into a throwaway frontend build. It runs commands inside the webview, because nothing else can automate WKWebView on macOS |
| `screencapture -l` | Captures just that window, with its shadow, even when it's covered |
| 80% page zoom (`WICKD_SHELL_ZOOM`) | Lays the app out as a 2400×1391 window so toolbars don't wrap. macOS caps a real window's height at the display's, so a 1920×1145 window at 80% gives the room while keeping `img/`'s proportions and crisp text |

It runs beside `task start` without touching it and needs no release build. It
doesn't use the mouse, but the window is on screen and takes focus for about half
a second per shot (macOS only draws colored traffic lights on a focused window),
then hands it back. Tell the user, since anything typed in that moment lands in
the shell window.

## 1. Check the shot list

```bash
S=.claude/skills/screenshots/scripts/shotctl.py
python3 $S check
```

Fix any problem in `shots.json` before shooting. Follow
[the rule](../../rules/screenshots.md).

## 2. Take the shots, one session per tier

`up` keeps running, so start it with `run_in_background`, then wait for its
`up: tier=…` line. Only one session can run at a time.

```bash
python3 $S up --tier pro      # background; builds the frontend, seeds, opens the shell
python3 $S prepare            # a fresh build, health checks and lineage
python3 $S run --all          # or: run main_pro test_gaps
python3 $S down
```

Then repeat with `--tier base`. Each `up` reseeds from scratch. Output goes to
`data/screenshots/out/<name>.png`. A failed step leaves `<name>.FAILED.png` showing
what was on screen.

## 3. Look at every image before publishing

`run` succeeding doesn't make a shot good. Read each image, downsized with
`sips --resampleWidth 1200 <in> --out <out>`, and check that:

- the feature it claims is actually visible, with real data and no empty states
- nothing is mid-load, mid-stream, or showing a stale-result warning
- it shows no error caused by the demo rather than the feature
- it shows no personal paths or names, and is the right tier (`Pro` vs `Upgrade to Pro` in the header)
- the traffic lights are colored; if they're grey the window lost focus at that moment, so retake it
- any check result was run by this shot, and describes the demo edit it applied. Stored results are cleared at seeding (`STALE_RESULT_TABLES`), so add a table there if a new feature stores results
- for shots with Wicky, the model's answer is sensible; it varies between runs, so rerun if it isn't

Fix a bad shot by changing its steps, then rerun just that shot.

### The two hero images

The user has approved these exact compositions for the website's two large images.
Keep them when retaking or changing either shot, and check for them in review. Ask
before changing the composition.

**`main_pro` (top of the page, also the README image):**

- DAG page on Pro, side pane collapsed, Wicky open on the right with a Query data question, its SQL, the results and a written answer
- Column lineage loaded, with `customer_id` highlighted and its nodes expanded to show their columns: `raw_customers` (the source) → `stg_customers` → `int_customer_orders` (selected) → `mart_customer_360`
- The selected model has lineage models both upstream and downstream, and every model on the path is lit
- The filter box shows `raw_customers+`, with sources shown and seeds hidden, so the column names are readable; unrelated models stay dimmed for context
- Impact tab open in the bottom pane, in Selection mode with Columns on

**`main_base` (the "Editing, not just browsing" section):**

- Files page on Base, with `mart_customer_360.sql` open and the file tree visible
- Side pane on the **Properties** tab, not Data Preview
- **Node DAG** tab open in the bottom pane

## 4. Publish to the README images and the website

Publish when the user asks to update the screenshots or the website; otherwise show
them the results first. It overwrites tracked images in two repos, and commits nothing.

```bash
python3 $S publish            # or: publish main_pro health
```

This does all of the following:

- copies each shot to `img/`
- writes the site's resized copies to `../lamphere-labs/assets/img/`: `<name>_2560.png` for shots with `site.hero`, otherwise `_1200` and `_2400`
- regenerates the gallery in `tools/wickd/index.html` between the `screenshots:gallery` markers, from each shot's `caption`, `label`, `alt` and `site.gallery`: about 10 `main` shots, then the rest (`more`) behind a "See N more" button, each in `shots.json` order
- updates the alt text on the hero images
- removes resized images nothing on the site refers to, and `img/` files that are neither a current shot nor in the README

Never edit the gallery by hand; change `shots.json` and publish again.

Then finish by hand:

- **Check each `caption` and `alt` against its image.** They must describe what's visible. Don't promise a feature the shot doesn't show.
- **Read the hero sections in `tools/wickd/index.html`** (`main_pro`, `main_base`). Their surrounding copy is hand-written, so it may need to match a changed shot.
- **Update `README.md`** only if `img/main_pro.png` was renamed.
- **Run the site locally** using the command `publish` prints, and tell the user it's ready to check. Open a gallery image to confirm the lightbox works, if you can.

Never commit or push either repo. The user does that, and pushing `lamphere-labs` deploys the site.

## Adding or fixing a shot

Work out steps against a running session, without taking images each time:

```bash
python3 $S goto "/projects/2/models"        # loads the page, prints its buttons
python3 $S js "return shot.outline()"       # any JS; helpers are on `shot`
python3 $S capture draft                    # the window as it is now
```

Add the shot to `shots.json`, listing README feature names exactly. Each shot also needs a `caption` (the lightbox text), `label` (the gallery tile) and `alt`, all describing what's visible, and a `site.gallery` of `main` or `more`. Its position in the file is its position in that part of the gallery. `check` fails above 12 `main` shots; the aim is about 10, and a few of them should show metrics, dashboards and monitors. Steps:

| Step | Example |
|------|---------|
| `goto` | `{ "goto": "/projects/{pid:duckdb_dbt}/health?tab=test-gaps" }`. A full load |
| `click` | `"Run all"`, or `{ "text": "columns", "exact": true, "within": { "sel": "…" }, "nth": 0, "meta": true }` |
| `wait` / `gone` | `{ "wait": "Accept all", "timeout": 120000 }` |
| `type` | `{ "type": { "sel": "input:not([type])", "value": "x", "enter": true } }` |
| `key` | `{ "key": { "name": "k", "meta": true } }` |
| `settle` | `{ "settle": true, "timeout": 60000 }`. Requests, spinners and on-screen text all quiet |
| `sleep`, `api`, `js` | `js` is a function body with `shot` in scope |

Other fields: `storage` presets localStorage (`wickd:wicky-width`,
`wickd:bottom-pane-height`, `wickd:wicky-open`, `wickd:ws-results-width`, and
`wickd:run-history-pane-width`, the detail pane's width, ignored above 1200). Read the hook that uses a key before setting it, since a value outside its range is silently dropped; `pair`, `site.hero`, `theme`.

What has worked:

- **Settle before clicking.** Buttons render before their query is ready, and an early click does nothing. After a demo edit the page can also reload mid-step, so a shot that needs a result should wait for that result and click again if it doesn't appear.
- **Use the app's window events to open panes:** `wickd:open-bottom-tab`, `wickd:open-wicky`, `wickd:start-refactor`.
- **Make a shot's state with a `demo.edits` group,** named in the shot's `edits` field. Each is a set of uncommitted changes, applied before that shot and reverted before any shot that doesn't name it. They power Source Control, contract checks, metric compare and data diff.
- **Edits can replace or remove a file:** `content` writes a whole file, `delete: true` removes one. That's how the SQL Workspace shot gets a good-looking query without touching the real project.
- **Use `demo.seed_edits` for changes every shot needs.** They're committed in the demo copy before the build. For example, a real slow query gives Run Performance a true regression. Never fake results in the database.
- **Wicky's and every other `dbt show` rewrite the manifest, which resets the DAG.** Select DAG columns after those steps.
- **Offer semantic drafts only on materialized models with no semantic model.**
- **For column lineage, check the path in the snapshot first.** Pick a model with both upstream and downstream models for that column, and narrow the DAG with a selector and `fit view` so expanded nodes stay readable. Lineage runs through nodes as the SQL refers to them: `stg_customers` reads the *source* `raw.raw_customers`, which the default Type filter hides, and the seed of the same name stays dimmed. Show sources and hide seeds when that happens.
- **When a shot stops showing a feature, move that feature to a shot that does.** `check` fails until every feature is in exactly one shot, and any site copy describing the old image needs updating too.
- **A check shot must start the check itself.** Don't wait for a results-only button such as "Re-check", because a previous run in the same session already shows it.
- **Demo projects live in `~/Projects/dbt_projects` and are listed in `demo.projects`:** `duckdb_dbt` (the failing test is intentional) and `marketing_dbt` (small, so combined docs has a second project).
- **Features not yet in the README go in `upcoming`.** Remove them once the README lists them.

Run the tests after changing the scripts:

```bash
backend/.venv/bin/python -m pytest .claude/skills/screenshots/scripts/test_shot_manifest.py -q --no-cov -p no:cacheprovider
```

## Troubleshooting

- **`port … is in use`:** another session is running; use `shotctl down`. If it died, close the stray `target/debug/wickd` window and backend on `:8002`.
- **`screencapture wrote nothing`:** the terminal needs Screen Recording in System Settings → Privacy & Security.
- **Pro shows as locked:** the session copies `license_state` from `data/wickd.sqlite`, so the dev app must be activated.
- **Fonts look wrong:** Inter loads from Google Fonts, so shots need network access.
- **`demo edit no longer applies`:** the source project changed; update `demo.edits`.
