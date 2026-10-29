// The dashboard's settings bar: the current period, what it's compared with, the grain, and
// filters for every widget (with value suggestions). Every widget inherits these unless it
// overrides its period.
import { useCallback, useMemo } from 'react';
import type { ComparePeriod, CurrentPeriod, DashboardDoc, Grain } from '../../../../../lib/dashboardsApi';
import { dashboardsApi } from '../../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../../lib/semanticApi';
import { FilterEditor } from '../../FilterEditor';
import { groupByOptions, type GroupByOption } from '../../lib/metricQuery';
import {
  COMPARE_PRESETS, CURRENT_PRESETS, compareLabel, currentLabel, metricsInUse, resolveCompare, resolveCurrent,
} from '../dashboardModel';
import { PeriodPicker } from './PeriodPicker';

const GRAINS: { key: Grain; label: string }[] = [
  { key: 'auto', label: 'Auto' }, { key: 'day', label: 'Day' }, { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' }, { key: 'quarter', label: 'Quarter' }, { key: 'year', label: 'Year' },
];
const FIELD = 'px-2 py-1 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';

/** Group-bys of any metric on the dashboard (a filter applies to the widgets that can take it). */
export function unionOptions(catalog: SemanticCatalogDto, metrics: Iterable<string>): GroupByOption[] {
  const byName = new Map<string, GroupByOption>();
  for (const m of metrics) for (const o of groupByOptions(catalog, [m])) if (!byName.has(o.name)) byName.set(o.name, o);
  return [...byName.values()];
}

/** Suggest a dimension's values from the first metric that has it. */
export function useValueSuggest(projectId: number, catalog: SemanticCatalogDto, metrics: string[]) {
  return useCallback(async (dimension: string) => {
    const metric = metrics.find((m) => groupByOptions(catalog, [m]).some((o) => o.name === dimension));
    if (!metric) return [];
    const { values } = await dashboardsApi.dimensionValues(projectId, metric, dimension);
    return values.map(String);
  }, [projectId, catalog, metrics]);
}

interface Props {
  projectId: number;
  doc: DashboardDoc;
  catalog: SemanticCatalogDto;
  onChange: (doc: DashboardDoc) => void;
  asOf: string | null;
}

export function PeriodBar({ projectId, doc, catalog, onChange, asOf }: Props) {
  const current: CurrentPeriod = doc.period?.current ?? 'last_30_days';
  const compare: ComparePeriod = doc.period?.compare ?? 'previous_period';
  const resolved = resolveCurrent(current);
  const previous = resolveCompare(compare, resolved);
  const metrics = useMemo(() => [...metricsInUse(doc)], [doc]);
  const options = useMemo(() => unionOptions(catalog, metrics), [catalog, metrics]);
  const suggest = useValueSuggest(projectId, catalog, metrics);
  const setPeriod = (patch: Partial<{ current: CurrentPeriod; compare: ComparePeriod }>) =>
    onChange({ ...doc, period: { current, compare, ...patch } });

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <PeriodPicker ariaLabel="Current period" label={currentLabel(current)} resolved={resolved} value={current}
        presets={CURRENT_PRESETS} onChange={(v) => setPeriod({ current: v as CurrentPeriod })} />
      <span className="text-[11px] text-gray-500">vs</span>
      <PeriodPicker ariaLabel="Comparison period" muted label={resolved ? compareLabel(compare) : 'No comparison (all time)'}
        resolved={previous} value={compare} presets={COMPARE_PRESETS} onChange={(v) => setPeriod({ compare: v as ComparePeriod })} />
      <label className="flex items-center gap-1.5">
        <span className="text-[11px] text-gray-500">Grain</span>
        <select value={doc.grain ?? 'auto'} onChange={(e) => onChange({ ...doc, grain: e.target.value as Grain })} className={FIELD}>
          {GRAINS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[11px] text-gray-500">Filters</span>
        <FilterEditor filters={doc.filters ?? []} options={options} grain="day" suggest={suggest}
          onChange={(filters) => onChange({ ...doc, filters })} />
      </div>
      <div className="flex-1" />
      {asOf && <span className="text-[11px] text-gray-500">{asOf}</span>}
    </div>
  );
}
