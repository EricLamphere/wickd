// A widget's type-specific settings (the right rail's Configure tab, under the shared ones).
// Option names match the backend's dashboard_plan.py *Options models.
import type { DashboardWidget } from '../../../../../lib/dashboardsApi';
import { opt, withOption } from '../dashboardModel';

export const FIELD = 'w-full px-2 py-1 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';

export function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-gray-500">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-gray-600">{hint}</span>}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-brand-500" />
      {label}
    </label>
  );
}

function Select({ value, options, onChange, allowNone }: {
  value: string | null; options: { value: string; label: string }[]; onChange: (v: string | null) => void; allowNone?: string;
}) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} className={FIELD}>
      {allowNone !== undefined && <option value="">{allowNone}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function NumberInput({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <input type="number" min={min} max={max} value={value} className={FIELD}
      onChange={(e) => { const n = Math.floor(Number(e.target.value)); if (n >= min && n <= max) onChange(n); }} />
  );
}

const LAYOUTS = [
  { value: 'auto', label: 'Auto (split when scales differ 10×)' }, { value: 'combined', label: 'One chart' },
  { value: 'separate', label: 'One chart per metric' },
];
const GRAINS = ['auto', 'day', 'week', 'month', 'quarter', 'year'].map((g) => ({ value: g, label: g === 'auto' ? 'Dashboard grain' : g }));

interface Props {
  widget: DashboardWidget;
  dimensions: string[];
  onChange: (w: DashboardWidget) => void;
}

function FormatOptions({ widget, onChange }: Omit<Props, 'dimensions'>) {
  const set = (k: string, v: unknown) => onChange(withOption(widget, k, v));
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Row label="Format">
          <Select value={opt(widget, 'format', 'number')} onChange={(v) => set('format', v === 'number' ? null : v)}
            options={[{ value: 'number', label: 'Number' }, { value: 'currency', label: 'Currency' }, { value: 'percent', label: 'Percent' }]} />
        </Row>
        <Row label="Decimals">
          <Select value={String(opt<number | null>(widget, 'decimals', null) ?? '')} allowNone="Auto"
            onChange={(v) => set('decimals', v === null ? null : Number(v))}
            options={[0, 1, 2, 3].map((n) => ({ value: String(n), label: String(n) }))} />
        </Row>
      </div>
      {opt<string>(widget, 'format', 'number') === 'currency' && (
        <Row label="Currency code">
          <input value={opt(widget, 'currency', 'USD')} maxLength={3} className={FIELD}
            onChange={(e) => set('currency', e.target.value.toUpperCase() === 'USD' ? null : e.target.value.toUpperCase())} />
        </Row>
      )}
    </>
  );
}

export function TypeOptions({ widget, dimensions, onChange }: Props) {
  const set = (k: string, v: unknown) => onChange(withOption(widget, k, v));
  const dims = dimensions.map((d) => ({ value: d, label: d }));
  switch (widget.type) {
    case 'summary':
      return (
        <>
          <FormatOptions widget={widget} onChange={onChange} />
          <Toggle label="Higher is better (green when it goes up)" checked={opt(widget, 'higher_is_better', true)}
            onChange={(v) => set('higher_is_better', v ? null : false)} />
          <Toggle label="Show the trend" checked={opt(widget, 'trend', true)} onChange={(v) => set('trend', v ? null : false)} />
        </>
      );
    case 'timeseries':
      return (
        <>
          <Row label="Style">
            <Select value={opt(widget, 'style', 'line')} onChange={(v) => set('style', v === 'line' ? null : v)}
              options={[{ value: 'line', label: 'Line' }, { value: 'area', label: 'Area' }, { value: 'stacked', label: 'Stacked area' }]} />
          </Row>
          <Row label="Grain"><Select value={opt(widget, 'grain', 'auto')} options={GRAINS} onChange={(v) => set('grain', v === 'auto' ? null : v)} /></Row>
          <Row label="Split by" hint="One line per value (top N); the comparison isn't drawn when split.">
            <Select value={opt<string | null>(widget, 'split_by', null)} options={dims} allowNone="Don't split" onChange={(v) => set('split_by', v)} />
          </Row>
          {opt<string | null>(widget, 'split_by', null) && (
            <Row label="Top N values"><NumberInput value={opt(widget, 'top_n', 5)} min={1} max={20} onChange={(v) => set('top_n', v)} /></Row>
          )}
          <Row label="Several metrics"><Select value={opt(widget, 'layout', 'auto')} options={LAYOUTS} onChange={(v) => set('layout', v === 'auto' ? null : v)} /></Row>
          <Toggle label="Start the y-axis at zero" checked={opt(widget, 'zero_baseline', true)} onChange={(v) => set('zero_baseline', v ? null : false)} />
          <FormatOptions widget={widget} onChange={onChange} />
        </>
      );
    case 'bar':
      return (
        <>
          <Row label="Bars by"><Select value={opt<string | null>(widget, 'dimension', null)} options={dims} allowNone="Pick a dimension" onChange={(v) => set('dimension', v)} /></Row>
          <Row label="Stack by" hint="Stacked bars don't show the comparison.">
            <Select value={opt<string | null>(widget, 'stack_by', null)} options={dims.filter((d) => d.value !== opt(widget, 'dimension', ''))}
              allowNone="Don't stack" onChange={(v) => set('stack_by', v)} />
          </Row>
          <div className="grid grid-cols-2 gap-2">
            <Row label="Orientation">
              <Select value={opt(widget, 'orientation', 'vertical')} onChange={(v) => set('orientation', v === 'vertical' ? null : v)}
                options={[{ value: 'vertical', label: 'Vertical' }, { value: 'horizontal', label: 'Horizontal' }]} />
            </Row>
            <Row label="Sort">
              <Select value={opt(widget, 'sort', 'value')} onChange={(v) => set('sort', v === 'value' ? null : v)}
                options={[{ value: 'value', label: 'By value' }, { value: 'name', label: 'By name' }]} />
            </Row>
          </div>
          <Row label="Top N bars"><NumberInput value={opt(widget, 'top_n', 10)} min={1} max={50} onChange={(v) => set('top_n', v)} /></Row>
          <Row label="Several metrics"><Select value={opt(widget, 'layout', 'auto')} options={LAYOUTS} onChange={(v) => set('layout', v === 'auto' ? null : v)} /></Row>
          <FormatOptions widget={widget} onChange={onChange} />
        </>
      );
    case 'leaderboard':
      return (
        <>
          <Row label="Rank"><Select value={opt<string | null>(widget, 'dimension', null)} options={dims} allowNone="Pick a dimension" onChange={(v) => set('dimension', v)} /></Row>
          <Row label="Top N"><NumberInput value={opt(widget, 'top_n', 10)} min={1} max={50} onChange={(v) => set('top_n', v)} /></Row>
          <Toggle label="Show the change vs the previous period" checked={opt(widget, 'show_change', true)} onChange={(v) => set('show_change', v ? null : false)} />
          <Toggle label="Higher is better" checked={opt(widget, 'higher_is_better', true)} onChange={(v) => set('higher_is_better', v ? null : false)} />
          <FormatOptions widget={widget} onChange={onChange} />
        </>
      );
    case 'table': {
      const chosen: string[] = opt(widget, 'dimensions', []);
      return (
        <>
          <Row label="Rows by" hint="Up to 5 dimensions; none = one row of totals.">
            <div className="flex flex-col gap-1 max-h-40 overflow-auto">
              {dimensions.map((d) => (
                <Toggle key={d} label={d} checked={chosen.includes(d)}
                  onChange={(v) => set('dimensions', v ? [...chosen, d].slice(0, 5) : chosen.filter((x) => x !== d))} />
              ))}
            </div>
          </Row>
          <Row label="Rows"><NumberInput value={opt(widget, 'limit', 50)} min={1} max={500} onChange={(v) => set('limit', v)} /></Row>
          <Toggle label="Comparison columns (previous, change)" checked={opt(widget, 'compare_columns', true)}
            onChange={(v) => set('compare_columns', v ? null : false)} />
        </>
      );
    }
    case 'text':
      return (
        <Row label="Text" hint="# Heading, ## Smaller heading, - bullet, **bold**">
          <textarea value={opt(widget, 'body', '')} rows={8} onChange={(e) => set('body', e.target.value)} className={`${FIELD} font-mono resize-y`} />
        </Row>
      );
    default:
      return null;
  }
}
