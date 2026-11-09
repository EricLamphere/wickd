import { DataTable } from '../../../../components/DataTable';
import type { NodeRow, RowCounts } from './buildRows';

const COLUMNS = [{ key: 'node' }, { key: 'type' }, { key: 'status' }, { key: 'why' }];

/** The build dialog's Nodes section header counts. */
export function nodeCountsLabel(counts: RowCounts): string {
  const parts = [`${counts.toBuild} to build`];
  if (counts.tests > 0) parts.push(`+ ${counts.tests} tests`);
  if (counts.skipped > 0) parts.push(`· ${counts.skipped} skipped`);
  return parts.join(' ');
}

/** The build dialog's node table. */
export function BuildNodes({ rows, empty }: { rows: NodeRow[]; empty: string }) {
  if (rows.length === 0) return <p className="px-3 py-6 text-center text-xs text-gray-600">{empty}</p>;
  return <DataTable columns={COLUMNS} rows={rows.map((r) => [r.name, r.type, r.status, r.why])} />;
}
