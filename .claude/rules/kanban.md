# Kanban Board

## Only on the repo owner's machine

The board is the repo owner's private Obsidian note. This rule applies only when
`python3 .claude/skills/kanban/kanban.py path` exits 0, which requires git's
`user.name` to be the owner's and the note to exist. For any other developer,
ignore this rule and the `kanban` skill entirely: don't mention the board or try
to work around the check.

## MANDATORY: move finished tiles to Done, and say so

The user tracks wickd features and issues on an Obsidian Kanban board (see the
`kanban` skill). When you finish implementing a feature or fixing an issue that
**directly** corresponds to a tile:

1. Run `python3 .claude/skills/kanban/kanban.py done "<tile>"` (moves it to the
   top of Done with today's date).
2. Tell the user in your final message, e.g. "Moved **Selector support** to Done
   on the wickd Kanban."

"Directly" means the work is what the tile describes: the tile's scope (or its
plan's) is delivered, verified (tests pass, the change works). Don't move a tile when:

- only part of its bullets shipped: leave it, and tell the user which bullets
  remain;
- the link is a guess: ask instead ("This looks like the *X* tile; move it to Done?");
- the work is unfinished, untested, or the user is still iterating on it.

Implementing a numbered plan counts: the tile linking that plan note (`[[NN - Title]]`,
found with `kanban.py show "plan NN"`) moves to Done alongside marking the plan
implemented (`plans` skill).

## Using the board as a source of work

When the user asks what to build next, to plan an idea, or to implement a tile
("plan the variable explorer", "implement the running-status bubble"), read the
board with the `kanban` skill and follow its Plan / Implement workflows. A new
plan for a tile retitles it `[[NN - Title]]`, linking the plan note (`plans` skill).

Don't add, reword or delete tiles unless asked; moving to Done (above) and
linking a plan note are the only edits made without asking.
