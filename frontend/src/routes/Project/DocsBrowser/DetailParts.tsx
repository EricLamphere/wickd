import { Check, Copy, Wand2 } from 'lucide-react';
import type { DocsMacroDto, DocsNodeDto } from '../../../lib/api';
import { useStickyTab } from '../../../lib/useUrlTab';
import { isSemanticType } from '../lib/semantic';
import { resourceColor, resourceIcon } from '../lib/resourceTypeStyle';

// ---- shared sub-components ----

export function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">{label}</span>
      <span className="text-gray-300 text-xs font-mono break-all">{value}</span>
    </div>
  );
}

export function Tag({ label }: { label: string }) {
  return <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-elevated text-gray-500 font-mono">{label}</span>;
}

export function CodeBlock({ code, placeholder }: { code: string; placeholder: string }) {
  if (!code) return <p className="text-xs text-gray-600 italic">{placeholder}</p>;
  return (
    <pre className="bg-surface-elevated border border-gray-800 rounded-lg p-4 text-xs font-mono text-gray-300 overflow-auto max-h-[500px] leading-relaxed whitespace-pre">
      {code}
    </pre>
  );
}

export function CodeViewToggle({ value, onChange }: { value: 'source' | 'compiled'; onChange: (v: 'source' | 'compiled') => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-surface-elevated rounded p-0.5">
      {(['source', 'compiled'] as const).map((v) => (
        <button key={v} onClick={() => onChange(v)}
          className={`px-2.5 py-0.5 text-xs rounded capitalize transition-colors ${value === v ? 'bg-brand-900/60 text-brand-300' : 'text-gray-500 hover:text-gray-300'}`}>
          {v}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <button onClick={onCopy} className="ml-auto flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors">
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? 'Copied!' : 'Copy to clipboard'}
    </button>
  );
}

export function ColumnsTable({ columns, compact = false, onRename }: {
  columns: DocsNodeDto['columns'];
  compact?: boolean;
  /** Rename a column everywhere (refactor, wickd Pro); shown on row hover. */
  onRename?: (column: string) => void;
}) {
  return (
    <div className="rounded-lg border border-gray-800 overflow-hidden">
      <table className="w-full text-xs text-gray-300 border-collapse">
        <thead>
          <tr className="bg-surface-elevated text-gray-500 text-[10px] uppercase tracking-wider">
            <th className="px-3 py-2 text-left font-medium border-b border-gray-800">Column</th>
            <th className="px-3 py-2 text-left font-medium border-b border-gray-800">Type</th>
            <th className="px-3 py-2 text-left font-medium border-b border-gray-800">Description</th>
            {!compact && <th className="px-3 py-2 text-left font-medium border-b border-gray-800">Constraints</th>}
            <th className="px-3 py-2 text-left font-medium border-b border-gray-800">Tests</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((col, i) => (
            <tr key={col.name} className={`group border-b border-gray-800/50 ${i % 2 === 0 ? '' : 'bg-surface-elevated/20'}`}>
              <td className="px-3 py-2 font-mono text-brand-300 whitespace-nowrap">
                {col.name}
                {onRename && (
                  <button
                    onClick={() => onRename(col.name)}
                    title="Rename this column in the model, its YAML and downstream models (wickd Pro); you review every change first"
                    className="ml-1.5 p-0.5 align-middle rounded text-gray-600 opacity-0 group-hover:opacity-100 hover:text-gray-300 focus:opacity-100"
                  >
                    <Wand2 size={11} />
                  </button>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-gray-500 whitespace-nowrap">{col.data_type || '—'}</td>
              <td className="px-3 py-2 text-gray-400">{col.description || <span className="text-gray-700 italic">—</span>}</td>
              {!compact && (
                <td className="px-3 py-2 text-gray-500">
                  {col.constraints.length > 0
                    ? col.constraints.map((c, j) => <span key={j} className="mr-1 font-mono text-[10px]">{String(c)}</span>)
                    : '—'}
                </td>
              )}
              <td className="px-3 py-2">
                {col.tests.length > 0
                  ? <div className="flex gap-1 flex-wrap">{col.tests.map((t) => <TestBadge key={t} name={t} />)}</div>
                  : <span className="text-gray-700">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TEST_ABBREV: Record<string, string> = {
  unique: 'U', not_null: 'N', accepted_values: 'A', relationships: 'R',
};

function TestBadge({ name }: { name: string }) {
  const abbrev = TEST_ABBREV[name] ?? name.slice(0, 2).toUpperCase();
  const colors: Record<string, string> = {
    unique: 'bg-blue-900/40 text-blue-300 border-blue-800',
    not_null: 'bg-orange-900/40 text-orange-300 border-orange-800',
    accepted_values: 'bg-green-900/40 text-green-300 border-green-800',
    relationships: 'bg-purple-900/40 text-purple-300 border-purple-800',
  };
  return (
    <span title={name} className={`text-[10px] font-mono px-1 py-0.5 rounded border ${colors[name] ?? 'bg-surface-elevated text-gray-400 border-gray-700'}`}>
      {abbrev}
    </span>
  );
}

type DependsTab = 'models' | 'nodes' | 'macros' | 'semantic';

export function DependsOn({ projectId, dependsOnNodes, dependsOnMacros, allNodes, allMacros, onSelectNode }: {
  projectId: number;
  dependsOnNodes: string[];
  dependsOnMacros: string[];
  allNodes: Map<string, DocsNodeDto>;
  allMacros: Map<string, DocsMacroDto>;
  onSelectNode: (uid: string) => void;
}) {
  const models = dependsOnNodes.filter((uid) => uid.startsWith('model.') || uid.startsWith('seed.') || uid.startsWith('snapshot.'));
  const sources = dependsOnNodes.filter((uid) => uid.startsWith('source.'));
  const semantic = dependsOnNodes.filter((uid) => isSemanticType(uid.split('.')[0]));
  const macros = dependsOnMacros;
  const tabs: { id: DependsTab; label: string; count: number }[] = (
    [
      { id: 'models' as DependsTab, label: 'Models', count: models.length },
      { id: 'nodes' as DependsTab, label: 'Sources', count: sources.length },
      { id: 'semantic' as DependsTab, label: 'Semantic', count: semantic.length },
      { id: 'macros' as DependsTab, label: 'Macros', count: macros.length },
    ] as { id: DependsTab; label: string; count: number }[]
  ).filter((t) => t.count > 0);
  const [tab, setTab] = useStickyTab<DependsTab>(`docs-depends-tab:${projectId}`, tabs.map((t) => t.id), tabs[0]?.id ?? 'models');

  if (tabs.length === 0) return <p className="text-xs text-gray-600 italic">No dependencies found.</p>;

  const renderUids = tab === 'models' ? models : tab === 'nodes' ? sources : tab === 'semantic' ? semantic : macros;

  return (
    <div>
      {tabs.length > 1 && (
        <div className="flex items-center gap-0 mb-3 border-b border-gray-800">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors relative ${tab === t.id ? 'text-brand-300' : 'text-gray-500 hover:text-gray-300'}`}>
              {t.label}
              <span className="ml-1 text-gray-600">({t.count})</span>
              {tab === t.id && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-400 rounded-t" />}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1">
        {renderUids.map((uid) => {
          const node = allNodes.get(uid);
          const macro = allMacros.get(uid);
          const displayName = node?.name ?? macro?.name ?? uid.split('.').pop() ?? uid;
          const resourceType = node?.resource_type ?? macro?.resource_type ?? 'model';
          const canNavigate = !!(node ?? macro);
          return (
            <button
              key={uid}
              onClick={() => canNavigate && onSelectNode(uid)}
              disabled={!canNavigate}
              className={`text-left flex items-center gap-1.5 text-xs font-mono ${canNavigate ? `${resourceColor(resourceType)} hover:underline hover:opacity-80 transition-opacity` : 'text-gray-500 cursor-default'}`}
            >
              <span className={`shrink-0 ${resourceColor(resourceType)}`}>{resourceIcon(resourceType)}</span>
              {displayName}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const REFERENCED_BY_TABS = ['models', 'tests'] as const;

export function ReferencedBy({ projectId, childModels, childTests, allNodes, onSelect }: {
  projectId: number;
  childModels: string[];
  childTests: string[];
  allNodes: Map<string, DocsNodeDto>;
  onSelect: (uid: string) => void;
}) {
  const [tab, setTab] = useStickyTab(`docs-referenced-by-tab:${projectId}`, REFERENCED_BY_TABS, 'models');
  return (
    <div>
      <div className="flex items-center gap-0 mb-3 border-b border-gray-800">
        {(['models', 'tests'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors relative ${tab === t ? 'text-brand-300' : 'text-gray-500 hover:text-gray-300'}`}>
            {t === 'models' ? 'Models' : 'Data Tests'}
            {tab === t && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-400 rounded-t" />}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        {tab === 'models' && (
          childModels.length === 0
            ? <p className="text-xs text-gray-600 italic">No models reference this node.</p>
            : childModels.map((uid) => {
                const n = allNodes.get(uid);
                return (
                  <button
                    key={uid}
                    onClick={() => onSelect(uid)}
                    className="text-left text-xs font-mono text-brand-400 hover:text-brand-300 hover:underline transition-colors"
                  >
                    {n?.name ?? uid.split('.').pop()}
                  </button>
                );
              })
        )}
        {tab === 'tests' && (
          childTests.length === 0
            ? <p className="text-xs text-gray-600 italic">No data tests for this node.</p>
            : childTests.map((uid) => {
                const n = allNodes.get(uid);
                return (
                  <button
                    key={uid}
                    onClick={() => onSelect(uid)}
                    className="text-left text-xs font-mono text-gray-400 hover:text-gray-200 hover:underline transition-colors"
                  >
                    {n?.name ?? uid.split('.').pop()}
                  </button>
                );
              })
        )}
      </div>
    </div>
  );
}
