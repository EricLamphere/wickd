// Where notes show up (plan 30): a pin with a count on a widget or monitor card whose period a
// note covers, shaded bands with a pin on time series (a single period is a line), and the small
// list a pin opens (click a note to read it).
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ReferenceArea, ReferenceLine } from 'recharts';
import { StickyNote } from 'lucide-react';
import type { MetricNoteDto } from '../../../../lib/notesApi';
import { rangeText, type NoteBand } from './lib/metricNotes';
import { openMetricNote } from './noteEvents';

const NOTE_FILL = 'rgb(251 191 36)';

function titles(notes: readonly MetricNoteDto[]): string {
  return notes.map((n) => `${n.title} (${rangeText(n.start, n.end)})`).join('\n');
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
          <span className="flex items-center gap-1.5 text-xs text-gray-200"><StickyNote className="w-3 h-3 shrink-0 text-amber-300" /><span className="truncate">{n.title}</span></span>
          <span className="pl-[18px] text-[10px] text-gray-500 truncate">
            {[rangeText(n.start, n.end), n.dimension ? `${n.dimension} = ${n.value}` : null].filter(Boolean).join(' · ')}
          </span>
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
  if (!notes.length) return null;
  const onClick = (e: ReactMouseEvent) => { e.stopPropagation(); show(notes, e.clientX, e.clientY); };
  return (
    <>
      {/* a span, so it can sit inside a clickable card (a <button>) */}
      <span role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); show(notes, 0, 0); } }}
        title={titles(notes)} aria-label={`${notes.length} note${notes.length === 1 ? '' : 's'}`} data-export-hide=""
        className={`shrink-0 inline-flex items-center gap-0.5 px-1 py-px text-[10px] rounded border border-amber-900/60 bg-amber-950/40 text-amber-300 cursor-pointer hover:brightness-125 ${className}`}>
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
  return (
    <g style={{ cursor: 'pointer' }} onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onOpen(notes, e.clientX, e.clientY); }}>
      <title>{titles(notes)}</title>
      <circle cx={cx} cy={cy} r={6} fill={NOTE_FILL} stroke="rgb(var(--surface-panel, 24 24 27))" strokeWidth={1.5} />
      {notes.length > 1 && <text x={cx} y={cy + 3} textAnchor="middle" fontSize={8} fontWeight={700} fill="#1c1917">{notes.length}</text>}
    </g>
  );
}

/**
 * Recharts children for note bands (call inside the chart, not as a component, so the chart sees
 * them as its own reference areas and lines). `xs` must be on the chart's x axis.
 */
export function noteBandElements(bands: NoteBand[], onOpen: (notes: MetricNoteDto[], x: number, y: number) => void): ReactNode[] {
  return bands.map((b) => {
    // Recharts' viewBox is cartesian here (x/y/width); polar charts never get note bands
    const label = { content: (props: { viewBox?: unknown }) => <PinLabel viewBox={props.viewBox as PinViewBox | undefined} notes={b.notes} onOpen={onOpen} /> };
    const key = `note-${b.x1}-${b.x2}`;
    return b.x1 === b.x2
      ? <ReferenceLine key={key} x={b.x1} stroke={NOTE_FILL} strokeOpacity={0.7} strokeDasharray="3 3" ifOverflow="hidden" label={label} />
      : <ReferenceArea key={key} x1={b.x1} x2={b.x2} fill={NOTE_FILL} fillOpacity={0.1} stroke={NOTE_FILL} strokeOpacity={0.35} ifOverflow="hidden" label={label} />;
  });
}
