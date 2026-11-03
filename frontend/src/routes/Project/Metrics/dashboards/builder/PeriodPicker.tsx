// A period button with a popover: presets on the left, a two-month calendar on the right
// (react-day-picker, range mode). Picking a preset applies it; on the calendar the first click
// picks one end and the second the other (in either order, previewed while hovering), and the
// range applies on the second click (rangeClicks.ts). Used for the dashboard's current and comparison periods, and
// for a widget's override (with an "Use the dashboard's …" option on top). The popover is
// rendered on document.body (a rail's scroll area would clip it) and kept inside the window.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DayPicker, type DateRange as DayRange } from 'react-day-picker';
import 'react-day-picker/style.css';
import { CalendarDays, ChevronDown } from 'lucide-react';
import type { DateRange } from '../../../../../lib/dashboardsApi';
import { isRange, rangeLabel } from '../dashboardModel';
import { clickDay, previewRange } from './rangeClicks';

export interface PresetOption {
  key: string;
  label: string;
}

interface Props<T extends string> {
  label: string;
  /** the resolved dates, shown under the label */
  resolved: DateRange | null;
  value: T | DateRange | undefined;
  presets: readonly PresetOption[];
  onChange: (value: T | DateRange) => void;
  /** greyed when it's the comparison period */
  muted?: boolean;
  ariaLabel: string;
  /** a first option that drops the override (a widget following the dashboard's period) */
  inherit?: { label: string; active: boolean; onSelect: () => void };
  /** months shown side by side (1 in narrow places) */
  months?: 1 | 2;
  /** one line, chip-sized, the dates in the tooltip (the query composer) */
  compact?: boolean;
}

const EDGE = 8;

const toDate = (iso: string) => new Date(`${iso}T00:00:00`);
const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function PeriodPicker<T extends string>({ label, resolved, value, presets, onChange, muted, ariaLabel, inherit, months = 2, compact = false }: Props<T>) {
  const [open, setOpen] = useState(false);
  // the shown range (the current one when opened); `pending` is the first click's day
  const [draft, setDraft] = useState<DayRange | undefined>(undefined);
  const [pending, setPending] = useState<Date | null>(null);
  const [hovered, setHovered] = useState<Date | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  // Under the button, inside the window: shifted left at the right edge, above it when there's no room below
  useLayoutEffect(() => {
    if (!open || !popover.current || !ref.current) { setPos(null); return; }
    const anchor = ref.current.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = popover.current;
    const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - EDGE - w));
    const below = anchor.bottom + 4;
    const top = below + h <= window.innerHeight - EDGE ? below : Math.max(EDGE, anchor.top - 4 - h);
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setDraft(resolved ? { from: toDate(resolved.start), to: toDate(resolved.end) } : undefined);
    setPending(null);
    setHovered(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !popover.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickDay = (day: Date) => {
    const next = clickDay(pending, day);
    setPending(next.pending);
    if (next.range) {
      setDraft(next.range);
      onChange({ start: toIso(next.range.from), end: toIso(next.range.to) });
      setOpen(false);
    }
  };
  const shown = previewRange(pending, hovered) ?? draft;
  // the calendar opens on the selected range's last month(s), known at render (the draft is set after it)
  const end = resolved ? toDate(resolved.end) : new Date();
  const openMonth = new Date(end.getFullYear(), end.getMonth() - (months - 1), 1);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label={ariaLabel} aria-expanded={open}
        title={compact && resolved ? rangeLabel(resolved) : undefined}
        className={`flex items-center text-left rounded border hover:border-gray-500 ${compact ? 'gap-1 px-1.5 py-0.5' : 'gap-2 px-2.5 py-1'} ${open ? 'border-brand-600' : 'border-gray-700'} ${muted ? 'bg-transparent' : 'bg-surface-app'}`}>
        <CalendarDays className={`w-3.5 h-3.5 shrink-0 ${muted ? 'text-gray-500' : 'text-brand-300'}`} />
        {compact ? (
          <span className={`text-[11px] whitespace-nowrap ${muted ? 'text-gray-400' : 'text-gray-100'}`}>{label}</span>
        ) : (
          <span className="flex flex-col leading-tight">
            <span className={`text-xs ${muted ? 'text-gray-400' : 'text-gray-100'}`}>{label}</span>
            {resolved && <span className="text-[10px] text-gray-500">{rangeLabel(resolved)}</span>}
          </span>
        )}
        <ChevronDown className="w-3 h-3 text-gray-500" />
      </button>
      {open && createPortal(
        <div ref={popover} role="dialog" aria-label={ariaLabel}
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          className="fixed z-[60] flex max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-auto bg-surface-elevated border border-gray-700 rounded shadow-xl">
          <ul className="flex flex-col py-1 min-w-[11rem] border-r border-gray-800">
            {inherit && (
              <li className="pb-1 mb-1 border-b border-gray-800">
                <button type="button" onClick={() => { inherit.onSelect(); setOpen(false); }}
                  className={`w-full px-3 py-1.5 text-left text-xs hover:bg-gray-800 ${inherit.active ? 'text-brand-200 bg-brand-950/40' : 'text-gray-300'}`}>
                  {inherit.label}
                </button>
              </li>
            )}
            {presets.map((p) => {
              const active = !inherit?.active && !isRange(value) && value === p.key;
              return (
                <li key={p.key}>
                  <button type="button" onClick={() => { onChange(p.key as T); setOpen(false); }}
                    className={`w-full px-3 py-1.5 text-left text-xs hover:bg-gray-800 ${active ? 'text-brand-200 bg-brand-950/40' : 'text-gray-300'}`}>
                    {p.label}
                  </button>
                </li>
              );
            })}
            <li className="px-3 pt-2 pb-1 mt-1 text-[10px] text-gray-500 border-t border-gray-800">
              {pending ? 'Now click the other end →' : 'Or click a start and an end date →'}
            </li>
          </ul>
          <div className="p-2 wickd-day-picker">
            <DayPicker mode="range" numberOfMonths={months} selected={shown} onSelect={() => { /* clicks: pickDay */ }}
              onDayClick={pickDay} onDayMouseEnter={(day) => { if (pending) setHovered(day); }}
              defaultMonth={openMonth}
              weekStartsOn={1} showOutsideDays={false} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
