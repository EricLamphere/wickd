---
name: kanban
description: Read and update the wickd Kanban board in the user's Obsidian notes (features, ideas, issues, done). Use when the user asks what's on the board or what to work on next, to plan or implement a feature or fix an issue from the board, to add a tile, or after finishing work that matches a tile so it can be moved to Done — only on the repo owner's machine (Step 0 checks); other contributors must not use it.
---

## Step 0: Check that this is the owner's machine

```bash
python3 .claude/skills/kanban/kanban.py path
```

This board is the repo owner's private note. The check passes only when git's
`user.name` here is the owner's **and** the note exists. On a non-zero exit, stop:
this skill and `.claude/rules/kanban.md` don't apply to this developer. Don't
mention the board, don't work around the check (no `WICKD_KANBAN`, no editing
`OWNER`), and never create the note.

## The board

`Projects/notes/wickd/wickd Kanban.md` in the Obsidian vault, an Obsidian Kanban plugin
board. Columns (`## ` headings):

| Column | Holds |
|--------|-------|
| Ideas | half-formed feature thoughts, often a single line |
| Features | thought-out features; sub-bullets (`\t* `) are the scope, `PRO:` bullets are the Pro tier |
| Issues | bugs and UX problems |
| Done | completed features and fixed issues, newest first under `**Complete**` |

Tags: `#feature`, `#issue`, `#pro` (whole tile is Pro). A tile titled
`[[NN - Title]]` links its plan note, `plans/NN - Title.md` next to the board (the
`plans` skill); its bullets summarize the plan. (Old tiles may still say `(plan NN)`.)
Done tiles end with `✅ YYYY-MM-DD` (older ones use `@{YYYY-MM-DD}`).

Leave everything outside the cards alone, especially the `%% kanban:settings`
block at the bottom. Never run git in the vault.

## Always edit through the script

`kanban.py` keeps a tile's details with it and preserves the rest of the file
byte for byte. Edit the note by hand only for something it can't do (e.g.
rewording a tile's details), and Read the note first.

```bash
K=.claude/skills/kanban/kanban.py
python3 $K list [Ideas|Features|Issues|Done]   # titles + detail counts
python3 $K show "plan 19"                      # the tile linking [[19 - ...]]
python3 $K done "Selector support"             # tick, add ✅ today, move to top of Done
python3 $K move "Notes" Features               # Ideas -> Features, etc.
python3 $K plan "Variable explorer" "27 - Variable explorer" --detail "…"
                                               # title -> [[27 - Variable explorer]]; Ideas -> Features
python3 $K plans                               # print the plan notes folder
python3 $K add Issues "Short title #issue" --detail "repro / context"
```

A query is a case-insensitive substring of the title, or `plan NN` (matches
`[[NN - ` or a legacy `(plan NN)`). An ambiguous
query is refused with the matches listed: retry with a longer substring.
`done`/`move`/`plan` ignore tiles already in Done.

## Workflows

### "What's on the board / what should I work on?"

`list` the Features, Ideas and Issues columns and summarize. Point out tiles that
already have a plan (ready to implement) vs. ones that need one.

### Plan a tile

1. `show` the tile; its title and sub-bullets are the starting scope. Ideas are
   thin: ask the user the open questions before writing (one round, the ones
   that change the design).
2. Write the plan with the `plans` skill (numbering, format, README row).
3. `python3 $K plan "<tile>" "NN - Title" --detail …` so the tile links its plan note,
   with bullets summarizing it (and leaves Ideas).
4. If the plan's scope differs from the tile's bullets, tell the user rather than
   rewriting their bullets.

### Implement a tile

1. `show` the tile. If it links a plan note (`[[NN - Title]]`), read that note and the
   plans README in the folder `$K plans` prints, and implement it; if
   not, the tile's bullets are the spec (small tiles), or offer to plan first if
   it's large or ambiguous.
2. Build it following the repo's normal workflow (tests, docs, feature lists).
3. When it's done and verified, `done` the tile and tell the user (see the rule
   in `.claude/rules/kanban.md`). If a plan was implemented, also mark it implemented
   with the `plans` skill.

### Found a bug or idea mid-task

Only add a tile when the user asks (`add Issues "... #issue"` or
`add Ideas "... #feature"`). Otherwise mention it in your reply.
