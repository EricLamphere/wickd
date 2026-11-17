import { ArrowUpCircle, Trash2 } from 'lucide-react';
import type { RichColumn } from '../../../components/RichTable';
import type { PackageRowDto } from '../../../lib/packagesApi';
import { compatLabel, latestHint, rangeText, type Tone } from './packagesView';

const TONE_PILL: Record<Tone, string> = {
  ok: 'bg-green-950/40 text-green-300 border-green-900/60',
  warn: 'bg-amber-950/40 text-amber-300 border-amber-900/60',
  fail: 'bg-red-950/40 text-red-300 border-red-900/60',
  muted: 'bg-gray-900 text-gray-400 border-gray-800',
};

const SOURCE_LABEL: Record<string, string> = {
  hub: 'hub', git: 'git', local: 'local', tarball: 'tarball', private: 'private', unknown: '?', dependency: 'dependency',
};

function Pill({ tone, title, children }: { tone: Tone; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={`inline-block px-1.5 py-0.5 text-[10px] rounded border whitespace-nowrap ${TONE_PILL[tone]}`}>
      {children}
    </span>
  );
}

const mono = (value: string | null) => value
  ? <span className="block truncate font-mono text-gray-300" title={value}>{value}</span>
  : <span className="text-gray-600">—</span>;

export function packageColumns(dbtVersion: string | null): RichColumn<PackageRowDto>[] {
  return [
    {
      id: 'name', header: 'Package', sortValue: (r) => r.name.toLowerCase(),
      cell: (r) => (
        <span className="flex items-center gap-2 min-w-0">
          <span className={`truncate font-mono ${r.direct ? 'text-gray-100' : 'text-gray-400'}`} title={r.name}>{r.name}</span>
          <span className="shrink-0 text-[10px] text-gray-500">{SOURCE_LABEL[r.source] ?? r.source}</span>
        </span>
      ),
    },
    { id: 'requested', header: 'Requested', width: 'w-32', cell: (r) => mono(r.requested), sortValue: (r) => r.requested ?? '' },
    { id: 'locked', header: 'Locked', width: 'w-20', cell: (r) => mono(r.locked), sortValue: (r) => r.locked ?? '' },
    { id: 'installed', header: 'Installed', width: 'w-20', cell: (r) => mono(r.installed), sortValue: (r) => r.installed ?? '' },
    {
      id: 'latest', header: 'Latest', width: 'w-24', sortValue: (r) => (r.upgrade_to ? 0 : 1),
      cell: (r) => {
        const hint = latestHint(r);
        if (!r.latest) return <span className="text-gray-600" title="Version checks cover Hub packages and git packages pinned to a tag">—</span>;
        return (
          <span className="flex items-center gap-1.5" title={hint ?? 'Up to date'}>
            <span className="font-mono text-gray-300">{r.latest}</span>
            {r.upgrade_to && <ArrowUpCircle className="w-3.5 h-3.5 text-brand-400" />}
            {!r.upgrade_to && r.latest_blocked && <span className="text-[10px] text-amber-400">dbt</span>}
          </span>
        );
      },
    },
    {
      id: 'compat', header: `dbt ${dbtVersion ?? ''}`.trim(), width: 'w-28',
      headerTitle: 'Whether the installed package’s require-dbt-version accepts the installed dbt-core',
      sortValue: (r) => (r.compatible === false ? 0 : r.compatible === null ? 1 : 2),
      cell: (r) => {
        const label = compatLabel(r, dbtVersion);
        return <Pill tone={label.tone} title={label.title}>{label.text}</Pill>;
      },
    },
  ];
}

export function PackageDetails({ row }: { row: PackageRowDto }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-2 text-[11px] text-gray-400">
      <span>require-dbt-version: <span className="font-mono text-gray-300">{rangeText(row.require_dbt_version)}</span></span>
      {row.project_name && <span>Installed as <span className="font-mono text-gray-300">{row.project_name}</span></span>}
      {row.latest_compatible && <span>Newest release for this dbt-core: <span className="font-mono text-gray-300">{row.latest_compatible}</span></span>}
      {row.notes.map((n) => <span key={n} className="text-amber-400/90">{n}</span>)}
    </div>
  );
}

interface RowActionsProps {
  row: PackageRowDto;
  busy: boolean;
  onUpgrade: (row: PackageRowDto) => void;
  onRemove: (row: PackageRowDto) => void;
}

export function PackageRowActions({ row, busy, onUpgrade, onRemove }: RowActionsProps) {
  if (!row.direct) return null;
  const btn = 'p-1 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-700 disabled:opacity-40';
  return (
    <span className="flex items-center justify-end gap-1">
      {row.editable && row.upgrade_to && (
        <button type="button" className={btn} disabled={busy} title={`Upgrade to ${row.upgrade_to}`}
          onClick={(e) => { e.stopPropagation(); onUpgrade(row); }}>
          <ArrowUpCircle className="w-3.5 h-3.5" />
        </button>
      )}
      <button type="button" className={btn} disabled={busy} title="Remove from the packages file"
        onClick={(e) => { e.stopPropagation(); onRemove(row); }}>
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </span>
  );
}
