import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isProFeatureRequiredError } from '../../../lib/api';
import { contractsApi, type ContractScope } from '../../../lib/contractsApi';
import { useProjectEvents } from '../../../lib/sse';
import { contractStartError } from './contractChecks';

/** Events after which a finished check may no longer describe the working copy. */
const STALE_EVENTS = new Set(['git_status_changed', 'files_changed']);

/**
 * The latest contract check (Pro) for a scope, plus start(types). Refetched on the
 * contract_check_* events; `phase` follows contract_check_progress while it runs; `stale`
 * turns on when files or git state change after it finished. `locked` = no Pro entitlement.
 */
export function useContractCheck(projectId: number, scope: ContractScope, enabled: boolean) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [lockedOnStart, setLockedOnStart] = useState(false);

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'contract_check_started') {
      setStale(false);
      setPhase(null);
      qc.invalidateQueries({ queryKey: ['contract-check', projectId] });
    }
    if (event.type === 'contract_check_progress') setPhase((event.data as { phase: string }).phase);
    if (event.type === 'contract_check_finished') {
      setPhase(null);
      qc.invalidateQueries({ queryKey: ['contract-check', projectId] });
    }
    if (STALE_EVENTS.has(event.type)) setStale(true);
  }, [projectId, qc]));

  const query = useQuery({
    queryKey: ['contract-check', projectId, scope],
    queryFn: () => contractsApi.latest(projectId, scope),
    enabled: enabled && !!projectId,
    retry: (failureCount, err) => !isProFeatureRequiredError(err) && failureCount < 2,
  });

  const start = useCallback(async (base: string | null, types: boolean) => {
    setStarting(true);
    setStartError(null);
    try {
      await contractsApi.start(projectId, scope, base, types);
      setStale(false);
      qc.invalidateQueries({ queryKey: ['contract-check', projectId, scope] });
    } catch (err) {
      if (isProFeatureRequiredError(err)) setLockedOnStart(true);
      else setStartError(contractStartError(err));
    } finally {
      setStarting(false);
    }
  }, [projectId, scope, qc]);

  const check = query.data ?? null;
  return {
    check,
    running: starting || check?.status === 'running',
    phase: phase ?? check?.phase ?? null,
    stale: stale && check?.status === 'done',
    locked: lockedOnStart || isProFeatureRequiredError(query.error),
    loadError: query.error && !isProFeatureRequiredError(query.error) ? contractStartError(query.error) : null,
    startError,
    start,
  };
}

export type ContractCheckState = ReturnType<typeof useContractCheck>;
