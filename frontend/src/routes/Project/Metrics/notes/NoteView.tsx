// One note, read: its range, metric and dimension value, the Markdown with its screenshots, the
// monitor periods marked as expected that link to it, and Edit / Delete / Open file. Deleting
// offers to delete the images only this note uses.
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CalendarRange, FileText, Pencil, StickyNote, Trash2, X } from 'lucide-react';
import { alertError, confirmDialog, confirmWithOptionDialog } from '../../../../lib/dialogs';
import { notesApi, type MetricNoteDto } from '../../../../lib/notesApi';
import { monitorUrl } from '../monitors/monitorView';
import { useExpectations } from '../monitors/useExpectations';
import { rangeText } from './lib/metricNotes';
import { NoteMarkdown } from './NoteMarkdown';

const CHIP = 'inline-flex items-center gap-1 px-1.5 py-px text-[10px] rounded border border-gray-700 text-gray-300';

export function NoteChips({ note }: { note: MetricNoteDto }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={CHIP}><CalendarRange className="w-3 h-3" />{rangeText(note.start, note.end)}</span>
      {note.metrics.length ? note.metrics.map((m) => <span key={m} className={CHIP}>{m}</span>) : <span className={CHIP}>Every metric</span>}
      {note.dimension && <span className={CHIP}>{note.dimension} = {note.value}</span>}
    </div>
  );
}

export async function deleteNote(projectId: number, note: MetricNoteDto): Promise<boolean> {
  const { images } = await notesApi.orphanImages(projectId, note.slug).catch(() => ({ images: [] as string[] }));
  const message = `Delete "${note.title}"? Its file (${note.path}) is removed; git keeps its history.`;
  const opts = { title: 'Delete note', confirmLabel: 'Delete', danger: true };
  let removeImages = false;
  if (images.length) {
    const answer = await confirmWithOptionDialog(message,
      `Also delete ${images.length === 1 ? 'its image' : `its ${images.length} images`} (no other note uses them)`, opts);
    if (!answer) return false;
    removeImages = answer.checked;
  } else if (!await confirmDialog(message, opts)) {
    return false;
  }
  try {
    await notesApi.remove(projectId, note.slug, removeImages);
    return true;
  } catch (err) {
    await alertError(err);
    return false;
  }
}

function LinkedPeriods({ projectId, slug }: { projectId: number; slug: string }) {
  const navigate = useNavigate();
  const { data } = useExpectations(projectId);
  const linked = (data?.expectations ?? []).filter((e) => e.note_slug === slug);
  if (!linked.length) return null;
  return (
    <section className="flex flex-col gap-1 pt-3 border-t border-gray-800">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Monitor periods marked as expected</h3>
      {linked.map((e) => (
        <button key={e.id} onClick={() => navigate(monitorUrl(projectId, e.monitor_id))}
          className="text-left text-[11px] text-gray-300 hover:text-brand-300">
          {e.metric}{e.slice ? ` · ${e.slice}` : ''} · {e.period}
        </button>
      ))}
    </section>
  );
}

export function NoteView({ projectId, note, onEdit, onClose }: {
  projectId: number; note: MetricNoteDto; onEdit: () => void; onClose: () => void;
}) {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const openFile = () => { onClose(); navigate(`/projects/${projectId}/files?path=${encodeURIComponent(note.path)}`); };
  const remove = async () => { if (await deleteNote(projectId, note)) onClose(); };
  const button = 'flex items-center gap-1 px-2 py-1 text-[11px] rounded text-gray-300 hover:bg-gray-800';
  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div role="dialog" aria-label={note.title} onClick={(e) => e.stopPropagation()}
        className="flex flex-col w-full max-w-2xl max-h-[85vh] mx-4 bg-surface-panel border border-gray-700 rounded-lg shadow-2xl">
        <div className="flex items-start gap-2 px-4 py-2.5 border-b border-gray-800">
          <StickyNote className="w-4 h-4 mt-0.5 shrink-0 text-amber-300" />
          <div className="flex-1 min-w-0 flex flex-col gap-1.5">
            <h2 className="text-sm font-semibold text-gray-100">{note.title}</h2>
            {!note.error && <NoteChips note={note} />}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-auto flex flex-col gap-3 p-4">
          {note.error && <p className="px-2 py-1.5 text-[11px] text-red-300 rounded border border-red-900/60 bg-red-950/30">{note.path}: {note.error}</p>}
          {note.warnings.map((w) => (
            <p key={w} className="flex items-center gap-1.5 text-[11px] text-amber-300"><AlertTriangle className="w-3 h-3 shrink-0" />{w}</p>
          ))}
          <NoteMarkdown projectId={projectId} body={note.body} />
          <LinkedPeriods projectId={projectId} slug={note.slug} />
        </div>
        <div className="flex items-center gap-1 px-3 py-2 border-t border-gray-800">
          {!note.error && <button onClick={onEdit} className={button}><Pencil className="w-3 h-3" />Edit</button>}
          <button onClick={openFile} className={button}><FileText className="w-3 h-3" />Open file</button>
          <div className="flex-1" />
          <button onClick={() => void remove()} className={`${button} text-red-300`}><Trash2 className="w-3 h-3" />Delete</button>
        </div>
      </div>
    </div>
  );
}
