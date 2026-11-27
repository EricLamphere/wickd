// A monitor's flagged periods: mark one as expected (or undo), the metric notes that explain it,
// and the note linked to a period marked as expected. Marking offers to write a note about it
// (plan 30): the New note dialog opens prefilled; Save links it to the Marked as expected log,
// Skip leaves the period marked without one, "Don't ask again" is remembered per project.
// Draft with Wicky (Pro, plan 33) writes the note's first draft from the flag and the notes near it.
import { useState } from 'react';
import { Check, Loader2, RotateCcw, Sparkles, StickyNote } from 'lucide-react';
import type { MonitorDto, MonitorExpectationDto, MonitorPointDto } from '../../../../lib/monitorsApi';
import { notesApi, type MetricNoteDto } from '../../../../lib/notesApi';
import { alertError, confirmDialog } from '../../../../lib/dialogs';
import { useAiStatus } from '../../components/Wicky/useAi';
import { addMetricNote, openMetricNote } from '../notes/noteEvents';
import { expectedPrefill, notesFor, periodEnd } from '../notes/lib/metricNotes';
import { formatNumber, KIND_LABEL, kindTone } from './monitorView';

const skipKey = (projectId: number) => `note-on-expected-skip:${projectId}`;

function askForNote(projectId: number): boolean {
  try {
    return localStorage.getItem(skipKey(projectId)) !== '1';
  } catch {
    return true;
  }
}

function stopAsking(projectId: number): void {
  try {
    localStorage.setItem(skipKey(projectId), '1');
  } catch {
    // private window: the question comes back next time
  }
}

export type SuppressResult = { expectation_id: number | null } | null;

interface Props {
  projectId: number;
  monitor: MonitorDto;
  slice: string;
  flagged: MonitorPointDto[];
  notes: MetricNoteDto[];
  expectations: MonitorExpectationDto[];
  /** the metric's label (note titles) */
  label: string | null;
  onSuppress: (slice: string, period: string, suppressed: boolean) => Promise<SuppressResult>;
}

export function FlaggedPeriods({ projectId, monitor, slice, flagged, notes, expectations, label, onSuppress }: Props) {
  const dims = monitor.dimension && slice ? { [monitor.dimension]: slice } : {};
  const covering = (p: MonitorPointDto) => notesFor(notes, { start: p.period, end: periodEnd(p.period, monitor.grain), metrics: [monitor.metric], dims });
  const entryFor = (p: MonitorPointDto) => expectations.find((e) => e.monitor_id === monitor.id && e.slice === slice && e.period === p.period);

  const { status: ai } = useAiStatus();
  const canDraft = !!ai?.entitled && !!ai.pro_installed;
  const [drafting, setDrafting] = useState<string | null>(null);
  const prefillOf = (p: MonitorPointDto) => expectedPrefill({
    metric: monitor.metric, label, period: p.period, grain: monitor.grain, kind: p.kind, value: p.value,
    expected: p.expected, dimension: monitor.dimension, slice, format: formatNumber,
  });
  const noteFor = (p: MonitorPointDto, expectationId: number | null, intro: string | null, dontAsk: boolean) => addMetricNote(
    prefillOf(p),
    { expectationId, intro, onDontAsk: dontAsk ? () => stopAsking(projectId) : null },
  );
  const draft = async (p: MonitorPointDto) => {
    setDrafting(p.period);
    try {
      const d = await notesApi.draft(projectId, { monitor_id: monitor.id, period: p.period, slice });
      addMetricNote({ ...prefillOf(p), title: d.title, body: d.body }, {
        expectationId: p.suppressed ? entryFor(p)?.id ?? null : null,
        intro: 'Wicky drafted this from the flagged period and the notes near it. Check it before saving.',
      });
    } catch (err) {
      await alertError(err);
    } finally {
      setDrafting(null);
    }
  };

  const mark = async (p: MonitorPointDto) => {
    const result = await onSuppress(slice, p.period, true);
    if (!result || !askForNote(projectId) || covering(p).length) return;
    noteFor(p, result.expectation_id, `Marked ${p.period} as expected. Write down why, so everyone looking at ${monitor.metric} sees it.`, true);
  };

  const undo = async (p: MonitorPointDto) => {
    const entry = entryFor(p);
    if (entry?.note_slug && !entry.note_missing && !await confirmDialog(
      `Flag ${p.period} again? Its note stays: it's a file in the repo, and you can delete it from the Notes tab.`,
      { title: 'Undo mark as expected', confirmLabel: 'Flag again' },
    )) return;
    await onSuppress(slice, p.period, false);
  };

  if (!flagged.length) return <p className="text-[11px] text-gray-600">Nothing flagged in the stored history.</p>;
  return (
    <ul className="flex flex-col divide-y divide-gray-800 border border-gray-800 rounded max-h-64 overflow-auto">
      {flagged.map((p) => {
        const explained = covering(p);
        const entry = p.suppressed ? entryFor(p) : undefined;
        const linked = entry?.note_slug && !entry.note_missing ? entry.note_slug : null;
        return (
          <li key={p.period} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <span className="font-mono text-gray-300 w-24 shrink-0">{p.period}</span>
            <span className={`flex-1 truncate ${p.suppressed ? 'text-gray-500' : kindTone(p.kind) === 'fail' ? 'text-red-300' : 'text-amber-300'}`}>
              {p.suppressed ? 'Marked as expected' : KIND_LABEL[p.kind]} · {formatNumber(p.value)}
              {p.expected !== null ? ` vs ~${formatNumber(p.expected)}` : ''}
            </span>
            {explained.length > 0 && !linked && (
              <button onClick={() => openMetricNote(explained[0].slug)} title={explained.map((n) => n.title).join('\n')}
                className="flex items-center gap-1 shrink-0 text-[11px] text-amber-300 hover:brightness-125">
                <StickyNote className="w-3 h-3" />Explained by a note
              </button>
            )}
            {linked && (
              <button onClick={() => openMetricNote(linked)} title="Open the note about this period"
                className="flex items-center gap-1 shrink-0 text-[11px] text-amber-300 hover:brightness-125">
                <StickyNote className="w-3 h-3" />Note
              </button>
            )}
            {p.suppressed && entry && !linked && !explained.length && (
              <button onClick={() => noteFor(p, entry.id, null, false)} title={entry.note_missing ? 'Its note is gone (deleted or renamed): write another' : 'Write a note about this period'}
                className="shrink-0 text-[11px] text-gray-400 hover:text-gray-200">
                {entry.note_missing ? 'Note missing · add' : 'Add note'}
              </button>
            )}
            {canDraft && !linked && !explained.length && (
              <button onClick={() => void draft(p)} disabled={drafting !== null} title="Draft with Wicky: a note about this period, from the flag and the notes near it"
                className="flex items-center gap-1 shrink-0 text-[11px] text-purple-300 hover:brightness-125 disabled:opacity-50">
                {drafting === p.period ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}Draft
              </button>
            )}
            <button onClick={() => void (p.suppressed ? undo(p) : mark(p))}
              title={p.suppressed ? 'Flag this period again (a note about it stays: it\'s a file)' : 'Not a problem: stop flagging it and leave it out of the baseline (other periods\' expected values may change)'}
              className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded border border-gray-700 text-[11px] text-gray-400 hover:text-gray-200">
              {p.suppressed ? <RotateCcw className="w-3 h-3" /> : <Check className="w-3 h-3" />}
              {p.suppressed ? 'Undo' : 'Mark as expected'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
