# Screenshots

## MANDATORY: use the `screenshots` skill

Never take README or website screenshots by hand, in a browser, or from the
packaged app. Use the `screenshots` skill. It runs the real desktop shell against
the working tree, so unreleased work appears without packaging anything.

Run it when the user asks for new screenshots, and offer it after a user-facing
UI change that makes a shot in `img/` out of date.

## What a good shot set looks like

`.claude/skills/screenshots/shots.json` is the source of truth.

- **Each README feature appears in exactly one shot.** Pack as many features into
  a shot as read clearly, rather than one feature per image.
- **The one exception is a declared `pair`,** which shows the same feature in a
  different tier or theme, such as `dag_base` and `main_pro`.
- **A feature no still can show goes in `not_shown`, with the reason.**
- **Base features are shot on the Base tier, so the free tier looks real.** Only
  Pro features use a Pro session. The exception is `run_history`, which the user
  wants on Pro so its timeline shows the critical path.
- **Everything visible is demo data.** Never show the user's home path, real
  project, prompt, license key or personal details.

## Keeping it in sync

When a README feature is added, renamed or removed, update `shots.json` in the
same change. `shotctl.py check` and `test_shot_manifest.py` fail until it matches.
This sits alongside [feature-lists.md](./feature-lists.md).

The website's gallery in `lamphere-labs/tools/wickd/gallery/index.html` is generated from
`shots.json` by `shotctl.py publish`. Never edit it by hand.

Never commit or push `lamphere-labs`, and never commit here unless asked.
