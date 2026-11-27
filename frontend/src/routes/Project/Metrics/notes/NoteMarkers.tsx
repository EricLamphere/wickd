// Where notes show up (plan 30): a pin with a count on a widget or monitor card whose period a
// note covers, shaded bands with a pin on time series (a single period is a line), and the small
// list a pin opens (click a note to read it). Open incidents (plan 33) are red instead of amber.
// Hidden while the dashboard's Notes toggle is off or an export leaves them out (NotesVisibility).
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ReferenceArea, ReferenceLine } from 'recharts';
import { StickyNote } from 'lucide-react';
import type { MetricNoteDto } from '../../../../lib/notesApi';
import { noteColor, rangeText, type NoteBand } from './lib/metricNotes';
import { openMetricNote } from './noteEvents';
import { useNotesVisible } from './notesVisibility';
import { NoteTypeIcon } from './NoteTypeIcon';

function titles(notes: readonly MetricNoteDto[]): string {
  return notes.map((n) => `${n.title} (${rangeText(n.start, n.end)})`).join('\n');
}

/** A note's title, then its date range (and slice). */
function NoteSummary({ note }: { note: MetricNoteDto }) {
  return (
    <>
      <span className="flex items-center gap-1.5 text-xs text-gray-200">
        <NoteTypeIcon note={note} className="w-3 h-3" /><span className="truncate">{note.title}</span>
        {note.type === 'incident' && note.status !== 'resolved' && <span className="shrink-0 text-[9px] uppercase tracking-wide text-red-400">open</span>}
      </span>
      <span className="pl-[18px] text-[10px] text-gray-500 truncate">
        {[rangeText(note.start, note.end), note.dimension ? `${note.dimension} = ${note.value}` : null].filter(Boolean).join(' · ')}
      </span>
    </>
  );
}

/** Hover card for a chart pin: each note's title and range, beside the pointer (above the chart's own tooltip). */
function NotesHoverCard({ notes, x, y }: { notes: readonly MetricNoteDto[]; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 12, top: y + 12 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setPos({ left: Math.min(x + 12, window.innerWidth - el.offsetWidth - 8), top: Math.min(y + 12, window.innerHeight - el.offsetHeight - 8) });
  }, [x, y]);
  return createPortal(
    <div ref={ref} role="tooltip" style={pos}
      className="fixed z-[70] max-w-72 flex flex-col gap-1 px-3 py-1.5 bg-surface-elevated border border-gray-700 rounded shadow-xl pointer-events-none">
      {notes.map((n) => <div key={n.slug} className="flex flex-col min-w-0"><NoteSummary note={n} /></div>)}
      <span className="text-[10px] text-gray-600">Click to open</span>
    </div>,
    document.body,
  );
}

/** The notes at a pin, at the pointer; one note opens straight away. */
export function NotesPopover({ notes, x, y, onClose }: { notes: MetricNoteDto[]; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setPos({ left: Math.min(x, window.innerWidth - el.offsetWidth - 8), top: Math.min(y, window.innerHeight - el.offsetHeight - 8) });
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onClose, true); };
  }, [onClose]);
  return createPortal(
    <div ref={ref} role="menu" aria-label="Notes" style={pos} onClick={(e) => e.stopPropagation()}
      className="fixed z-[70] w-72 py-1 bg-surface-elevated border border-gray-700 rounded shadow-xl">
      {notes.map((n) => (
        <button key={n.slug} role="menuitem" onClick={() => { onClose(); openMetricNote(n.slug); }}
          className="flex flex-col w-full px-3 py-1.5 text-left hover:bg-gray-800">
          <NoteSummary note={n} />
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** Opening notes from a marker: straight to the note when there's one, else the list at the pointer. */
export function useNotesPopover(): { show: (notes: MetricNoteDto[], x: number, y: number) => void; popover: ReactNode } {
  const [at, setAt] = useState<{ notes: MetricNoteDto[]; x: number; y: number } | null>(null);
  const show = (notes: MetricNoteDto[], x: number, y: number) => {
    if (notes.length === 1) openMetricNote(notes[0].slug); else if (notes.length) setAt({ notes, x, y });
  };
  return { show, popover: at ? <NotesPopover notes={at.notes} x={at.x} y={at.y} onClose={() => setAt(null)} /> : null };
}

/** A corner pin with the number of notes covering what's shown. */
export function NotePin({ notes, className = '' }: { notes: MetricNoteDto[]; className?: string }) {
  const { show, popover } = useNotesPopover();
  const visible = useNotesVisible();
  if (!notes.length || !visible.show) return null;
  const incident = notes.some((n) => n.status === 'open');
  const tone = incident ? 'border-red-900/60 bg-red-950/40 text-red-300' : 'border-amber-900/60 bg-amber-950/40 text-amber-300';
  const onClick = (e: ReactMouseEvent) => { e.stopPropagation(); show(notes, e.clientX, e.clientY); };
  return (
    <>
      {/* a span, so it can sit inside a clickable card (a <button>) */}
      <span role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); show(notes, 0, 0); } }}
        title={titles(notes)} aria-label={`${notes.length} note${notes.length === 1 ? '' : 's'}`} {...(visible.inExport ? {} : { 'data-export-hide': '' })}
        className={`shrink-0 inline-flex items-center gap-0.5 px-1 py-px text-[10px] rounded border ${tone} cursor-pointer hover:brightness-125 ${className}`}>
        <StickyNote className="w-3 h-3" />{notes.length > 1 && notes.length}
      </span>
      {popover}
    </>
  );
}

interface PinViewBox { x?: number; y?: number; width?: number }

function PinLabel({ viewBox, notes, onOpen }: { viewBox?: PinViewBox; notes: MetricNoteDto[]; onOpen: (notes: MetricNoteDto[], x: number, y: number) => void }) {
  const cx = (viewBox?.x ?? 0) + (viewBox?.width ?? 0) / 2;
  const cy = (viewBox?.y ?? 0) + 6;
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  return (
    <g style={{ cursor: 'pointer' }} onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => setHover({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => { e.stopPropagation(); setHover(null); onOpen(notes, e.clientX, e.clientY); }}>
      {hover && <NotesHoverCard notes={notes} x={hover.x} y={hover.y} />}
      <circle cx={cx} cy={cy} r={6} fill={noteColor(notes)} stroke="rgb(var(--surface-panel, 24 24 27))" strokeWidth={1.5} />
      {notes.length > 1 && <text x={cx} y={cy + 3} textAnchor="middle" fontSize={8} fontWeight={700} fill="#1c1917">{notes.length}</text>}
    </g>
  );
}

/**
 * Recharts children for note bands (call inside the chart, not as a component, so the chart sees
 * them as its own reference areas and lines). `xs` must be on the chart's x axis.
 */
export function noteBandElements(bands: NoteBand[], onOpen: (notes: MetricNoteDto[], x: number, y: number) => void, show = true): ReactNode[] {
  if (!show) return [];
  return bands.map((b) => {
    const fill = noteColor(b.notes);
    // Recharts' viewBox is cartesian here (x/y/width); polar charts never get note bands
    const label = { content: (props: { viewBox?: unknown }) => <PinLabel viewBox={props.viewBox as PinViewBox | undefined} notes={b.notes} onOpen={onOpen} /> };
    const key = `note-${b.x1}-${b.x2}`;
    return b.x1 === b.x2
      ? <ReferenceLine key={key} x={b.x1} stroke={fill} strokeOpacity={0.7} strokeDasharray="3 3" ifOverflow="hidden" label={label} />
      : <ReferenceArea key={key} x1={b.x1} x2={b.x2} fill={fill} fillOpacity={0.1} stroke={fill} strokeOpacity={0.35} ifOverflow="hidden" label={label} />;
  });
}
