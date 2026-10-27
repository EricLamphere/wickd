import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isProFeatureRequiredError } from '../../../../lib/api';
import { lineageNotReadyReason, propagationApi } from '../../../../lib/propagationApi';
import { useProjectEvents } from '../../../../lib/sse';
import { PROPAGATION_STALE_EVENTS, retryUnlessSettled, useProEntitled } from './usePropagation';

/** The Docs Tags tab's chosen tag (`?tag=`; empty = the project's first propagating tag). */
export function useTagParam(): [string | null, (tag: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const setTag = useCallback((tag: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tag', tag);
      return next;
    });
  }, [setSearchParams]);
  return [searchParams.get('tag'), setTag];
}

/** Tag flow for `tag` (['tag-flow', id, tag]); refreshed when lineage, YAML or the manifest change. */
export function useTagFlow(projectId: number, tag: string | null) {
  const qc = useQueryClient();
  const { entitled, loading } = useProEntitled();

  useProjectEvents(projectId, useCallback((event) => {
    if (PROPAGATION_STALE_EVENTS.has(event.type)) qc.invalidateQueries({ queryKey: ['tag-flow', projectId] });
  }, [projectId, qc]));

  const query = useQuery({
    queryKey: ['tag-flow', projectId, tag],
    queryFn: () => propagationApi.tagFlow(projectId, tag ?? undefined),
    enabled: entitled,
    retry: retryUnlessSettled,
  });

  return {
    flow: query.data ?? null,
    loading: loading || (entitled && query.isLoading),
    locked: (!loading && !entitled) || isProFeatureRequiredError(query.error),
    notReady: lineageNotReadyReason(query.error),
    error: query.error,
  };
}
