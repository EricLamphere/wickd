import { useEffect, useMemo, useState } from 'react';
import { DataTable } from '../../../../components/DataTable';
import type { DataDiffResult, DataDiffStatus } from '../../../../lib/dataDiffApi';
import { readStored, writeStored } from '../../../../lib/stickyTab';
import { sampleTable } from '../../lib/dataDiff';

const TABS: readonly DataDiffStatus[] = ['changed', 'added', 'removed'];
const LABEL: Record<DataDiffStatus, string> = { changed: 'Changed', added: 'Added', removed: 'Removed' };

const TAB_TONE: Record<DataDiffStatus, string> = {
  changed: 'border-amber-400 text-amber-200',
  added: 'border-emerald-400 text-emerald-200',
  removed: 'border-red-400 text-red-200',
};

function restoreTab(storeKey: string, diffId: number, result: DataDiffResult | null): DataDiffStatus {
  const [id, t] = (readStored(storeKey) ?? '').split('\n');
  return id === String(diffId) && (TABS as readonly string[]).includes(t) ? t as DataDiffStatus : defaultTab(result);
}

function sampleCount(result: DataDiffResult, t: DataDiffStatus): number {
  return result.counts?.[t] ?? result.samples?.[t]?.length ?? 0;
}

const EMPTY_MESSAGE: Record<DataDiffStatus, string> = {
  changed: 'No rows were changed: every row with the same key matches in dev and prod.',
  added: 'No rows were added: dev has no keys that are missing from prod.',
  removed: 'No rows were removed: every key in prod is also in dev.',
};

/** The first status with sample rows, else Changed. */
function defaultTab(result: DataDiffResult | null): DataDiffStatus {
  return TABS.find((t) => (result?.samples?.[t] ?? []).length > 0) ?? 'changed';
}

/**
 * Sample rows per status; changed cells highlighted, dev beside prod. The tab belongs
 * to the diff (sticky as `<diff id>\n<tab>`): a new diff opens on its first non-empty status.
 */
export function DataDiffSamples({ projectId, diffId, result }: { projectId: number; diffId: number; result: DataDiffResult | null }) {
  const storeKey = `data-diff-samples-tab:${projectId}`;
  const [tab, setTabState] = useState<DataDiffStatus>(() => restoreTab(storeKey, diffId, result));
  useEffect(() => {
    setTabState(restoreTab(storeKey, diffId, result));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffId, result]);
  const setTab = (t: DataDiffStatus) => {
    setTabState(t);
    writeStored(storeKey, `${diffId}\n${t}`);
  };
  const table = useMemo(() => sampleTable(result, tab), [result, tab]);
  if (!result?.samples) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Sample rows</h3>
      <div role="tablist" className="flex items-end gap-1 border-b border-gray-800">
        {TABS.map((t) => {
          const count = sampleCount(result, t);
          const active = tab === t;
          return (
            <button key={t} role="tab" aria-selected={active} onClick={() => setTab(t)}
              className={`-mb-px flex items-center gap-1.5 px-3 py-1.5 border-b-2 rounded-t text-xs transition-colors
                ${active ? `${TAB_TONE[t]} bg-gray-800/60`
                  : `border-transparent hover:bg-gray-800/40 hover:text-gray-200 ${count > 0 ? 'text-gray-400' : 'text-gray-600'}`}`}>
              {LABEL[t]}
              <span className={`px-1.5 rounded-full text-[10px] tabular-nums ${active ? 'bg-gray-900/60' : 'bg-gray-800'}`}>
                {count.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>
      {table.rows.length === 0
        ? <p className="px-3 py-4 rounded border border-dashed border-gray-800 text-xs text-center text-gray-500">{EMPTY_MESSAGE[tab]}</p>
        : (
          <div className="max-h-80 overflow-auto rounded border border-gray-800">
            <DataTable
              columns={table.columns.map((key) => ({ key }))}
              rows={table.rows}
              cellClassName={(r, c) => (table.changed.has(`${r}:${c}`) ? 'bg-amber-950/40 text-amber-200' : undefined)}
            />
          </div>
        )}
    </section>
  );
}
