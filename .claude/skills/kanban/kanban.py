#!/usr/bin/env python3
"""Read and edit the wickd Kanban board (Obsidian Kanban plugin markdown).

Usage:
  kanban.py path                          print the board's path; exit 1 unless the
                                          board exists and this is the owner's checkout
  kanban.py list [COLUMN]                 list cards (all columns, or one)
  kanban.py show QUERY                    print a card with its details
  kanban.py done QUERY [--date YYYY-MM-DD]  tick a card and move it to the top of Done
  kanban.py move QUERY COLUMN             move a card to the end of another column
  kanban.py plan QUERY NN                 add "(plan NN)" to a card; Ideas -> Features
  kanban.py add COLUMN TEXT [--detail D]...  add a card (TEXT includes its tags)

QUERY is a case-insensitive substring of the card's title, or "plan NN" to match
"(plan NN)" exactly. done/move/plan skip cards already in Done. A query matching
more than one card is refused and the matches are listed.

Set WICKD_KANBAN to override the board's path.

The board is the maintainer's private Obsidian note. Every command refuses to
run unless git's user.name in this repo is the owner's (OWNER below), so other
contributors never read or write it.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

DEFAULT_PATH = (
    Path.home()
    / "Library/Mobile Documents/iCloud~md~obsidian/Documents/notes"
    / "Projects/notes/wickd Kanban.md"
)
OWNER = "EricLamphere"  # git config user.name of the board's owner
CARD_RE = re.compile(r"^- \[( |x)\] (.*)$")
PLAN_QUERY_RE = re.compile(r"^plan\s+(\d+)$", re.IGNORECASE)
DONE = "Done"
DONE_ANCHOR = "**Complete**"
SETTINGS_MARK = "%% kanban:settings"


@dataclass(frozen=True)
class Card:
    column: str
    start: int  # index of the "- [ ]" line
    end: int  # exclusive: first line after its indented details
    checked: bool
    title: str


def board_path() -> Path:
    return Path(os.environ.get("WICKD_KANBAN", DEFAULT_PATH))


def is_owner() -> bool:
    try:
        name = subprocess.run(
            ["git", "config", "user.name"], capture_output=True, text=True, check=False
        ).stdout.strip()
    except OSError:
        return False
    return name == OWNER


def read_lines(path: Path) -> list[str]:
    if not path.exists():
        sys.exit(f"Kanban board not found: {path}")
    return path.read_text(encoding="utf-8").split("\n")


def columns(lines: list[str]) -> dict[str, tuple[int, int]]:
    """Column name -> (heading index, exclusive end index)."""
    heads = [(i, l[3:].strip()) for i, l in enumerate(lines) if l.startswith("## ")]
    stop = next((i for i, l in enumerate(lines) if l.startswith(SETTINGS_MARK)), len(lines))
    out = {}
    for n, (i, name) in enumerate(heads):
        end = heads[n + 1][0] if n + 1 < len(heads) else stop
        out[name] = (i, end)
    return out


def cards(lines: list[str]) -> list[Card]:
    found = []
    for name, (head, end) in columns(lines).items():
        i = head + 1
        while i < end:
            m = CARD_RE.match(lines[i])
            if not m:
                i += 1
                continue
            j = i + 1
            while j < end and lines[j][:1] in ("\t", " ") and lines[j].strip():
                j += 1
            found.append(Card(name, i, j, m.group(1) == "x", m.group(2)))
            i = j
    return found


def find_column(lines: list[str], name: str) -> str:
    matches = [c for c in columns(lines) if c.lower() == name.lower()]
    if not matches:
        sys.exit(f"No column '{name}'. Columns: {', '.join(columns(lines))}")
    return matches[0]


def find_card(lines: list[str], query: str, include_done: bool) -> Card:
    pool = [c for c in cards(lines) if include_done or c.column != DONE]
    plan = PLAN_QUERY_RE.match(query.strip())
    if plan:
        n = int(plan.group(1))
        hits = [c for c in pool if re.search(rf"\(plan 0*{n}\)", c.title)]
    else:
        hits = [c for c in pool if query.lower() in c.title.lower()]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        sys.exit(f"No card matches '{query}'" + ("" if include_done else " (outside Done)"))
    listing = "\n".join(f"  [{c.column}] {c.title}" for c in hits)
    sys.exit(f"'{query}' matches {len(hits)} cards; be more specific:\n{listing}")


def insert_index(lines: list[str], column: str, at_top: bool) -> int:
    head, end = columns(lines)[column]
    if at_top:
        anchor = next((i for i in range(head + 1, end) if lines[i].strip() == DONE_ANCHOR), None)
        return (anchor if anchor is not None else head) + 1
    col_cards = [c for c in cards(lines) if c.column == column]
    return col_cards[-1].end if col_cards else head + 2 if head + 1 < end and not lines[head + 1].strip() else head + 1


def relocate(lines: list[str], card: Card, block: list[str], column: str, at_top: bool) -> list[str]:
    without = lines[: card.start] + lines[card.end :]
    i = insert_index(without, column, at_top)
    return without[:i] + block + without[i:]


def write(path: Path, lines: list[str]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text("\n".join(lines), encoding="utf-8")
    tmp.replace(path)


def cmd_list(lines: list[str], column: str | None) -> None:
    want = find_column(lines, column) if column else None
    current = None
    for c in cards(lines):
        if want and c.column != want:
            continue
        if c.column != current:
            current = c.column
            print(f"\n## {current}")
        details = c.end - c.start - 1
        print(f"- {c.title}" + (f"  (+{details} details)" if details else ""))


def cmd_done(path: Path, lines: list[str], query: str, date: str) -> None:
    card = find_card(lines, query, include_done=False)
    title = re.sub(r"\s*(✅ \d{4}-\d{2}-\d{2}|@\{[\d-]+\})", "", card.title).rstrip()
    block = [f"- [x] {title} ✅ {date}"] + lines[card.start + 1 : card.end]
    write(path, relocate(lines, card, block, DONE, at_top=True))
    print(f"Moved to Done: {title} ✅ {date}  (was in {card.column})")


def cmd_move(path: Path, lines: list[str], query: str, column: str) -> None:
    card = find_card(lines, query, include_done=False)
    target = find_column(lines, column)
    block = lines[card.start : card.end]
    write(path, relocate(lines, card, block, target, at_top=target == DONE))
    print(f"Moved '{card.title}' from {card.column} to {target}")


def with_plan(title: str, number: int) -> str:
    plan = f"(plan {number:02d})"
    if re.search(r"\(plan \d+\)", title):
        return re.sub(r"\(plan \d+\)", plan, title)
    m = re.search(r"\s#\w", title)
    return f"{title[: m.start()]} {plan}{title[m.start():]}" if m else f"{title} {plan}"


def cmd_plan(path: Path, lines: list[str], query: str, number: int) -> None:
    card = find_card(lines, query, include_done=False)
    title = with_plan(card.title, number)
    block = [f"- [ ] {title}"] + lines[card.start + 1 : card.end]
    target = "Features" if card.column == "Ideas" else card.column
    if target == card.column:
        new = lines[: card.start] + block + lines[card.end :]
    else:
        new = relocate(lines, card, block, find_column(lines, target), at_top=False)
    write(path, new)
    print(f"[{target}] {title}")


def cmd_add(path: Path, lines: list[str], column: str, text: str, details: list[str]) -> None:
    target = find_column(lines, column)
    checked = "x" if target == DONE else " "
    block = [f"- [{checked}] {text}"] + [f"\t* {d}" for d in details]
    i = insert_index(lines, target, at_top=target == DONE)
    write(path, lines[:i] + block + lines[i:])
    print(f"Added to {target}: {text}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("path")
    sub.add_parser("list").add_argument("column", nargs="?")
    sub.add_parser("show").add_argument("query")
    d = sub.add_parser("done")
    d.add_argument("query")
    d.add_argument("--date", default=dt.date.today().isoformat())
    m = sub.add_parser("move")
    m.add_argument("query")
    m.add_argument("column")
    pl = sub.add_parser("plan")
    pl.add_argument("query")
    pl.add_argument("number", type=int)
    a = sub.add_parser("add")
    a.add_argument("column")
    a.add_argument("text")
    a.add_argument("--detail", action="append", default=[])
    args = p.parse_args()

    if not is_owner():
        sys.exit("The wickd Kanban board belongs to the repo owner; skip this skill.")
    path = board_path()
    if args.cmd == "path":
        print(path)
        sys.exit(0 if path.exists() else 1)
    lines = read_lines(path)
    if args.cmd == "list":
        cmd_list(lines, args.column)
    elif args.cmd == "show":
        card = find_card(lines, args.query, include_done=True)
        print(f"[{card.column}]")
        print("\n".join(lines[card.start : card.end]))
    elif args.cmd == "done":
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
            sys.exit("--date must be YYYY-MM-DD")
        cmd_done(path, lines, args.query, args.date)
    elif args.cmd == "move":
        cmd_move(path, lines, args.query, args.column)
    elif args.cmd == "plan":
        cmd_plan(path, lines, args.query, args.number)
    elif args.cmd == "add":
        cmd_add(path, lines, args.column, args.text, args.detail)


if __name__ == "__main__":
    main()
