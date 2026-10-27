import type { ReactNode } from 'react';
import { Columns3, Filter, LayoutDashboard } from 'lucide-react';
import type { TestGapDto, UsedNodeDto } from '../../../../lib/testGapsApi';
import { OPEN_IN_FILES_TITLE } from '../../lib/openInFiles';
import type { NodeFileNav } from '../NodeName';
import { hiddenCount } from './testGapsView';

type UsedByRow = Pick<TestGapDto, 'reach' | 'row_uses' | 'exposures' | 'used_by'>;

/** A node chip; ⌘-click opens it in Files, like NodeName. */
function NodeChip({ node, fileNav }: { node: UsedNodeDto; fileNav: NodeFileNav }) {
  const openable = fileNav.canOpen(node.unique_id);
  return (
    <span
      onClick={(e) => fileNav.handleClick(e, node.unique_id)}
      title={openable ? `${node.unique_id} · ${OPEN_IN_FILES_TITLE}` : node.unique_id}
      className={`px-1.5 rounded bg-surface-elevated font-mono text-gray-300 ${
        openable ? 'mod:cursor-pointer mod:underline mod:decoration-brand-400 mod:hover:text-brand-300 underline-offset-2' : ''
      }`}
    >
      {node.name}
    </span>
  );
}

function More({ count }: { count: number }) {
  return count > 0 ? <span className="text-gray-600">+ {count} more</span> : null;
}

function Group({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
        <span className="text-gray-600">{icon}</span>{label}
      </span>
      <div className="flex flex-col gap-1 pl-4 text-[11px]">{children}</div>
    </div>
  );
}

/** Expanded row: every downstream column, row-using model and exposure behind the Used by counts. */
export function GapUsedBy({ row, fileNav }: { row: UsedByRow; fileNav: NodeFileNav }) {
  const { columns, row_uses, exposures } = row.used_by;
  if (!columns.length && !row_uses.length && !exposures.length) return null;
  const shownColumns = columns.reduce((n, m) => n + m.columns.length, 0);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Used by</span>
      {columns.length > 0 && (
        <Group icon={<Columns3 size={11} />} label={`${row.reach} downstream column${row.reach === 1 ? '' : 's'} built from it`}>
          {columns.map((m) => (
            <span key={m.unique_id} className="flex flex-wrap items-center gap-1">
              <NodeChip node={m} fileNav={fileNav} />
              <span className="font-mono text-gray-400">{m.columns.join(', ')}</span>
            </span>
          ))}
          <More count={hiddenCount(row.reach, shownColumns)} />
        </Group>
      )}
      {row_uses.length > 0 && (
        <Group icon={<Filter size={11} />} label={`Filtered, joined or grouped on in ${row.row_uses} model${row.row_uses === 1 ? '' : 's'}`}>
          <span className="flex flex-wrap items-center gap-1">
            {row_uses.map((m) => <NodeChip key={m.unique_id} node={m} fileNav={fileNav} />)}
            <More count={hiddenCount(row.row_uses, row_uses.length)} />
          </span>
        </Group>
      )}
      {exposures.length > 0 && (
        <Group icon={<LayoutDashboard size={11} />} label={`Reaches ${row.exposures} exposure${row.exposures === 1 ? '' : 's'}`}>
          <span className="flex flex-wrap items-center gap-1">
            {exposures.map((m) => <NodeChip key={m.unique_id} node={m} fileNav={fileNav} />)}
            <More count={hiddenCount(row.exposures, exposures.length)} />
          </span>
        </Group>
      )}
    </div>
  );
}
