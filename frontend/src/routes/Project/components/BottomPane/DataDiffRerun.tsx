import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { DataDiffDto } from '../../../../lib/dataDiffApi';
import { parseKeyInput } from '../../lib/dataDiff';

export interface RerunOptions {
  key: string[] | null;
  where: string;
  separate: boolean;
  tolerance: number;
  build: boolean;
}

const INPUT = 'px-2 py-1 rounded border border-gray-700 bg-surface-elevated text-xs font-mono text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-brand-600';

/** Change the key, filter, strategy or tolerance and diff the model again. */
export function DataDiffRerun({ diff, disabled, onRerun }: { diff: DataDiffDto; disabled: boolean; onRerun: (o: RerunOptions) => void }) {
  const [key, setKey] = useState(diff.key.join(', '));
  const [where, setWhere] = useState(diff.where ?? '');
  const [separate, setSeparate] = useState(false);
  const [tolerance, setTolerance] = useState('0');
  const [build, setBuild] = useState(false);
  const submit = () => {
    const parsed = parseKeyInput(key);
    onRerun({
      key: parsed.length > 0 ? parsed : null,
      where: where.trim(), separate, tolerance: Math.max(0, Number(tolerance) || 0), build,
    });
  };
  return (
    <section className="flex flex-col gap-2 pt-4 border-t border-gray-800">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Diff again</h3>
      <div className="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-2 text-xs text-gray-400">
        <label htmlFor="dd-key">Key columns</label>
        <input id="dd-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. order_id, line_number" className={INPUT}
          title="Columns that identify a row on both sides, comma-separated. Remembered for this model." />
        <label htmlFor="dd-where">Filter</label>
        <input id="dd-where" value={where} onChange={(e) => setWhere(e.target.value)} placeholder="e.g. order_date >= '2026-10-01'" className={INPUT}
          title="A SQL condition applied to both sides (useful for incremental models)" />
        <label htmlFor="dd-tol">Numeric tolerance</label>
        <input id="dd-tol" type="number" min={0} step="any" value={tolerance} onChange={(e) => setTolerance(e.target.value)} className={`${INPUT} w-32`}
          title="Numbers closer than this count as equal (floats already ignore rounding noise)" />
      </div>
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-gray-400">
        <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Read each side on its own connection even if dev can read prod">
          <input type="checkbox" checked={separate} onChange={() => setSeparate(!separate)} className="accent-brand-500" />Compare across connections
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input type="checkbox" checked={build} onChange={() => setBuild(!build)} className="accent-brand-500" />Build in dev first
        </label>
        <button onClick={submit} disabled={disabled}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-gray-700 text-gray-300 hover:border-brand-600 hover:text-brand-300 disabled:opacity-40">
          <RefreshCw size={12} />Diff again
        </button>
      </div>
    </section>
  );
}
