// New note / Edit note: the fields, and the body as Markdown with Write / Preview tabs (the choice
// is remembered). Pasting or dropping an image uploads it to the note images folder and inserts
// `![](../img/…)`. Saving creates `<NOTES_PATH>/<slug>.md` (or rewrites the note's file; a file
// changed on disk since it was opened is a conflict to reload).
import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { ApiError } from '../../../../lib/api';
import { notesApi, type MetricNoteBody, type MetricNoteDto } from '../../../../lib/notesApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import { useStickyTab } from '../../../../lib/useUrlTab';
import { MarkdownEditor } from '../dashboards/builder/MarkdownEditor';
import type { NotePrefill } from './lib/metricNotes';
import { NoteFields, type NoteForm } from './NoteFields';
import { NoteMarkdown } from './NoteMarkdown';

const EDITOR_TABS = ['write', 'preview'] as const;

function problem(err: unknown): { message: string; field: string | null } {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string; field?: string } | string | null;
    if (body && typeof body === 'object' && body.message) return { message: body.message, field: body.field ?? null };
    if (typeof body === 'string') return { message: body, field: null };
  }
  return { message: err instanceof Error ? err.message : String(err), field: null };
}

function bodyOf(form: NoteForm): MetricNoteBody {
  return {
    title: form.title.trim(), start: form.start, end: form.end, metrics: form.metrics,
    dimension: form.dimension || null, value: form.dimension ? form.value ?? '' : null, body: form.body,
  };
}

export function formOf(note: MetricNoteDto): NoteForm {
  return {
    title: note.title, start: note.start ?? '', end: note.end ?? note.start ?? '', metrics: note.metrics,
    dimension: note.dimension, value: note.value, body: note.body,
  };
}

export function NoteDialog({ projectId, catalog, initial, editing, intro, onDontAsk, onClose, onSaved }: {
  projectId: number;
  catalog: SemanticCatalogDto | undefined;
  initial: NotePrefill;
  /** the note being edited (null = a new one) */
  editing: MetricNoteDto | null;
  intro?: string | null;
  onDontAsk?: (() => void) | null;
  onClose: () => void;
  onSaved: (note: MetricNoteDto) => void;
}) {
  const [form, setForm] = useState<NoteForm>(initial);
  const [tab, setTab] = useStickyTab(`note-editor-tab:${projectId}`, EDITOR_TABS, 'write');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; field: string | null } | null>(null);
  const [dontAsk, setDontAsk] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const uploadImages = async (files: File[]) => {
    try {
      const paths = await Promise.all(files.map((f) => notesApi.uploadImage(projectId, f, editing?.slug ?? (form.title || 'note'))));
      return paths.map((p, i) => `![${files[i].name.replace(/\.[^.]+$/, '') || 'screenshot'}](${p.path})`).join('\n');
    } catch (err) {
      setError(problem(err));
      return '';
    }
  };

  const close = () => {
    if (dontAsk) onDontAsk?.();
    onClose();
  };

  const save = async () => {
    if (!form.title.trim()) { setError({ message: 'Give the note a title.', field: 'title' }); return; }
    if (!form.start || !form.end) { setError({ message: 'A note needs a date range.', field: 'start' }); return; }
    if (form.dimension && !(form.value ?? '').trim()) { setError({ message: 'Pick the dimension value, or no dimension.', field: 'value' }); return; }
    setSaving(true);
    setError(null);
    try {
      const saved = editing
        ? await notesApi.save(projectId, editing.slug, bodyOf(form), editing.modified_at)
        : await notesApi.create(projectId, bodyOf(form));
      if (dontAsk) onDontAsk?.();
      onSaved(saved);
    } catch (err) {
      setError(problem(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60" onClick={() => { if (!saving) close(); }}>
      <div role="dialog" aria-label={editing ? 'Edit note' : 'New note'} onClick={(e) => e.stopPropagation()}
        className="flex flex-col w-full max-w-2xl max-h-[90vh] mx-4 bg-surface-panel border border-gray-700 rounded-lg shadow-2xl">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-100">{editing ? 'Edit note' : 'New note'}</h2>
          <button onClick={close} aria-label="Close" className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-auto flex flex-col gap-3 p-4">
          {intro && <p className="px-2 py-1.5 text-[11px] text-gray-300 rounded border border-brand-900/60 bg-brand-950/30">{intro}</p>}
          <NoteFields projectId={projectId} catalog={catalog} form={form} onChange={setForm} errorField={error?.field ?? null} />
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3 text-[11px]" role="tablist">
              {EDITOR_TABS.map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                  className={`pb-0.5 border-b ${tab === t ? 'border-brand-500 text-gray-100' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
                  {t === 'write' ? 'Write' : 'Preview'}
                </button>
              ))}
              <span className="ml-auto text-[10px] text-gray-600">Markdown · paste or drop screenshots</span>
            </div>
            {tab === 'write'
              ? <MarkdownEditor value={form.body} onChange={(body) => setForm((f) => ({ ...f, body }))} rows={12} onImages={uploadImages}
                  placeholder="What happened, and why it matters for this metric…" />
              : <div className="min-h-[12rem] px-3 py-2 rounded border border-gray-800 bg-surface-app"><NoteMarkdown projectId={projectId} body={form.body} /></div>}
          </div>
          {error && <p className="px-2 py-1.5 text-[11px] text-red-300 rounded border border-red-900/60 bg-red-950/30">{error.message}</p>}
        </div>
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-gray-800">
          {onDontAsk && (
            <label className="flex items-center gap-1.5 text-[11px] text-gray-400">
              <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />Don't ask again
            </label>
          )}
          <div className="flex-1" />
          <button onClick={close} disabled={saving} className="px-3 py-1 text-xs rounded text-gray-300 hover:bg-gray-800">
            {onDontAsk ? 'Skip' : 'Cancel'}
          </button>
          <button onClick={() => void save()} disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-60">
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}{editing ? 'Save' : 'Save note'}
          </button>
        </div>
      </div>
    </div>
  );
}
