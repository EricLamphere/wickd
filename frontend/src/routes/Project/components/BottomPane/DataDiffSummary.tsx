import type { DataDiffCounts, DataDiffDto } from '../../../../lib/dataDiffApi';
import { countSegments, type BarSegment } from '../../lib/dataDiff';

const SEGMENT: Record<BarSegment['status'], { bar: string; text: string; label: string }> = {
  unchanged: { bar: 'bg-gray-600', text: 'text-gray-400', label: 'unchanged' },
  changed: { bar: 'bg-amber-400', text: 'text-amber-300', label: 'changed' },
  added: { bar: 'bg-emerald-400', text: 'text-emerald-300', label: 'added (dev only)' },
  removed: { bar: 'bg-red-400', text: 'text-red-300', label: 'removed (prod only)' },
};

/** Proportions of unchanged / changed / added / removed rows, with the counts underneath. */
export function CountBar({ counts }: { counts: DataDiffCounts | undefined }) {
  const segments = countSegments(counts);
  if (segments.length === 0) {
    return counts ? (
      <p className="text-xs text-gray-400 tabular-nums">
        {(counts.dev_rows ?? 0).toLocaleString()} rows in dev · {(counts.prod_rows ?? 0).toLocaleString()} rows in prod
      </p>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-2 rounded-full overflow-hidden bg-gray-800">
        {segments.map((s) => <span key={s.status} className={SEGMENT[s.status].bar} style={{ width: `${Math.max(s.pct, 0.5)}%` }} />)}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] tabular-nums">
        {segments.map((s) => (
          <span key={s.status} className={SEGMENT[s.status].text}>{s.count.toLocaleString()} {SEGMENT[s.status].label}</span>
        ))}
      </div>
    </div>
  );
}

const CHIP = 'inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] border-gray-700 bg-gray-800/60 text-gray-300';

/** What the diff compared: strategy, key, rows read, sampling, filter, whether dev was built first. */
export function DiffChips({ diff, keyLabel }: { diff: DataDiffDto; keyLabel: string }) {
  const r = diff.result;
  const mode = r?.mode ?? diff.mode;
  const scanned = r?.scanned;
  return (
    <div className="flex flex-wrap gap-1.5">
      {mode && (
        <span className={CHIP} title={mode === 'joined' ? 'One query joined dev and prod in the warehouse' : 'Each side read on its own connection; only differing buckets of rows were fetched'}>
          {mode === 'joined' ? 'compared in-warehouse' : 'compared across connections'}
        </span>
      )}
      {diff.key.length > 0
        ? <span className={`${CHIP} font-mono`}>key: {diff.key.join(', ')}{keyLabel ? <span className="ml-1 font-sans text-gray-500">· {keyLabel}</span> : null}</span>
        : diff.status === 'done' && <span className={CHIP}>no key: counts and schema only</span>}
      {scanned?.dev_rows != null && (
        <span className={`${CHIP} tabular-nums`}>
          read {scanned.dev_rows.toLocaleString()} dev · {(scanned.prod_rows ?? 0).toLocaleString()} prod rows
          {scanned.fetched_rows ? ` · fetched ${scanned.fetched_rows.toLocaleString()}` : ''}
        </span>
      )}
      {r?.estimated && <span className={`${CHIP} border-amber-900/60 bg-amber-950/40 text-amber-300`}>estimated</span>}
      {diff.where && <span className={`${CHIP} font-mono`} title={diff.where}>where {diff.where}</span>}
      {diff.built && <span className={CHIP}>built in dev first</span>}
    </div>
  );
}
