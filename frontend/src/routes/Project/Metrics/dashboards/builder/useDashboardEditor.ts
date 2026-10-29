// The dashboard being edited: an undo history in memory, saved to the file a moment after
// each change (there's no Edit/Done). If the file changes on disk (git pull, another editor)
// while nothing is waiting to be saved, the editor follows it; a conflicting save is
// reported instead of overwriting the newer file.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../../../lib/api';
import type { DashboardDetailDto, DashboardDoc } from '../../../../../lib/dashboardsApi';
import { historyOf, record, redo as redoHistory, undo as undoHistory, type History } from '../dashboardModel';
import { errorText, useSaveDashboard } from '../useDashboards';

const SAVE_DELAY_MS = 700;

export type SaveState = { kind: 'saved' } | { kind: 'pending' } | { kind: 'saving' } | { kind: 'error'; message: string; conflict: boolean };

const same = (a: DashboardDoc | null, b: DashboardDoc | null) => JSON.stringify(a) === JSON.stringify(b);

export function useDashboardEditor(
  projectId: number, slug: string, detail: DashboardDetailDto | undefined,
  onSaved: (before: DashboardDoc, after: DashboardDoc) => void,
) {
  const save = useSaveDashboard(projectId, slug);
  const [history, setHistory] = useState<History<DashboardDoc> | null>(null);
  const [state, setState] = useState<SaveState>({ kind: 'saved' });
  const saved = useRef<{ doc: DashboardDoc; modifiedAt: string | null } | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // First load, and the file changing on disk while there's nothing unsaved
  useEffect(() => {
    const doc = detail?.dashboard;
    if (!doc) return;
    const current = saved.current;
    if (current && current.modifiedAt === detail.modified_at) return;
    const clean = !history || same(history.present, current?.doc ?? null);
    if (!clean) return;
    saved.current = { doc, modifiedAt: detail.modified_at };
    setHistory((h) => (h && same(h.present, doc) ? h : historyOf(doc)));
  }, [detail]); // eslint-disable-line react-hooks/exhaustive-deps

  const present = history?.present ?? null;

  useEffect(() => {
    if (!present || !saved.current || same(present, saved.current.doc)) return;
    setState((s) => (s.kind === 'error' && s.conflict ? s : { kind: 'pending' }));
    const timer = setTimeout(async () => {
      const before = saved.current;
      if (!before) return;
      setState({ kind: 'saving' });
      try {
        const result = await save.mutateAsync({ doc: present, base: before.modifiedAt });
        saved.current = { doc: present, modifiedAt: result.modified_at };
        setState({ kind: 'saved' });
        onSavedRef.current(before.doc, present);
      } catch (err) {
        const conflict = err instanceof ApiError && err.status === 409;
        setState({ kind: 'error', conflict, message: errorText(err) ?? 'Saving failed' });
      }
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [present]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = useCallback((change: (doc: DashboardDoc) => DashboardDoc) => {
    setHistory((h) => (h ? record(h, change(h.present)) : h));
  }, []);
  const undo = useCallback(() => setHistory((h) => (h ? undoHistory(h) : h)), []);
  const redo = useCallback(() => setHistory((h) => (h ? redoHistory(h) : h)), []);

  /** After a conflict: drop the local changes and load the file as it is on disk. */
  const reload = useCallback((latest: DashboardDetailDto) => {
    if (!latest.dashboard) return;
    saved.current = { doc: latest.dashboard, modifiedAt: latest.modified_at };
    setHistory(historyOf(latest.dashboard));
    setState({ kind: 'saved' });
  }, []);

  /** The dashboard as last saved (what the server's results are computed from). */
  const savedDoc = useCallback(() => saved.current?.doc ?? null, []);

  return {
    doc: present, apply, undo, redo, reload, state, savedDoc,
    canUndo: !!history?.past.length, canRedo: !!history?.future.length,
  };
}
