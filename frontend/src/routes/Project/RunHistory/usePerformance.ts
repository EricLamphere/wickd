import { useQuery } from '@tanstack/react-query';
import { api, isProFeatureRequiredError } from '../../../lib/api';

/** Pro entitlement from the shared ['license'] query. */
export function useProEntitled(): { entitled: boolean; loading: boolean } {
  const { data, isLoading } = useQuery({ queryKey: ['license'], queryFn: () => api.license.get() });
  return { entitled: data?.entitled ?? false, loading: isLoading };
}

const noRetryOnLock = (count: number, err: unknown) => !isProFeatureRequiredError(err) && count < 2;

/** One run's Pro analysis; invalidated on statuses_changed (RunHistory/index.tsx). */
export function useRunAnalysis(projectId: number, invocationId: number, enabled: boolean) {
  return useQuery({
    queryKey: ['run-analysis', projectId, invocationId],
    queryFn: () => api.runHistory.analysis(projectId, invocationId),
    enabled,
    retry: noRetryOnLock,
    staleTime: 30_000,
  });
}

export function useProjectPerformance(projectId: number, command: string, enabled: boolean) {
  return useQuery({
    queryKey: ['performance', projectId, command],
    queryFn: () => api.performance.project(projectId, { command: command || undefined }),
    enabled,
    retry: noRetryOnLock,
    staleTime: 30_000,
  });
}
