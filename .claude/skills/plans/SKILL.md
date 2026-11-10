---
name: plans
description: Save, number, and mark implemented wickd implementation plans as notes next to the wickd Kanban board in the repo owner's Obsidian vault, each linked from a board tile; research goes in ../wickd-pro/docs/plans/research. Use when writing a plan for future implementation, saving research notes, or marking a plan as implemented — only on the repo owner's machine (Step 0 checks).
---

## Step 0: Check that this is the owner's machine

```bash
python3 .claude/skills/kanban/kanban.py plans
```

It prints the plans folder and exits 0 only when git's `user.name` is the owner's
**and** the folder exists. On a non-zero exit, stop: this skill and
`.claude/rules/plans.md` don't apply. Save the plan however you normally would, and
don't create the folder or mention the vault.

## Where plans live

Plans are Obsidian notes in the folder Step 0 printed
(`Projects/notes/wickd/plans/` in the vault, next to `wickd Kanban.md`). Never in this
repo, `wickd-pro`, or a scratchpad.

```
<vault>/Projects/notes/wickd/
  wickd Kanban.md               the board; every plan has a tile linking its note
  plans/
    README.md                   roadmap table (every plan + status) and shared conventions
    NN - Title.md               every plan, implemented or not (no subfolders)
```

Research is the exception: it stays in the private repo (see "Saving research").

Vault rules: never run git in the vault, never touch `.obsidian/`, and Read a note
before editing it.

## Creating a new plan

1. **Find the next number.** Implemented plans keep their numbers, so never reuse one:

   ```bash
   ls "$(python3 .claude/skills/kanban/kanban.py plans)" | grep -oE '^[0-9]+' | sort -n | tail -1
   ```

   The new plan is that number + 1, zero-padded to two digits.

2. **Name it `NN - Title.md`**: the number, ` - `, then the feature's title in sentence
   case, e.g. `27 - Variable explorer.md`. Obsidian forbids `\ / :` in file names and
   `# ^ | [ ]` break links, so write `Model governance - groups, access, versions`, not
   `Model governance: groups, …`.

3. **Follow the existing format.** Read the README (shared conventions) and one existing
   plan first. Plans start with `# NN — Title` and a `**Status:** Not started · **Tier:** …`
   line, and are written to be picked up cold by a new session (goal, open decisions to
   confirm with the user, design, steps, tests). Link other plans with wikilinks:
   `[[14 - Metric compare mode|14]]`.

4. **Add a row to the README table** in number order. Escape the alias pipe inside a
   table: `| NN | [[NN - Title\|Title]] (Base) | builds on | Not started |`.

5. **Link it from the Kanban tile.** The tile's title becomes `[[NN - Title]]` and its
   sub-bullets summarize the plan (2–4 bullets; `PRO:` bullets for the Pro tier):

   ```bash
   python3 .claude/skills/kanban/kanban.py plan "<tile>" "NN - Title" --detail "…" --detail "…"
   ```

   The tile leaves Ideas for Features. A tile that already has bullets keeps them
   (`--detail` is ignored); if the plan's scope differs from them, tell the user rather
   than rewriting their bullets. No tile yet? Ask before adding one
   (`kanban.py add Features "[[NN - Title]] #feature" --detail …`).

## Saving research

Research needs the private repo (`test -d ../wickd-pro`). It goes in
`../wickd-pro/docs/plans/research/`, named `<topic>-<YYYY-MM-DD>.md` (e.g.
`metricflow-2026-10-23.md`); a supporting kit (scripts, fixtures) goes in a
`research/<topic>-<kind>/` folder (e.g. `metricflow-bench/`). Plans reference it by path
as code, not a link: `` `wickd-pro/docs/plans/research/metricflow-2026-10-23.md` ``.

## When a plan is implemented

1. Set the plan's own `**Status:**` line to `Implemented (YYYY-MM-DD)` and add an
   "As built" section when the build differed from the design. The note stays where it is.
2. Set its README table row's Status to `Implemented`.
3. Move its tile to Done and tell the user (see `.claude/rules/kanban.md`):

   ```bash
   python3 .claude/skills/kanban/kanban.py done "plan NN"
   ```

Never commit or push in `wickd-pro` (or any repo) — the user does git.
