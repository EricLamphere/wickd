// The New note / Edit note form fields: title, date range, metric, dimension = value. The body
// editor is NoteDialog's. Dimension values are suggested from the warehouse (POST
// …/semantic/dimension-values) once a dimension is picked; any value can be typed.
import { useEffect, useMemo, useState } from 'react';
import { dashboardsApi } from '../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import type { NotePrefill } from './lib/metricNotes';

export type NoteForm = NotePrefill;

const INPUT = 'w-full px-2 py-1 rounded border border-gray-700 bg-surface-app text-xs text-gray-200 outline-none focus:border-brand-600';
const LABEL = 'flex flex-col gap-1 text-[11px] text-gray-400';

/** Dimensions offered: the metric's categorical ones, or every metric's with no metric chosen. */
function dimensionOptions(catalog: SemanticCatalogDto | undefined, metric: string | null): string[] {
  const metrics = catalog?.metrics ?? [];
  const chosen = metric ? metrics.filter((m) => m.name === metric) : metrics;
  const names = new Set<string>();
  for (const m of chosen) for (const d of m.dimensions) if (d.type !== 'time') names.add(d.name);
  return [...names].sort();
}

function useValueSuggestions(projectId: number, catalog: SemanticCatalogDto | undefined, metric: string | null, dimension: string | null) {
  const [values, setValues] = useState<string[]>([]);
  const owner = useMemo(() => metric ?? catalog?.metrics.find((m) => m.dimensions.some((d) => d.name === dimension))?.name ?? null,
    [catalog, metric, dimension]);
  useEffect(() => {
    setValues([]);
    if (!dimension || !owner) return;
    let live = true;
    dashboardsApi.dimensionValues(projectId, owner, dimension)
      .then((r) => { if (live) setValues(r.values.slice(0, 200).map((v) => String(v ?? ''))); })
      .catch(() => { /* suggestions only: typing a value still works */ });
    return () => { live = false; };
  }, [projectId, owner, dimension]);
  return values;
}

export function NoteFields({ projectId, catalog, form, onChange, errorField }: {
  projectId: number;
  catalog: SemanticCatalogDto | undefined;
  form: NoteForm;
  onChange: (next: NoteForm) => void;
  errorField: string | null;
}) {
  const metric = form.metrics[0] ?? null;
  const dims = useMemo(() => {
    const options = dimensionOptions(catalog, metric);
    return form.dimension && !options.includes(form.dimension) ? [form.dimension, ...options] : options;
  }, [catalog, metric, form.dimension]);
  const suggestions = useValueSuggestions(projectId, catalog, metric, form.dimension);
  const metricOptions = useMemo(() => {
    const names = (catalog?.metrics ?? []).map((m) => ({ name: m.name, label: m.label || m.name }));
    for (const m of form.metrics) if (!names.some((n) => n.name === m)) names.unshift({ name: m, label: `${m} (not in the semantic layer)` });
    return names;
  }, [catalog, form.metrics]);
  const bad = (field: string) => (errorField === field ? ' border-red-600' : '');
  const set = (patch: Partial<NoteForm>) => onChange({ ...form, ...patch });

  return (
    <div className="grid grid-cols-2 gap-3">
      <label className={`${LABEL} col-span-2`}>
        Title
        <input autoFocus value={form.title} onChange={(e) => set({ title: e.target.value })} maxLength={200}
          placeholder="e.g. EU checkout outage" className={INPUT + bad('title')} />
      </label>
      <label className={LABEL}>
        From
        <input type="date" value={form.start} required
          onChange={(e) => set({ start: e.target.value, end: form.end < e.target.value ? e.target.value : form.end })}
          className={INPUT + bad('start')} />
      </label>
      <label className={LABEL}>
        To (inclusive)
        <input type="date" value={form.end} min={form.start} required onChange={(e) => set({ end: e.target.value })}
          className={INPUT + bad('end')} />
      </label>
      <label className={`${LABEL} col-span-2`}>
        Metric
        <select value={metric ?? ''} onChange={(e) => set({ metrics: e.target.value ? [e.target.value] : [] })} className={INPUT + bad('metrics')}>
          <option value="">Every metric</option>
          {metricOptions.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}
        </select>
        {form.metrics.length > 1 && <span className="text-[10px] text-gray-500">This note's file lists {form.metrics.join(', ')} (picking a metric here keeps only that one).</span>}
      </label>
      <label className={LABEL}>
        Dimension (optional)
        <select value={form.dimension ?? ''} onChange={(e) => set({ dimension: e.target.value || null, value: e.target.value ? form.value : null })}
          className={INPUT + bad('dimension')}>
          <option value="">None</option>
          {dims.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </label>
      <label className={LABEL}>
        Value
        <input value={form.value ?? ''} disabled={!form.dimension} list="note-dimension-values" placeholder={form.dimension ? 'e.g. EU' : 'Pick a dimension'}
          onChange={(e) => set({ value: e.target.value })} className={`${INPUT}${bad('value')} disabled:opacity-50`} />
        <datalist id="note-dimension-values">{suggestions.map((v) => <option key={v} value={v} />)}</datalist>
      </label>
    </div>
  );
}
