// One chip of the query composer (Composer.tsx). Period and comparison chips are the dashboards'
// period pickers (compact); the others are buttons: click to edit as text, ✕ to remove. A chip
// that can't apply (a draft, a `by` the widget type can't hold) is underlined red with the reason.
import { X } from 'lucide-react';
import type { ComparePeriod, CurrentPeriod } from '../../../../lib/dashboardsApi';
import { PeriodPicker } from '../dashboards/builder/PeriodPicker';
import { COMPARE_PRESETS, CURRENT_PRESETS, resolveCompare, resolveCurrent } from '../dashboards/periods';
import { chipLabel, type Chip } from '../lib/composer';
import { resourcePill } from '../../lib/resourceTypeStyle';

const KIND_CLS: Record<Chip['kind'], string> = {
  metric: resourcePill('metric'),
  time: 'border-gray-700 bg-gray-800/60 text-gray-200',
  dimension: 'border-gray-700 bg-gray-800/60 text-gray-200',
  filter: 'border-amber-900/60 bg-amber-950/30 text-amber-200 font-mono',
  period: '',
  compare: '',
  top: 'border-gray-700 bg-gray-800/60 text-gray-200',
  draft: 'border-dashed border-gray-600 text-gray-300',
};

interface Props {
  chip: Chip;
  labels: Map<string, string>;
  /** the line's period (resolving the comparison's dates) */
  current: CurrentPeriod;
  error: string | null;
  active: boolean;
  removable: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onPeriod: (chip: Chip) => void;
}

export function ComposerChip({ chip, labels, current, error, active, removable, onEdit, onRemove, onPeriod }: Props) {
  if (chip.kind === 'period') {
    return (
      <PeriodPicker compact ariaLabel="Period" label={chipLabel(chip, labels)} resolved={resolveCurrent(chip.value)} value={chip.value}
        presets={CURRENT_PRESETS} onChange={(v) => onPeriod({ kind: 'period', value: v as CurrentPeriod })} />
    );
  }
  if (chip.kind === 'compare') {
    const resolved = resolveCurrent(current);
    return (
      <PeriodPicker compact muted ariaLabel="Comparison period" label={resolved ? chipLabel(chip, labels) : 'no comparison (all time)'}
        resolved={resolveCompare(chip.value, resolved)} value={chip.value} presets={COMPARE_PRESETS}
        onChange={(v) => onPeriod({ kind: 'compare', value: v as ComparePeriod })} />
    );
  }
  const errorCls = error ? 'underline decoration-wavy decoration-red-400 underline-offset-2' : '';
  return (
    <span title={error ?? (chip.kind === 'filter' ? chip.where : 'Click to edit')}
      className={`group flex items-center gap-0.5 max-w-[22rem] pl-1.5 pr-0.5 py-0.5 text-[11px] rounded border ${KIND_CLS[chip.kind]} ${active ? 'ring-1 ring-brand-500' : ''}`}>
      <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={onEdit} className={`truncate ${errorCls}`}>
        {chipLabel(chip, labels)}
      </button>
      {removable && (
        <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={onRemove} aria-label="Remove"
          className="p-px text-gray-500 opacity-60 group-hover:opacity-100 hover:text-gray-200">
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}
