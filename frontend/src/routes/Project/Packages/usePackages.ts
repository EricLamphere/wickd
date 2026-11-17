import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { packagesApi, type LockEntryDto } from '../../../lib/packagesApi';
import { useProjectEvents } from '../../../lib/sse';
import { isDepsFinished, lockDiff, type LockDiff } from './packagesView';

/** The project's packages; refreshed when a proposal is accepted (packages.yml changed)
 *  and when `dbt deps` finishes (lock + dbt_packages changed). */
export function usePackages(projectId: number) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['packages', projectId],
    queryFn: () => packagesApi.list(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
  });
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'ai_proposal_updated' || isDepsFinished(event)) {
      qc.invalidateQueries({ queryKey: ['packages', projectId] });
    }
    if (isDepsFinished(event)) qc.invalidateQueries({ queryKey: ['packages-compat'] });
  }, [projectId, qc]));
  return query;
}

export type DepsState =
  | { phase: 'idle' }
  | { phase: 'running'; command: string }
  | { phase: 'done'; ok: boolean; diff: LockDiff };

/** Run `dbt deps`, then diff package-lock.yml against what it held before the run. */
export function useDepsRun(projectId: number, currentLock: LockEntryDto[] | undefined) {
  const [state, setState] = useState<DepsState>({ phase: 'idle' });
  const before = useRef<LockEntryDto[]>([]);
  const running = state.phase === 'running';

  useProjectEvents(projectId, useCallback((event) => {
    if (!running || !isDepsFinished(event)) return;
    const ok = (event.data as { return_code?: number } | undefined)?.return_code === 0;
    packagesApi.list(projectId)
      .then((fresh) => setState({ phase: 'done', ok, diff: lockDiff(before.current, fresh.lock) }))
      .catch(() => setState({ phase: 'done', ok, diff: lockDiff(before.current, before.current) }));
  }, [projectId, running]));

  const start = async (upgrade: boolean) => {
    before.current = currentLock ?? [];
    const res = await packagesApi.deps(projectId, upgrade);
    setState({ phase: 'running', command: res.command });
  };
  const dismiss = () => setState({ phase: 'idle' });
  return { state, start, dismiss };
}
