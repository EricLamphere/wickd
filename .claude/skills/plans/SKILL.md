---
name: plans
description: Save, number, and archive wickd implementation plans and research in ../wickd-pro/docs/plans. Use when writing a plan for future implementation, saving research notes, or marking a plan as implemented — only if the ../wickd-pro checkout exists.
---

## Step 0: Check that wickd-pro exists

```bash
test -d ../wickd-pro && echo present || echo missing
```

If it's **missing**, stop: this skill doesn't apply. Don't create `../wickd-pro`
or any of its folders — save the plan however you normally would.

## Where plans live

When it's present, all wickd plans and plan research live in the private `wickd-pro` repo (sibling
checkout at `../wickd-pro`), never in this repo — not in `docs/`, not in
`.claude/`, not in a scratchpad.

```
../wickd-pro/docs/plans/
  README.md             roadmap index (table of every plan + status) and shared conventions
  NN-feature-name.md    plans not yet implemented
  research/             research backing a plan (notes, benchmarks, kits)
  implemented/          plans that have shipped
```

## Creating a new plan

1. **Find the next number.** Search *both* `plans/` and `plans/implemented/` —
   implemented plans keep their numbers, so never reuse one:

   ```bash
   ls ../wickd-pro/docs/plans ../wickd-pro/docs/plans/implemented 2>/dev/null \
     | grep -oE '^[0-9]+' | sort -n | tail -1
   ```

   The new plan is that number + 1 (start at `01` if there is none).

2. **Name it `NN-feature-descriptor.md`**: zero-padded to two digits, then a short
   lowercase kebab-case descriptor, e.g. `07-semantic-layer-foundation.md`,
   `12-run-cost-tracking.md`.

3. **Follow the existing format** — read `README.md` (shared conventions) and one
   existing plan first. Plans start with `# NN — Title` and a
   `**Status:** Not started · **Tier:** …` line, and are written to be picked up
   cold by a new session (goal, open decisions to confirm with the user, design,
   steps, tests).

4. **Add a row to the README table** (`| NN | [Title](NN-feature-descriptor.md) | builds on | Not started |`),
   in number order.

## Saving research

Research goes in `../wickd-pro/docs/plans/research/`, named
`<topic>-<YYYY-MM-DD>.md` (e.g. `metricflow-2026-10-23.md`); a supporting kit
(scripts, fixtures) goes in a `research/<topic>-<kind>/` folder (e.g.
`metricflow-bench/`). Link the research from the plan(s) it backs.

## When a plan is implemented

1. `mkdir -p ../wickd-pro/docs/plans/implemented` and `mv` the plan there, keeping
   its file name and number.
2. Set the plan's own `**Status:**` line to `Implemented (YYYY-MM-DD)`.
3. Fix links broken by the move:
   - README table row → `implemented/NN-feature-descriptor.md`, Status → `Implemented`.
   - Links *inside* the moved plan gain a `../` (e.g. `research/x.md` → `../research/x.md`,
     a sibling `08-foo.md` → `../08-foo.md`, or `08-foo.md` if that plan is also
     implemented).
   - Other plans linking to it: `grep -rn "NN-feature-descriptor" ../wickd-pro/docs`
     and update the paths.

Never commit or push in `wickd-pro` (or any repo) — the user does git.
