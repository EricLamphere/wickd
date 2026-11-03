import { useCallback, useMemo, useState } from 'react';
import type { GraphDto } from '../../../../lib/api';
import type { StartDataDiff } from '../../../../lib/dataDiffApi';
import { computeImpact, type Impact } from '../../lib/impact';
import { diffBadge, isDiffable, readBuildPreference, readKeys, rememberKey } from '../../lib/dataDiff';
import { useDataDiff } from '../../lib/useDataDiff';
import type { RerunOptions } from './DataDiffRerun';

/** The Impact tab's data diff (Pro): state, badges per row, the open drawer and starting diffs. */
export function useImpactDataDiff(projectId: number, graph: GraphDto | null, impact: Impact | null,
  on: boolean, scope: 'working' | 'branch', base: string | null) {
  const state = useDataDiff(projectId, on);
  const [openUid, setOpenUid] = useState<string | null>(null);

  const badges = useMemo(
    () => (on ? new Map([...state.byModel].map(([uid, d]) => [uid, diffBadge(d)])) : undefined),
    [on, state.byModel],
  );
  const diffable = useMemo(
    () => (impact?.seeds ?? []).filter((s) => isDiffable(s.node)).map((s) => s.node.unique_id),
    [impact],
  );
  const latest = state.byModel.size > 0 ? [...state.byModel.values()].at(-1) : undefined;
  const targets = latest ? { dev: latest.dev_target, prod: latest.prod_target } : null;

  const start = useCallback((uids: string[], build: boolean, extra: Partial<StartDataDiff> = {}) => {
    const remembered = readKeys(projectId);
    const keys = Object.fromEntries(uids.filter((u) => remembered[u]).map((u) => [u, remembered[u]]));
    void state.start({ unique_ids: uids, scope, base: scope === 'branch' ? base : null, keys, build, ...extra,
      ...(extra.keys ? { keys: { ...keys, ...extra.keys } } : {}) });
  }, [projectId, scope, base, state]);

  const onDataDiff = useCallback((uid: string, existing: boolean) => {
    if (existing) setOpenUid(uid);
    else start([uid], readBuildPreference());
  }, [start]);

  const rerun = useCallback((uid: string, o: RerunOptions) => {
    if (o.key) rememberKey(projectId, uid, o.key);
    start([uid], o.build, {
      keys: o.key ? { [uid]: o.key } : {}, where: o.where ? { [uid]: o.where } : {},
      mode: o.separate ? 'separate' : 'auto', tolerance: o.tolerance,
    });
  }, [projectId, start]);

  const metricsFor = useCallback((uid: string): string[] => {
    if (!graph) return [];
    const reach = computeImpact(graph, [uid]);
    return reach.levels.flatMap((l) => l.nodes).filter((n) => n.node.resource_type === 'metric').map((n) => n.node.name);
  }, [graph]);

  return {
    state, badges, diffable, targets, start, onDataDiff, rerun, metricsFor,
    open: openUid ? state.byModel.get(openUid) ?? null : null,
    close: () => setOpenUid(null),
  };
}
