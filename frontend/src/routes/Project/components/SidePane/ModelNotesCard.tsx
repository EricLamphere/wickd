// Metric notes that mention this node (`model:<name>` in the note, plan 33), newest first: a
// backfill or an incident written about the model shows where people look at the model.
import type { ModelNode } from '../../../../lib/api';
import { prefillFrom, rangeText } from '../../Metrics/notes/lib/metricNotes';
import { notesMentioning } from '../../Metrics/notes/lib/noteMentions';
import { addMetricNote, openMetricNote } from '../../Metrics/notes/noteEvents';
import { useNotes } from '../../Metrics/notes/useNotes';
import { NoteTypeIcon } from '../../Metrics/notes/NoteTypeIcon';

const SHOWN = 5;

export function ModelNotesCard({ projectId, model }: { projectId: number; model: ModelNode }) {
  const { data } = useNotes(projectId);
  const notes = notesMentioning((data?.notes ?? []).filter((n) => !n.error), model.name)
    .sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''));
  if (!notes.length) return null;
  const write = () => addMetricNote({ ...prefillFrom({ kind: 'metric', metric: null }), body: `About model:${model.name}\n\n` });
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center text-[10px] uppercase tracking-wider text-gray-600 font-medium">
        Notes<span className="ml-1 normal-case tracking-normal text-gray-600">({notes.length})</span>
        <button onClick={write} className="ml-auto normal-case tracking-normal text-[10px] text-gray-500 hover:text-gray-300" title="Write a metric note (mention this model with model:)">
          New note
        </button>
      </span>
      <div className="flex flex-col gap-1 bg-surface-elevated/40 rounded-lg p-2">
        {notes.slice(0, SHOWN).map((n) => (
          <button key={n.slug} onClick={() => openMetricNote(n.slug)} className="flex items-center gap-1.5 px-1 py-0.5 text-left rounded hover:bg-gray-800/60">
            <NoteTypeIcon note={n} className="w-3 h-3" />
            <span className="flex-1 min-w-0 text-xs text-gray-200 truncate">{n.title}</span>
            <span className="shrink-0 text-[10px] text-gray-500">{rangeText(n.start, n.end)}</span>
          </button>
        ))}
        {notes.length > SHOWN && <span className="px-1 text-[10px] text-gray-500">and {notes.length - SHOWN} more in Metrics → Notes</span>}
      </div>
    </div>
  );
}
