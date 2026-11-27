// Notes tab → Timeline (plan 33): the filtered notes on one date axis, a row per metric ("Every
// metric" first), open incidents red, each year's occurrence of a recurring note, a line for
// today. Click a bar to open the note. Layout from lib/timeline.ts.
import { useMemo } from 'react';
import type { MetricNoteDto } from '../../../../lib/notesApi';
import { rangeText, todayIso } from './lib/metricNotes';
import { noteTypeLabel } from './NoteTypeIcon';
import { TIMELINE_SPANS, buildTimeline, monthTicks, timelineRange, todayMark, type TimelineSpan } from './lib/timeline';

const LANE_PX = 18;
const LABEL_PX = 160;

export function NotesTimeline({ notes, span, onSpan, label, onOpen }: {
  notes: MetricNoteDto[];
  span: TimelineSpan;
  onSpan: (span: TimelineSpan) => void;
  label: (metric: string) => string;
  onOpen: (slug: string) => void;
}) {
  const today = todayIso();
  const range = useMemo(() => timelineRange(notes, span, today), [notes, span, today]);
  const rows = useMemo(() => buildTimeline(notes, range, label), [notes, range, label]);
  const ticks = useMemo(() => monthTicks(range), [range]);
  const now = todayMark(range, today);
  const pct = (f: number) => `${(f * 100).toFixed(3)}%`;

  return (
    <div className="flex flex-col gap-2 px-1 py-1">
      <div className="flex items-center gap-2 text-[11px] text-gray-500">
        <span>{rangeText(range.start, range.end)}</span>
        <div className="flex-1" />
        <span>Show</span>
        {TIMELINE_SPANS.map((m) => (
          <button key={m} onClick={() => onSpan(m)} aria-pressed={span === m}
            className={`px-1.5 py-0.5 rounded ${span === m ? 'bg-gray-800 text-gray-100' : 'hover:text-gray-300'}`}>
            {m < 12 ? `${m} months` : `${m / 12} year${m === 12 ? '' : 's'}`}
          </button>
        ))}
      </div>
      {!rows.length && <p className="p-3 text-xs text-gray-500">No notes in these dates.</p>}
      {rows.length > 0 && (
        <div className="relative">
          <div className="flex h-5 border-b border-gray-800" style={{ paddingLeft: LABEL_PX }}>
            <div className="relative flex-1">
              {ticks.map((t) => (
                <span key={t.left} className="absolute top-0 pl-1 text-[10px] text-gray-500 whitespace-nowrap border-l border-gray-800" style={{ left: pct(t.left) }}>{t.label}</span>
              ))}
            </div>
          </div>
          {rows.map((row) => (
            <div key={row.key} className="flex border-b border-gray-800/60">
              <div className="shrink-0 px-2 py-1 text-[11px] text-gray-300 truncate" style={{ width: LABEL_PX }} title={row.label}>{row.label}</div>
              <div className="relative flex-1 my-1" style={{ height: row.lanes * LANE_PX }}>
                {ticks.map((t) => <span key={t.left} className="absolute inset-y-0 border-l border-gray-800/50" style={{ left: pct(t.left) }} />)}
                {now != null && <span className="absolute inset-y-0 border-l border-brand-500/60" style={{ left: pct(now) }} title={`Today (${today})`} />}
                {row.bars.map((b) => (
                  <button key={`${b.note.slug}-${b.start}`} onClick={() => onOpen(b.note.slug)}
                    title={`${b.note.title}\n${rangeText(b.start, b.end)}\n${noteTypeLabel(b.note)}${b.note.recurs ? '\nEvery year' : ''}`}
                    className="absolute flex items-center h-[14px] px-1 overflow-hidden rounded-sm text-[10px] text-left text-gray-900 whitespace-nowrap hover:brightness-110"
                    style={{ left: pct(b.left), width: pct(b.width), minWidth: 4, top: b.lane * LANE_PX + 2, background: b.color }}>
                    {b.note.title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
