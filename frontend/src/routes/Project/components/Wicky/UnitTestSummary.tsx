import { useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { DataTable } from '../../../../components/DataTable';
import type { AiProposalDto, RowsTable } from '../../../../lib/aiApi';

export const UNIT_TEST_KINDS = new Set(['unit_test', 'unit_test_rebaseline']);

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** One line for the chat: which test, how many rows, which branches. */
export function UnitTestResultLine({ p }: { p: AiProposalDto }) {
  const r = p.result;
  if (!r.unit_test) return null;
  if (r.rebaseline) {
    return (
      <span className="text-gray-400">
        <code className="text-brand-300">{r.unit_test.name}</code> expects {plural(r.actual?.rows.length ?? 0, 'row')} the model produced.
      </span>
    );
  }
  const given = (r.fixtures ?? []).reduce((n, f) => n + f.rows.length, 0);
  return (
    <div className="flex flex-col gap-1 mt-1 text-gray-400">
      <span>
        <code className="text-brand-300">{r.unit_test.name}</code> · {plural(given, 'input row')} → {plural(r.expected?.rows.length ?? 0, 'expected row')}
        {r.masked && <span className="text-gray-500"> · text masked</span>}
      </span>
      {(r.branches ?? []).length > 0 && (
        <span className="text-gray-500">Aims at: {(r.branches ?? []).slice(0, 4).map((b) => <code key={b} className="mr-1.5">{b}</code>)}</span>
      )}
      {(r.notes ?? []).map((n) => <span key={n} className="text-gray-500">{n}</span>)}
    </div>
  );
}

function Table({ title, table }: { title: string; table: RowsTable }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-[11px] text-gray-400">{title} <span className="text-gray-600">· {plural(table.rows.length, 'row')}</span></span>
      {table.rows.length === 0
        ? <span className="text-[11px] text-gray-600">No rows</span>
        : <div className="max-h-40 overflow-auto rounded border border-gray-800"><DataTable columns={table.columns.map((c) => ({ key: c }))} rows={table.rows} /></div>}
    </div>
  );
}

function SampleRows({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 self-start text-xs text-gray-400 hover:text-gray-200"
      >
        <ChevronRight size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        {label}
      </button>
      {open && children}
    </div>
  );
}

/** Above the YAML diff in review: the warnings that matter before these rows land in the
 *  repo, and (collapsed) the rows given to each input and the rows expected. */
export function UnitTestReviewPanel({ p }: { p: AiProposalDto }) {
  const r = p.result;
  if (r.rebaseline) {
    return (
      <div className="px-4 py-3 border-b border-gray-800">
        <SampleRows label={`Rows · ${plural(r.expected?.rows.length ?? 0, 'expected row')} before, ${plural(r.actual?.rows.length ?? 0, 'row')} after`}>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {r.expected && <Table title="Expected before" table={r.expected} />}
            {r.actual && <Table title="Actual (new expectation)" table={r.actual} />}
          </div>
        </SampleRows>
      </div>
    );
  }
  const given = (r.fixtures ?? []).reduce((n, f) => n + f.rows.length, 0);
  return (
    <div className="flex flex-col gap-3 px-4 py-3 border-b border-gray-800">
      <p className="flex items-start gap-2 text-xs text-amber-300">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        <span>
          These rows were sampled from your warehouse and will be committed with the test
          {r.masked ? ' (text values masked).' : '. If they hold personal data, regenerate with “Mask text values”.'}
          {' '}The expected rows are what the model produces today, not a statement that it’s correct — check them.
        </span>
      </p>
      <SampleRows label={`Sample rows · ${plural(given, 'input row')}, ${plural(r.expected?.rows.length ?? 0, 'expected row')}`}>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {(r.fixtures ?? []).map((f) => <Table key={f.input} title={`given ${f.input}`} table={f} />)}
          {r.expected && <Table title="expect" table={r.expected} />}
        </div>
      </SampleRows>
    </div>
  );
}
