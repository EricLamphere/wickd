import { useEffect } from 'react';
import { AlertTriangle, ArrowRight, Info, Loader2, X } from 'lucide-react';
import { DataTable } from '../../../../components/DataTable';
import type { DataDiffDto } from '../../../../lib/dataDiffApi';
import { formatDelta, formatPct, keySourceLabel, phaseLabel } from '../../lib/dataDiff';
import { CountBar, DiffChips } from './DataDiffSummary';
import { DataDiffSamples } from './DataDiffSamples';
import { DataDiffRerun, type RerunOptions } from './DataDiffRerun';

interface Props {
  projectId: number;
  diff: DataDiffDto;
  running: boolean;
  /** metrics downstream of the model: "Compare metrics" links (plan 14, two targets) */
  metrics: string[];
  onCompareMetric: (metric: string, prodTarget: string) => void;
  onRerun: (options: RerunOptions) => void;
  onClose: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{title}</h3>
      {children}
    </section>
  );
}

function ColumnChanges({ diff }: { diff: DataDiffDto }) {
  const cols = (diff.result?.columns ?? []).filter((c) => c.changed > 0);
  if (cols.length === 0) return null;
  return (
    <Section title="Changed columns">
      <DataTable
        columns={[{ key: 'Column' }, { key: 'Rows changed', align: 'right' }, { key: '% of matched', align: 'right' }, { key: 'Total change (dev − prod)', align: 'right' }]}
        rows={cols.map((c) => [c.name, c.changed.toLocaleString(), formatPct(c.pct), formatDelta(c.delta_sum)])}
      />
    </Section>
  );
}

function SchemaChanges({ diff }: { diff: DataDiffDto }) {
  const s = diff.result?.schema;
  if (!s || s.added.length + s.removed.length + s.retyped.length === 0) return null;
  return (
    <Section title="Schema">
      <ul className="flex flex-col gap-1 text-xs text-gray-300">
        {s.added.map((c) => <li key={`a-${c.name}`}><span className="text-emerald-300">+ {c.name}</span> <span className="text-gray-500">{c.type} · only in dev</span></li>)}
        {s.removed.map((c) => <li key={`r-${c.name}`}><span className="text-red-300">− {c.name}</span> <span className="text-gray-500">{c.type} · only in prod</span></li>)}
        {s.retyped.map((c) => (
          <li key={`t-${c.name}`} className="flex items-center gap-1.5"><span className="text-amber-300">~ {c.name}</span>
            <span className="text-gray-500 font-mono">{c.prod_type}</span><ArrowRight size={11} className="text-gray-600" /><span className="text-gray-300 font-mono">{c.dev_type}</span></li>
        ))}
      </ul>
    </Section>
  );
}

function DuplicateKeys({ diff }: { diff: DataDiffDto }) {
  const examples = diff.result?.error?.code === 'duplicate_keys' ? diff.result.error.examples ?? [] : [];
  if (examples.length === 0) return null;
  return (
    <DataTable columns={[{ key: 'Side' }, { key: `Key (${diff.key.join(', ')})` }, { key: 'Rows', align: 'right' }]}
      rows={examples.map((e) => [e.side, e.key.map(String).join(', '), e.count])} />
  );
}

/** One model's data diff: headline, counts, changed columns, schema, samples, and rerun options. */
export function DataDiffDrawer({ projectId, diff, running, metrics, onCompareMetric, onRerun, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const result = diff.result;
  const isRunning = diff.status === 'running';
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside onClick={(e) => e.stopPropagation()}
        className="flex flex-col w-[min(60rem,100%)] h-full bg-surface-panel border-l border-gray-800 shadow-2xl">
        <header className="flex items-start gap-3 px-5 py-3 border-b border-gray-800">
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <h2 className="font-mono text-sm text-gray-100 truncate">{diff.name}</h2>
            <p className="flex items-center gap-1.5 text-[11px] text-gray-500 font-mono truncate">
              <span title={`dev target: ${diff.dev_target}`}>{diff.dev_relation ?? diff.dev_target}</span>
              <ArrowRight size={11} className="shrink-0" />
              <span title={`prod target: ${diff.prod_target}`}>{diff.prod_relation ?? diff.prod_target}</span>
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-800" title="Close (Esc)"><X size={14} /></button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {isRunning ? (
            <p className="flex items-center gap-2 text-sm text-brand-300"><Loader2 size={14} className="animate-spin" />{phaseLabel(diff.phase)}</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className={`text-base ${diff.status === 'error' ? 'text-red-300' : 'text-gray-100'}`}>
                {diff.status === 'error' && <AlertTriangle size={14} className="inline mr-1.5 -mt-0.5" />}
                {diff.status === 'error' ? diff.error_message ?? result?.error?.message : result?.headline}
              </p>
              <DiffChips diff={diff} keyLabel={keySourceLabel(diff.key_source)} />
              <DuplicateKeys diff={diff} />
            </div>
          )}

          {!isRunning && diff.status === 'done' && (
            <>
              <CountBar counts={result?.counts} />
              {(result?.findings ?? []).length > 0 && (
                <ul className="flex flex-col gap-1 pl-4 list-disc marker:text-gray-600 text-xs text-gray-300">
                  {result?.findings?.map((f) => <li key={f}>{f}</li>)}
                </ul>
              )}
              <ColumnChanges diff={diff} />
              <SchemaChanges diff={diff} />
              <DataDiffSamples projectId={projectId} diffId={diff.id} result={result} />
            </>
          )}

          {metrics.length > 0 && diff.prod_target && (
            <Section title="Metrics on this model">
              <div className="flex flex-wrap gap-1.5">
                {metrics.map((m) => (
                  <button key={m} onClick={() => onCompareMetric(m, diff.prod_target ?? '')}
                    className="px-2 py-0.5 rounded border border-gray-700 text-[11px] font-mono text-gray-300 hover:border-brand-600 hover:text-brand-300"
                    title={`Compare ${m} on ${diff.dev_target} and ${diff.prod_target}`}>
                    Compare {m}
                  </button>
                ))}
              </div>
            </Section>
          )}

          {(result?.notes ?? []).length > 0 && (
            <div className="flex flex-col gap-1">
              {result?.notes?.map((n) => (
                <p key={n} className="flex items-start gap-1.5 text-[11px] text-gray-500"><Info size={11} className="mt-0.5 shrink-0" />{n}</p>
              ))}
            </div>
          )}

          <DataDiffRerun diff={diff} disabled={running} onRerun={onRerun} />
        </div>
      </aside>
    </div>
  );
}
