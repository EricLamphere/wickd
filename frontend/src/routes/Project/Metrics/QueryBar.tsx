// The Metrics page's query controls: metrics, group by, grain, filters, dates, order, limit, Run.
import { Bookmark, Loader2, Play, Square, X } from 'lucide-react';
import { FilterDropdown } from '../components/FilterDropdown';
import { FilterEditor } from './FilterEditor';
import { DATE_PRESETS, allowedGrains, presetRange, type ExplorerState, type GroupByOption } from './lib/metricQuery';

interface Props {
  state: ExplorerState;
  options: GroupByOption[];
  labels: Map<string, string>;
  onChange: (patch: Partial<ExplorerState>) => void;
  target: string | null;
  running: boolean;
  canRun: boolean;
  onRun: () => void;
  onCancel: () => void;
  onSave: (() => void) | null;
}

const FIELD_CLS = 'px-2 py-1 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';
const LABEL_CLS = 'text-[11px] text-gray-500';

function presetFor(start: string, end: string): string {
  if (!start && !end) return 'all';
  return DATE_PRESETS.find((p) => { const r = presetRange(p.key); return r.start === start && r.end === end; })?.key ?? 'custom';
}

function OrderSelect({ state, options, onChange }: Pick<Props, 'state' | 'options' | 'onChange'>) {
  const names = [...state.groupBy.filter((g) => options.some((o) => o.name === g)), ...state.metrics];
  const value = state.orderBy[0] ?? '';
  return (
    <select value={value} onChange={(e) => onChange({ orderBy: e.target.value ? [e.target.value] : [] })} className={FIELD_CLS}>
      <option value="">Default</option>
      {names.flatMap((n) => [
        <option key={`-${n}`} value={`-${n}`}>{n} ↓</option>,
        <option key={n} value={n}>{n} ↑</option>,
      ])}
    </select>
  );
}

export function QueryBar({ state, options, labels, onChange, target, running, canRun, onRun, onCancel, onSave }: Props) {
  const timeSelected = state.groupBy.some((g) => options.find((o) => o.name === g)?.kind === 'time');
  const grains = allowedGrains(options, state.groupBy);
  const preset = presetFor(state.start, state.end);

  return (
    <div className="flex flex-col gap-2.5 px-4 py-3 border-b border-gray-800 bg-surface-panel">
      <div className="flex items-start gap-3">
        <div className="flex flex-1 flex-wrap items-center gap-1.5 min-w-0">
          {state.savedQuery ? (
            <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded border border-brand-800 bg-brand-950/40 text-brand-200">
              <Bookmark className="w-3 h-3" />Saved query: {labels.get(`saved:${state.savedQuery}`) ?? state.savedQuery}
              <button onClick={() => onChange({ savedQuery: null })} aria-label="Close saved query" className="text-brand-300 hover:text-white"><X className="w-3 h-3" /></button>
            </span>
          ) : state.metrics.length === 0 ? (
            <span className="text-xs text-gray-500">Pick one or more metrics on the left.</span>
          ) : state.metrics.map((m) => (
            <span key={m} className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-gray-700 bg-gray-800/60 text-gray-200">
              {labels.get(m) ?? m}
              <button onClick={() => onChange({ metrics: state.metrics.filter((x) => x !== m) })} aria-label={`Remove ${m}`} className="text-gray-500 hover:text-gray-200">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onSave && (
            <button onClick={onSave} title="Write this query to your YAML as a dbt saved query"
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500">
              <Bookmark className="w-3.5 h-3.5" />Save as saved query…
            </button>
          )}
          {running ? (
            <button onClick={onCancel} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-red-900/60 text-red-300 hover:bg-red-950/40">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /><Square className="w-3 h-3" />Cancel
            </button>
          ) : (
            <button onClick={onRun} disabled={!canRun} title="Run on the warehouse (⌘↵)"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
              <Play className="w-3.5 h-3.5" />Run{target ? ` on ${target}` : ''}
              <kbd className="ml-1 text-[10px] text-brand-200">⌘↵</kbd>
            </button>
          )}
        </div>
      </div>

      {!state.savedQuery && state.metrics.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <span className={LABEL_CLS}>Group by</span>
            <FilterDropdown
              label={state.groupBy.length ? `${state.groupBy.length} selected` : 'None'}
              options={options.map((o) => o.name)}
              selected={new Set(state.groupBy)}
              onChange={(next) => onChange({ groupBy: options.map((o) => o.name).filter((n) => next.has(n)) })}
            />
            {state.groupBy.map((g) => <span key={g} className="text-[11px] font-mono text-gray-400">{g}</span>)}
          </div>
          {timeSelected && (
            <label className="flex items-center gap-2">
              <span className={LABEL_CLS}>Grain</span>
              <select value={grains.includes(state.grain) ? state.grain : grains[0]} onChange={(e) => onChange({ grain: e.target.value })} className={FIELD_CLS}>
                {grains.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2">
            <span className={LABEL_CLS}>Dates</span>
            <select value={preset} onChange={(e) => { if (e.target.value !== 'custom') onChange(presetRange(e.target.value)); }} className={FIELD_CLS}>
              {DATE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              {preset === 'custom' && <option value="custom">Custom</option>}
            </select>
            <input type="date" value={state.start} onChange={(e) => onChange({ start: e.target.value })} className={FIELD_CLS} aria-label="Start date" />
            <span className="text-gray-600">–</span>
            <input type="date" value={state.end} onChange={(e) => onChange({ end: e.target.value })} className={FIELD_CLS} aria-label="End date" />
          </label>
          <label className="flex items-center gap-2">
            <span className={LABEL_CLS}>Order</span>
            <OrderSelect state={state} options={options} onChange={onChange} />
          </label>
          <label className="flex items-center gap-2">
            <span className={LABEL_CLS}>Limit</span>
            <input type="number" min={1} max={5000} value={state.limit ?? ''} placeholder="5000"
              onChange={(e) => onChange({ limit: Number(e.target.value) > 0 ? Math.min(5000, Math.floor(Number(e.target.value))) : null })}
              className={`${FIELD_CLS} w-20`} />
          </label>
          <div className="flex items-center gap-2 basis-full">
            <span className={LABEL_CLS}>Filters</span>
            <FilterEditor filters={state.filters} options={options} grain={state.grain} onChange={(filters) => onChange({ filters })} />
          </div>
        </div>
      )}
    </div>
  );
}
