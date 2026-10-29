// The metric index's and pages' chart period: a current period and what to compare it with,
// the dashboards' pickers (remembered per project by useMetricPeriod).
import type { ComparePeriod, CurrentPeriod } from '../../../../lib/dashboardsApi';
import { PeriodPicker } from '../dashboards/builder/PeriodPicker';
import { COMPARE_PRESETS, compareLabel, CURRENT_PRESETS, currentLabel, resolveCompare, resolveCurrent } from '../dashboards/periods';
import type { MetricPeriod } from '../lib/metricPage';

export function PeriodControl({ period, onChange, compare = true }: {
  period: MetricPeriod;
  onChange: (next: MetricPeriod) => void;
  /** the index has no comparison (sparklines are the current period) */
  compare?: boolean;
}) {
  const resolved = resolveCurrent(period.current);
  return (
    <div className="flex items-center gap-2">
      <PeriodPicker ariaLabel="Period" label={currentLabel(period.current)} resolved={resolved} value={period.current}
        presets={CURRENT_PRESETS} onChange={(v) => onChange({ ...period, current: v as CurrentPeriod })} />
      {compare && (
        <>
          <span className="text-[11px] text-gray-500">vs</span>
          <PeriodPicker ariaLabel="Comparison period" muted label={resolved ? compareLabel(period.compare) : 'No comparison (all time)'}
            resolved={resolveCompare(period.compare, resolved)} value={period.compare} presets={COMPARE_PRESETS}
            onChange={(v) => onChange({ ...period, compare: v as ComparePeriod })} />
        </>
      )}
    </div>
  );
}
