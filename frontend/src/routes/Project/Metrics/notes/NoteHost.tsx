// Mounted once in ProjectLayout: opens the New note dialog (addMetricNote()) and notes
// (openMetricNote()) from any page. A note saved from Mark as expected is linked to its log entry.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { alertError } from '../../../../lib/dialogs';
import { monitorsApi } from '../../../../lib/monitorsApi';
import { notesApi, type MetricNoteDto, type MetricNotesListDto } from '../../../../lib/notesApi';
import { useSemanticStatus } from '../../components/semantic/useSemantic';
import { useSemanticCatalog } from '../useMetricExplorer';
import { expectationsKey } from '../monitors/useExpectations';
import { NoteDialog, formOf } from './NoteDialog';
import { NoteView } from './NoteView';
import {
  ADD_METRIC_NOTE_EVENT, OPEN_METRIC_NOTE_EVENT, type AddNoteDetail, type OpenNoteDetail,
} from './noteEvents';
import { notesKey, useNotes } from './useNotes';
import { currentNote, pushNote, startHistory, type NoteHistory } from './lib/noteHistory';
import { noteNav } from './noteNavigation';

type State =
  | { kind: 'new'; detail: AddNoteDetail }
  // the notes followed from link to link in this dialog (back / forward)
  | { kind: 'view'; history: NoteHistory }
  | { kind: 'edit'; note: MetricNoteDto };

export function NoteHost({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const [state, setState] = useState<State | null>(null);
  const { data: status } = useSemanticStatus(projectId);
  const { data: catalog } = useSemanticCatalog(projectId, !!state && !!status?.available);
  const { data: list } = useNotes(projectId);

  useEffect(() => {
    const onAdd = (e: Event) => setState({ kind: 'new', detail: (e as CustomEvent<AddNoteDetail>).detail });
    const onOpen = async (e: Event) => {
      const { slug, edit } = (e as CustomEvent<OpenNoteDetail>).detail;
      // opened while a note shows (a pin, a link outside the note): it's the next step in its history
      if (!edit) { setState((prev) => ({ kind: 'view', history: prev?.kind === 'view' ? pushNote(prev.history, slug) : startHistory(slug) })); return; }
      try {
        setState({ kind: 'edit', note: await notesApi.get(projectId, slug) });
      } catch (err) {
        await alertError(err);
      }
    };
    window.addEventListener(ADD_METRIC_NOTE_EVENT, onAdd);
    window.addEventListener(OPEN_METRIC_NOTE_EVENT, onOpen);
    return () => {
      window.removeEventListener(ADD_METRIC_NOTE_EVENT, onAdd);
      window.removeEventListener(OPEN_METRIC_NOTE_EVENT, onOpen);
    };
  }, [projectId]);

  if (!state) return null;
  const close = () => setState(null);
  const saved = async (note: MetricNoteDto, expectationId?: number | null) => {
    // shown at once (the list refetches on metric_notes_changed)
    qc.setQueryData<MetricNotesListDto>(notesKey(projectId), (prev) => prev && ({
      ...prev, notes: [...prev.notes.filter((n) => n.slug !== note.slug), note].sort((a, b) => a.slug.localeCompare(b.slug)),
    }));
    void qc.invalidateQueries({ queryKey: notesKey(projectId) });
    if (expectationId != null) {
      try {
        await monitorsApi.linkExpectationNote(projectId, expectationId, note.slug);
        void qc.invalidateQueries({ queryKey: expectationsKey(projectId) });
      } catch (err) {
        await alertError(err);
      }
    }
    setState({ kind: 'view', history: startHistory(note.slug) });
  };

  if (state.kind === 'view') {
    const slug = currentNote(state.history);
    const note = list?.notes.find((n) => n.slug === slug);
    if (!note) {
      // not listed (yet): the list refetches after a save; a missing file says so
      return list ? <MissingNote slug={slug} onClose={close} /> : null;
    }
    const nav = noteNav(state.history, (history) => setState({ kind: 'view', history }));
    return <NoteView projectId={projectId} note={note} onClose={close} onEdit={() => setState({ kind: 'edit', note })} nav={nav} />;
  }
  if (state.kind === 'edit') {
    return (
      <NoteDialog projectId={projectId} catalog={catalog} initial={formOf(state.note)} editing={state.note} onClose={close}
        onSaved={(n) => void saved(n)} />
    );
  }
  const { detail } = state;
  return (
    <NoteDialog projectId={projectId} catalog={catalog} initial={detail.prefill} editing={null} intro={detail.intro}
      onDontAsk={detail.onDontAsk ?? null} onClose={close} onSaved={(n) => void saved(n, detail.expectationId)} />
  );
}

function MissingNote({ slug, onClose }: { slug: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div role="dialog" className="max-w-sm mx-4 p-4 flex flex-col gap-3 bg-surface-panel border border-gray-700 rounded-lg" onClick={(e) => e.stopPropagation()}>
        <p className="text-xs text-gray-300">There's no note <code className="font-mono">{slug}</code> any more (deleted or renamed outside wickd).</p>
        <button onClick={onClose} className="self-end px-3 py-1 text-xs rounded bg-gray-800 text-gray-200 hover:bg-gray-700">Close</button>
      </div>
    </div>
  );
}
