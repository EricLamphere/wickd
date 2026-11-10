# Plans and Research

## Only on the repo owner's machine

Plans are the repo owner's private Obsidian notes. This rule applies only when
`python3 .claude/skills/kanban/kanban.py plans` exits 0. Other contributors should
ignore it — don't create the folder; save plans however you normally would.

## MANDATORY (owner's machine): plans live in the vault, numbered, linked from the board

Whenever you save a plan for future implementation, save research, or finish
implementing a plan, use the `plans` skill.

- Plans: `NN - Title.md` in the vault's `Projects/notes/wickd/plans/` (the path
  `kanban.py plans` prints) — next number = highest number in that folder, plus 1.
  Every plan, implemented or not, stays in that one folder.
- Each plan has a tile on the wickd Kanban titled `[[NN - Title]]`, with bullets
  summarizing it (`kanban.py plan`).
- Research: `../wickd-pro/docs/plans/research/` (scripts and kits stay out of the vault).
- Implemented plans: set the plan's Status line and the README row to Implemented, and
  move its tile to Done.

Never save plans in this repo or in `wickd-pro/docs/plans/` (its old plan files are a
stale copy kept until the user deletes them).
