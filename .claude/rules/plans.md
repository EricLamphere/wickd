# Plans and Research

## Only if wickd-pro is checked out

This rule applies only when `../wickd-pro` exists (`test -d ../wickd-pro`).
Contributors without the private repo should ignore it — don't create the
directory; save plans however you normally would.

## MANDATORY (when wickd-pro exists): plans live in wickd-pro, numbered

Whenever you save a plan for future implementation, save research, or finish
implementing a plan, use the `plans` skill.

- Plans: `../wickd-pro/docs/plans/NN-feature-descriptor.md` — next number = highest
  number across `plans/` **and** `plans/implemented/`, plus 1.
- Research: `../wickd-pro/docs/plans/research/`.
- Implemented plans: move to `../wickd-pro/docs/plans/implemented/` (same name), and
  update the plans README table and any links.

When wickd-pro exists, never save plans in this repo.
