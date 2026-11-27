// Suggestions while writing a note's body (plan 33): `note:` lists notes, `model:` the project's
// dbt nodes (models, seeds, snapshots, sources), `commit:` recent commits. The node list is the
// graph query every project page shares; commits come from GET …/git/log (re-read on
// git_status_changed; a project outside git just gets no commit suggestions).
import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api';
import { useProjectEvents } from '../../../../lib/sse';
import type { Completion, CompletionSource } from '../dashboards/builder/CompletionMenu';
import { applyCompletion, rankByQuery, tokenAt } from './lib/noteMentions';
import { useNotes } from './useNotes';

const NODE_TYPES = new Set(['model', 'seed', 'snapshot', 'source']);
const COMMITS = 100;
const TITLES = { note: 'Link a note', model: 'Mention a dbt node', commit: 'Mention a commit' } as const;

export const noteCommitsKey = (projectId: number) => ['git-log', projectId, 'notes'] as const;

export function useNoteCompletions(projectId: number, editingSlug: string | null): CompletionSource {
  const qc = useQueryClient();
  const { data: notes } = useNotes(projectId);
  const { data: graph } = useQuery({ queryKey: ['graph', projectId], queryFn: () => api.models.graph(projectId) });
  const { data: log } = useQuery({
    queryKey: noteCommitsKey(projectId),
    queryFn: () => api.git.log(projectId, undefined, COMMITS),
    retry: false,
    staleTime: 30_000,
  });
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'git_status_changed') qc.invalidateQueries({ queryKey: noteCommitsKey(projectId) });
  }, [projectId, qc]));

  return useMemo<CompletionSource>(() => {
    const noteItems: Completion[] = (notes?.notes ?? [])
      .filter((n) => n.slug !== editingSlug && !n.error)
      .map((n) => ({ label: n.slug, detail: n.title, value: n.slug }));
    const nodeItems: Completion[] = (graph?.nodes ?? [])
      .filter((n) => NODE_TYPES.has(n.resource_type))
      .map((n) => ({ label: n.name, detail: n.resource_type === 'model' ? n.materialized ?? 'model' : n.resource_type, value: n.name }));
    const commitItems: Completion[] = (log?.entries ?? [])
      .map((c) => ({ label: c.short_hash, detail: `${c.message} · ${c.author}`, value: c.short_hash }));
    const pools = { note: noteItems, model: nodeItems, commit: commitItems };
    return {
      suggest: (text, caret) => {
        const token = tokenAt(text, caret);
        if (!token) return null;
        const items = rankByQuery(pools[token.kind], token.query, (c) => [c.label, c.detail ?? '']);
        return { title: TITLES[token.kind], items };
      },
      apply: (text, caret, item) => {
        const token = tokenAt(text, caret);
        return token ? applyCompletion(text, token, item.value) : null;
      },
    };
  }, [notes, graph, log, editingSlug]);
}
