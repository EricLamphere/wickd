// A picked value's data: the widget's query narrowed to it — over time (the drill-down), broken
// down by another dimension or as one aggregate — for the current and (when compared) previous
// period. Served from stored results when there are any (`cache: prefer`), else one small
// `dbt show` each.
import { useQuery } from '@tanstack/react-query';
import type { WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { semanticApi } from '../../../../../lib/semanticApi';
import { drillBodies, type Pick, type QueryPair } from '../drill';

export function useQueryPair(projectId: number, bodies: QueryPair | null) {
  return useQuery({
    queryKey: ['dashboard-drill', projectId, bodies ? JSON.stringify(bodies) : null],
    queryFn: async () => {
      const b = bodies!;
      const [current, previous] = await Promise.all([
        semanticApi.query(projectId, { ...b.current, cache: 'prefer' }),
        b.previous ? semanticApi.query(projectId, { ...b.previous, cache: 'prefer' }) : Promise.resolve(null),
      ]);
      return { current, previous };
    },
    enabled: !!bodies,
    retry: false,
    staleTime: 60_000,
  });
}

export function useDrill(projectId: number, result: WidgetResultDto | undefined, pick: Pick | null) {
  return useQueryPair(projectId, result && pick ? drillBodies(result, pick) : null);
}
