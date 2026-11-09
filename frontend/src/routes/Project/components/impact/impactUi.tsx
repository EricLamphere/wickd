import { useCallback, useState } from 'react';
import { api, type ModelNode } from '../../../../lib/api';
import { buildImpactSelector, impactCountParts, type ImpactFlag, type ImpactSummary } from '../../lib/impact';
import { resourcePill } from '../../lib/resourceTypeStyle';

export const FLAG_META: Record<ImpactFlag, { label: string; title: string; cls: string }> = {
  untested: {
    label: 'untested',
    title: 'No data or unit tests — breakage here would go unnoticed',
    cls: 'bg-red-950/40 text-red-300 border-red-900/60',
  },
  exposure: {
    label: 'exposure',
    title: 'A dashboard, app or other consumer outside dbt',
    cls: resourcePill('exposure'),
  },
  metric: {
    label: 'metric',
    title: 'A metric or saved query in the semantic layer — its numbers may change',
    cls: resourcePill('metric'),
  },
  incremental: {
    label: 'incremental',
    title: 'Schema changes may need --full-refresh',
    cls: 'bg-amber-950/40 text-amber-300 border-amber-900/60',
  },
  failing: {
    label: 'failing',
    title: 'Last run errored or warned',
    cls: 'bg-red-950/40 text-red-400 border-red-900/60',
  },
  stale: {
    label: 'stale',
    title: 'Out of date since its last run',
    cls: 'bg-amber-950/30 text-amber-400 border-amber-900/50',
  },
};

export function FlagBadge({ flag, count }: { flag: ImpactFlag; count?: number }) {
  const meta = FLAG_META[flag];
  return (
    <span title={meta.title} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono ${meta.cls}`}>
      {count !== undefined && <span className="font-semibold">{count}</span>}
      {meta.label}
    </span>
  );
}

/** The downstream counts as colored pills per node type ("12 models", "38 tests"). */
export function ImpactCounts({ summary, className = '' }: { summary: ImpactSummary; className?: string }) {
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className}`} title={impactCountParts(summary).map((p) => p.label).join(' · ')}>
      {impactCountParts(summary).filter((p) => p.count > 0).map((p) => (
        <span key={p.type} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono whitespace-nowrap ${resourcePill(p.type)}`}>
          <span className="font-semibold">{p.count}</span>
          {p.label.slice(String(p.count).length + 1)}
        </span>
      ))}
    </span>
  );
}

/** Starts impact builds (`dbt build --select …`), with loading/error state. */
export function useBuildImpacted(projectId: number) {
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Build an explicit `--select` value (e.g. column-level impact's exact node list). */
  const buildSelector = useCallback(async (selector: string) => {
    if (!selector) return;
    setBuilding(true);
    setError(null);
    try {
      await api.runs.build(projectId, '', 'only', {}, selector);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start build');
    } finally {
      setBuilding(false);
    }
  }, [projectId]);

  /** Build the seeds and everything downstream of them. */
  const build = useCallback((seeds: readonly ModelNode[]) => buildSelector(buildImpactSelector(seeds)), [buildSelector]);

  return { build, buildSelector, building, error };
}
