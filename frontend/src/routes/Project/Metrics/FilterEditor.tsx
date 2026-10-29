// Filters for the Metrics page: chips for each `where`, a builder (dimension / operator /
// value) and an Advanced free-text mode with Dimension() suggestions.
import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { FILTER_OPS, buildFilter, filterLabel, type FilterOp, type GroupByOption } from './lib/metricQuery';

interface Props {
  filters: string[];
  options: GroupByOption[];
  grain: string;
  onChange: (filters: string[]) => void;
  /** a categorical dimension's values, to suggest while typing a filter value */
  suggest?: (dimension: string) => Promise<string[]>;
}

const NO_VALUE = new Set<FilterOp>(['is null', 'is not null']);
const FIELD_CLS = 'px-2 py-1 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';

function templateFor(o: GroupByOption, grain: string): string {
  return o.kind === 'time' ? `{{ TimeDimension('${o.name}', '${grain}') }}` : `{{ Dimension('${o.name}') }}`;
}

/** Suggestions for the dimension's values (fetched once per dimension while the builder is open). */
function useSuggestions(dimension: string, enabled: boolean, suggest?: Props['suggest']) {
  const [values, setValues] = useState<string[]>([]);
  useEffect(() => {
    setValues([]);
    if (!enabled || !suggest || !dimension) return;
    let live = true;
    suggest(dimension).then((v) => { if (live) setValues(v); }).catch(() => {});
    return () => { live = false; };
  }, [dimension, enabled, suggest]);
  return values;
}

function Builder({ options, grain, onAdd, onClose, suggest }: {
  options: GroupByOption[]; grain: string; onAdd: (w: string) => void; onClose: () => void; suggest?: Props['suggest'];
}) {
  const [advanced, setAdvanced] = useState(false);
  const [dimension, setDimension] = useState(options.find((o) => o.kind === 'categorical')?.name ?? options[0]?.name ?? '');
  const [op, setOp] = useState<FilterOp>('=');
  const [value, setValue] = useState('');
  const [text, setText] = useState('');
  const option = options.find((o) => o.name === dimension);
  const suggestions = useSuggestions(dimension, !advanced && option?.kind === 'categorical', suggest);
  const listId = `filter-values-${dimension}`;
  const ready = advanced ? text.trim().length > 0 : !!option && (NO_VALUE.has(op) || value.trim().length > 0);
  const add = () => {
    if (!ready) return;
    onAdd(advanced ? text.trim() : buildFilter(option as GroupByOption, op, value, grain));
    onClose();
  };

  return (
    <div className="absolute z-30 top-full left-0 mt-1 w-[26rem] p-3 flex flex-col gap-2 bg-surface-elevated border border-gray-700 rounded shadow-xl"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } }}>
      {advanced ? (
        <>
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3}
            placeholder="{{ Dimension('customer__country') }} = 'US'" className={`${FIELD_CLS} font-mono resize-y`} />
          <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
            {options.map((o) => (
              <button key={o.name} onClick={() => setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${templateFor(o, grain)}`)}
                className="px-1.5 py-0.5 text-[10px] font-mono rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500">
                {o.name}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="flex gap-2">
          <select value={dimension} onChange={(e) => setDimension(e.target.value)} className={`${FIELD_CLS} flex-1 min-w-0`}>
            {options.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
          </select>
          <select value={op} onChange={(e) => setOp(e.target.value as FilterOp)} className={FIELD_CLS}>
            {FILTER_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          {!NO_VALUE.has(op) && (
            <>
              <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} list={suggestions.length ? listId : undefined}
                placeholder={op.includes('in') ? 'a, b, c' : option?.kind === 'time' ? 'YYYY-MM-DD' : 'value'}
                className={`${FIELD_CLS} w-32`} />
              {suggestions.length > 0 && (
                <datalist id={listId}>{suggestions.slice(0, 200).map((v) => <option key={v} value={v} />)}</datalist>
              )}
            </>
          )}
        </div>
      )}
      <div className="flex items-center justify-between">
        <button onClick={() => setAdvanced((a) => !a)} className="text-[11px] text-gray-500 hover:text-gray-300">
          {advanced ? 'Use the builder' : 'Advanced (MetricFlow where)'}
        </button>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
          <button onClick={add} disabled={!ready} className="px-2.5 py-1 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
            Add filter
          </button>
        </div>
      </div>
    </div>
  );
}

export function FilterEditor({ filters, options, grain, onChange, suggest }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={ref} className="relative flex flex-wrap items-center gap-1.5">
      {filters.map((f, i) => (
        <span key={`${i}-${f}`} title={f} className="flex items-center gap-1 max-w-[20rem] px-2 py-0.5 text-[11px] font-mono rounded border border-gray-700 bg-gray-800/60 text-gray-300">
          <span className="truncate">{filterLabel(f)}</span>
          <button onClick={() => onChange(filters.filter((_, j) => j !== i))} className="text-gray-500 hover:text-gray-200" aria-label="Remove filter">
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <button onClick={() => setOpen((o) => !o)} disabled={!options.length}
        className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-dashed border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 disabled:opacity-40">
        <Plus className="w-3 h-3" />Filter
      </button>
      {open && <Builder options={options} grain={grain} onAdd={(w) => onChange([...filters, w])} onClose={() => setOpen(false)} suggest={suggest} />}
    </div>
  );
}
