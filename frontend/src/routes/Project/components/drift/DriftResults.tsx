import { useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { ModelDriftResult } from '../../../../lib/api';
import type { useOpenInFiles } from '../../lib/openInFiles';
import { categorize, isManifestOnly, isWarehouseOnly, matchesSearch } from './driftView';
import ModelDriftRow from './ModelDriftRow';

/** Problem rows start expanded only when there are few enough to scan at a glance. */
const EXPAND_ROWS_UP_TO = 5;

type FilterKey = 'all' | 'drifted' | 'warehouse_only' | 'manifest_only' | 'type_mismatch' | 'not_built' | 'errors';

const FILTERS: { key: FilterKey; label: string; matches: (r: ModelDriftResult) => boolean }[] = [
  { key: 'all', label: 'All issues', matches: (r) => r.has_drift || r.error != null },
  { key: 'drifted', label: 'Drifted', matches: (r) => r.has_drift },
  { key: 'warehouse_only', label: 'Warehouse only', matches: (r) => r.columns.some(isWarehouseOnly) },
  { key: 'manifest_only', label: 'Manifest only', matches: (r) => r.columns.some(isManifestOnly) },
  { key: 'type_mismatch', label: 'Type mismatch', matches: (r) => r.columns.some((c) => c.type_mismatch) },
  { key: 'not_built', label: 'Not built', matches: (r) => r.not_built },
  { key: 'errors', label: 'Errors', matches: (r) => r.error != null && !r.not_built },
];

interface DriftResultsProps {
  projectId: number;
  snapshotId: number;
  results: ModelDriftResult[];
  scanRunning: boolean;
  fileNav: ReturnType<typeof useOpenInFiles>;
}

export default function DriftResults({ projectId, snapshotId, results, scanRunning, fileNav }: DriftResultsProps) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  const [showInSync, setShowInSync] = useState(false);

  const searched = results.filter((r) => matchesSearch(r, query));
  const groups = categorize(searched);
  const activeFilter = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const problems = searched.filter(activeFilter.matches);
  const expand = problems.length <= EXPAND_ROWS_UP_TO;

  const row = (r: ModelDriftResult, defaultOpen: boolean) => (
    <ModelDriftRow
      key={r.unique_id}
      projectId={projectId}
      snapshotId={snapshotId}
      result={r}
      defaultOpen={defaultOpen}
      scanRunning={scanRunning}
      fileNav={fileNav}
    />
  );

  const sections = filter === 'all'
    ? [
        { title: 'Drifted', rows: groups.drifted },
        { title: 'Not built', rows: groups.notBuilt },
        { title: 'Errors', rows: groups.errors },
      ].filter((s) => s.rows.length > 0)
    : [{ title: null, rows: problems }];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="flex items-center gap-1.5 px-2 py-1 mr-1 rounded border border-gray-700 bg-surface-elevated focus-within:border-brand-600">
          <Search className="w-3 h-3 text-gray-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models"
            className="w-36 bg-transparent text-[11px] text-gray-200 placeholder:text-gray-600 outline-none"
          />
        </label>
        {FILTERS.map((f) => {
          const count = searched.filter(f.matches).length;
          if (f.key !== 'all' && count === 0) return null;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                filter === f.key
                  ? 'bg-brand-900/60 border-brand-700 text-brand-300'
                  : 'bg-surface-elevated border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-300'
              }`}
            >
              {f.label} ({count})
            </button>
          );
        })}
      </div>

      {problems.length === 0 && (
        <p className="text-xs text-gray-600">
          {query.trim() ? 'No models with issues match this search.' : filter === 'all' ? 'No issues found.' : 'No models match this filter.'}
        </p>
      )}

      {sections.map((section) => (
        <div key={section.title ?? 'flat'} className="flex flex-col gap-2">
          {section.title && (
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              {section.title} <span className="text-gray-600">({section.rows.length})</span>
            </p>
          )}
          {section.rows.map((r) => row(r, expand))}
        </div>
      ))}

      {groups.inSync.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowInSync((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-emerald-400/80 hover:text-emerald-300 transition-colors w-fit"
          >
            {showInSync ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {groups.inSync.length} model{groups.inSync.length !== 1 ? 's' : ''} in sync
          </button>
          {showInSync && groups.inSync.map((r) => row(r, false))}
        </div>
      )}
    </div>
  );
}
