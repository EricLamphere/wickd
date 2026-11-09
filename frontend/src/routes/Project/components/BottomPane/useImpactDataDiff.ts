import { useCallback, useMemo, useState } from 'react';
import type { GraphDto } from '../../../../lib/api';
import type { StartDataDiff } from '../../../../lib/dataDiffApi';
import { computeImpact, type Impact } from '../../lib/impact';
import { diffBadge, diffRequest, isDiffable, readBuildPreference, readKeys, rememberKey, summarizeDiffs } from '../../lib/dataDiff';
import { dismissBuildNudge } from '../../lib/buildNudge';
import { useDataDiff } from '../../lib/useDataDiff';
import type { RerunOptions } from './DataDiffRerun';

/**
 * The Impact tab's data diff (Pro): state, badges per row, a summary of the changed models'
 * latest diffs, the open drawer and starting diffs. `inChangeMode` = Uncommitted / Branch with
 * changes, where the Data diff section and column show; the drawer opens in any mode.
 */
export function useImpactDataDiff(projectId: number, graph: GraphDto | null, impact: Impact | null,
  inChangeMode: boolean, scope: 'working' | 'branch', base: string | null) {
  const state = useDataDiff(projectId, true);
  const [openUid, setOpenUid] = useState<string | null>(null);

  const badges = useMemo(
    () => (inChangeMode ? new Map([...state.byModel].map(([uid, d]) => [uid, diffBadge(d)])) : undefined),
    [inChangeMode, state.byModel],
  );
  const diffable = useMemo(
    () => (impact?.seeds ?? []).filter((s) => isDiffable(s.node)).map((s) => s.node.unique_id),
    [impact],
  );
  // the changed models plus every diffable model downstream of them
  const diffableImpacted = useMemo(
    () => [...(impact?.seeds ?? []), ...(impact?.levels ?? []).flatMap((l) => l.nodes)]
      .filter((n) => isDiffable(n.node)).map((n) => n.node.unique_id),
    [impact],
  );
  const summary = useMemo(() => summarizeDiffs(state.byModel, diffableImpacted), [state.byModel, diffableImpacted]);
  const latest = state.byModel.size > 0 ? [...state.byModel.values()].at(-1) : undefined;
  const targets = latest ? { dev: latest.dev_target, prod: latest.prod_target } : null;

  const start = useCallback((uids: string[], build: boolean, extra: Partial<StartDataDiff> = {}) => {
    dismissBuildNudge(projectId);
    const req = diffRequest(readKeys(projectId), uids, build, scope, base);
    void state.start({ ...req, ...extra, ...(extra.keys ? { keys: { ...req.keys, ...extra.keys } } : {}) });
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
    state, badges, diffable, diffableImpacted, summary, targets, start, onDataDiff, rerun, metricsFor,
    open: openUid ? state.byModel.get(openUid) ?? null : null,
    openModel: setOpenUid,
    close: () => setOpenUid(null),
  };
}
