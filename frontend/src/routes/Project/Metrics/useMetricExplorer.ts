// Data for the Metrics page: the semantic catalog and the active dbt target.
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { semanticApi } from '../../../lib/semanticApi';
import { useProjectEvents } from '../../../lib/sse';

/** ['semantic-catalog', id]: metrics, their group-bys and saved queries; refetched after a parse. */
export function useSemanticCatalog(projectId: number, enabled: boolean) {
  const qc = useQueryClient();
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'graph_changed') qc.invalidateQueries({ queryKey: ['semantic-catalog', projectId] });
  }, [projectId, qc]));
  return useQuery({
    queryKey: ['semantic-catalog', projectId],
    queryFn: () => semanticApi.catalog(projectId),
    enabled: enabled && !!projectId,
    retry: false,
    staleTime: 60_000,
  });
}

/** ['dbt-target', id]: the active target, shown on the Run button (shared with the Header). */
export function useActiveTarget(projectId: number) {
  return useQuery({
    queryKey: ['dbt-target', projectId],
    queryFn: () => api.profiles.getDbtTarget(projectId),
    enabled: !!projectId,
    refetchInterval: false,
  });
}
