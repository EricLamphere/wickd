// Metrics page → Notes (?tab=notes): every metric note, grouped by month and sorted by start, end or
// date added (newest first by default; remembered per project), filterable by text, metric, dimension and dates. `?note=<slug>` opens one (part of history).
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowDownWideNarrow, ArrowUpNarrowWide, Plus, StickyNote } from 'lucide-react';
import type { MetricNoteDto } from '../../../../lib/notesApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import { NoteView } from './NoteView';
import { addMetricNote, openMetricNote } from './noteEvents';
import { useStickyTab } from '../../../../lib/useUrlTab';
import { NOTE_SORT_BY, NOTE_SORT_DIR, filterNotes, groupByMonth, rangeText, type NoteSortBy, type NotesFilter } from './lib/metricNotes';
import { useNotes } from './useNotes';

export const NOTE_PARAM = 'note';
const INPUT = 'px-2 py-1 rounded border border-gray-700 bg-surface-app text-xs text-gray-200 outline-none focus:border-brand-600';
const SORT_LABELS: Record<NoteSortBy, string> = { added: 'Date added', start: 'Start date', end: 'End date' };
const EMPTY: NotesFilter = { text: '', metric: null, dimension: null, start: null, end: null };

function excerpt(body: string): string {
  return body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[#*_`>~[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function NoteRow({ note, onOpen }: { note: MetricNoteDto; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="flex flex-col gap-0.5 w-full px-3 py-2 text-left rounded hover:bg-gray-800/60">
      <span className="flex items-center gap-2 min-w-0">
        {note.error ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-red-400" /> : <StickyNote className="w-3.5 h-3.5 shrink-0 text-amber-300" />}
        <span className="text-xs font-medium text-gray-200 truncate">{note.title}</span>
        <span className="shrink-0 text-[10px] text-gray-500">{rangeText(note.start, note.end)}</span>
        <span className="flex-1" />
        <span className="shrink-0 text-[10px] text-gray-500 truncate max-w-[40%]">
          {[note.metrics.length ? note.metrics.join(', ') : 'every metric', note.dimension ? `${note.dimension} = ${note.value}` : null]
            .filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="pl-5 text-[11px] text-gray-500 truncate">{note.error ? `${note.path}: ${note.error}` : excerpt(note.body) || ' '}</span>
    </button>
  );
}

export function NotesTab({ projectId, catalog }: { projectId: number; catalog: SemanticCatalogDto }) {
  const { data, isLoading, error } = useNotes(projectId);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<NotesFilter>(EMPTY);
  const notes = useMemo(() => data?.notes ?? [], [data]);
  const [sortBy, setSortBy] = useStickyTab(`metric-notes-sort:${projectId}`, NOTE_SORT_BY, 'start');
  const [sortDir, setSortDir] = useStickyTab(`metric-notes-sort-dir:${projectId}`, NOTE_SORT_DIR, 'desc');
  const groups = useMemo(() => groupByMonth(filterNotes(notes, filter), sortBy, sortDir), [notes, filter, sortBy, sortDir]);
  const dimensions = useMemo(() => [...new Set(catalog.metrics.flatMap((m) => m.dimensions.filter((d) => d.type !== 'time').map((d) => d.name)))].sort(), [catalog]);
  const openSlug = params.get(NOTE_PARAM);
  const open = openSlug ? notes.find((n) => n.slug === openSlug) ?? null : null;
  const setOpen = (slug: string | null) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (slug) next.set(NOTE_PARAM, slug); else next.delete(NOTE_PARAM);
    return next;
  });
  // a note deleted while open: drop the param
  useEffect(() => { if (data && openSlug && !open) setOpen(null); }, [data, openSlug, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<NotesFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const filtered = JSON.stringify(filter) !== JSON.stringify(EMPTY);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-gray-800">
        <input value={filter.text} onChange={(e) => set({ text: e.target.value })} placeholder="Search notes" aria-label="Search notes" className={`${INPUT} w-48`} />
        <select value={filter.metric ?? ''} onChange={(e) => set({ metric: e.target.value || null })} aria-label="Metric" className={INPUT}>
          <option value="">Any metric</option>
          {catalog.metrics.map((m) => <option key={m.name} value={m.name}>{m.label || m.name}</option>)}
        </select>
        <select value={filter.dimension ?? ''} onChange={(e) => set({ dimension: e.target.value || null })} aria-label="Dimension" className={INPUT}>
          <option value="">Any dimension</option>
          {dimensions.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <input type="date" value={filter.start ?? ''} onChange={(e) => set({ start: e.target.value || null })} aria-label="From" className={INPUT} />
        <span className="text-[11px] text-gray-500">to</span>
        <input type="date" value={filter.end ?? ''} onChange={(e) => set({ end: e.target.value || null })} aria-label="To" className={INPUT} />
        {filtered && <button onClick={() => setFilter(EMPTY)} className="text-[11px] text-gray-400 hover:text-gray-200">Clear</button>}
        <div className="flex-1" />
        <span className="text-[11px] text-gray-500">Sort by</span>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as NoteSortBy)} aria-label="Sort by" className={INPUT}>
          {NOTE_SORT_BY.map((k) => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
        </select>
        <button onClick={() => setSortDir(sortDir === 'desc' ? 'asc' : 'desc')}
          title={sortDir === 'desc' ? 'Newest first' : 'Oldest first'} aria-label={sortDir === 'desc' ? 'Newest first' : 'Oldest first'}
          className="p-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-800">
          {sortDir === 'desc' ? <ArrowDownWideNarrow className="w-3.5 h-3.5" /> : <ArrowUpNarrowWide className="w-3.5 h-3.5" />}
        </button>
        {data && <span className="text-[10px] text-gray-500" title="Notes are Markdown files in the project, shared through git">{data.folder}/</span>}
        <button onClick={() => addMetricNote({ kind: 'metric', metric: filter.metric })}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-brand-600 text-white hover:bg-brand-500">
          <Plus className="w-3.5 h-3.5" />New note
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
        {isLoading && <p className="p-3 text-xs text-gray-500">Loading notes…</p>}
        {error && <p className="p-3 text-xs text-red-400">Couldn't load the notes: {error instanceof Error ? error.message : String(error)}</p>}
        {data && !notes.length && (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <StickyNote className="w-7 h-7 text-gray-600" />
            <h2 className="text-sm font-medium text-gray-200">Write down why a metric moved</h2>
            <p className="max-w-md text-xs text-gray-500">
              A note covers a date range, optionally one metric and one dimension value, and shows up on the dashboards,
              monitors and metric pages it applies to. Right-click a metric or a value anywhere and choose Add note…
            </p>
          </div>
        )}
        {data && notes.length > 0 && !groups.length && <p className="p-3 text-xs text-gray-500">No notes match.</p>}
        {groups.map((g) => (
          <section key={g.key} className="flex flex-col pb-3">
            <h3 className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{g.label}</h3>
            {g.notes.map((n) => <NoteRow key={n.slug} note={n} onOpen={() => setOpen(n.slug)} />)}
          </section>
        ))}
      </div>
      {open && <NoteView projectId={projectId} note={open} onClose={() => setOpen(null)} onEdit={() => { setOpen(null); openMetricNote(open.slug, true); }} />}
    </div>
  );
}
