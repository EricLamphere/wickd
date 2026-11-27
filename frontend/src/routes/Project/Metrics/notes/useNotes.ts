// The project's metric notes (plan 30): all of them, fetched once and matched on the client
// (tens of notes, not thousands). metric_notes_changed (a save, or a file changed on disk)
// invalidates them.
import { useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notesApi, type MetricNoteDto } from '../../../../lib/notesApi';
import { useProjectEvents } from '../../../../lib/sse';
import { notesFor, type NoteContext } from './lib/metricNotes';
import { useNotesVisible } from './notesVisibility';

export const notesKey = (projectId: number) => ['metric-notes', projectId] as const;

export function useNotes(projectId: number) {
  const qc = useQueryClient();
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'metric_notes_changed') qc.invalidateQueries({ queryKey: notesKey(projectId) });
  }, [projectId, qc]));
  return useQuery({
    queryKey: notesKey(projectId),
    queryFn: () => notesApi.list(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
    retry: false,
  });
}

const NONE: MetricNoteDto[] = [];

/** The project's readable notes, for markers (the project id from the route); none while a
 *  dashboard's Notes toggle (or an export without notes) hides them (plan 33). */
export function useProjectNotes(): MetricNoteDto[] {
  const { projectId } = useParams<{ projectId: string }>();
  const { data } = useNotes(Number(projectId));
  const { show } = useNotesVisible();
  return useMemo(() => (show ? data?.notes.filter((n) => !n.error) ?? NONE : NONE), [data, show]);
}

/** Notes that apply to `metrics` over the context (memoized on its fields). */
export function useMatchingNotes(ctx: (Omit<NoteContext, 'metric'> & { metrics?: readonly string[] }) | null): MetricNoteDto[] {
  const notes = useProjectNotes();
  const key = JSON.stringify(ctx);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (ctx ? notesFor(notes, ctx) : NONE), [notes, key]);
}
