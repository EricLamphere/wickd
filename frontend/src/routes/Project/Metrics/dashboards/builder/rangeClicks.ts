// The period calendar's two clicks: the first picks one end, the second the other; the range runs
// from the earlier day to the later, whichever was clicked first. While waiting for the second
// click, the hovered day previews the range. Pure; tested in rangeClicks.test.ts.

export interface DayRange {
  from: Date;
  to: Date;
}

function ordered(a: Date, b: Date): DayRange {
  return a.getTime() <= b.getTime() ? { from: a, to: b } : { from: b, to: a };
}

/** After clicking `day`: the first end kept for the next click, or the finished range. */
export function clickDay(pending: Date | null, day: Date): { pending: Date | null; range: DayRange | null } {
  if (!pending) return { pending: day, range: null };
  return { pending: null, range: ordered(pending, day) };
}

/** What the calendar highlights: the preview to the hovered day while one end is picked. */
export function previewRange(pending: Date | null, hovered: Date | null): { from: Date; to: Date | undefined } | null {
  if (!pending) return null;
  return hovered ? ordered(pending, hovered) : { from: pending, to: undefined };
}
