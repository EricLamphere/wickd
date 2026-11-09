import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api';
import { DEFER_KEY, slimSettings, type DeferMode, type SlimSettings } from '../../../../lib/slimBuild';

/** STATE_SOURCE, the sticky "Defer to prod" choice and DIFF_BASE_TARGET, from the project env vars. */
export function useSlimSettings(projectId: number): SlimSettings & { setDefer: (mode: DeferMode) => Promise<void> } {
  const qc = useQueryClient();
  const { data: envVars = [] } = useQuery({
    queryKey: ['env-vars', projectId],
    queryFn: () => api.init.getEnvVars(projectId),
  });
  const setDefer = useCallback(async (mode: DeferMode) => {
    if (mode === 'off') await api.init.deleteEnvVar(projectId, DEFER_KEY);
    else await api.init.setEnvVar(projectId, DEFER_KEY, mode);
    await qc.invalidateQueries({ queryKey: ['env-vars', projectId] });
  }, [projectId, qc]);
  return { ...slimSettings(envVars), setDefer };
}
