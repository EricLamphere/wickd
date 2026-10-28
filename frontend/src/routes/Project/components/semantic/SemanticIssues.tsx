import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, FileCode2 } from 'lucide-react';
import { api } from '../../../../lib/api';
import type { SemanticCheckDto } from '../../../../lib/semanticApi';
import { groupIssues, OBJECT_LABEL, type IssueSeverity } from './semanticView';

const SEVERITY: Record<IssueSeverity, { label: string; cls: string }> = {
  error: { label: 'error', cls: 'bg-red-950/40 text-red-300 border-red-900/60' },
  future_error: { label: 'future error', cls: 'bg-amber-950/40 text-amber-300 border-amber-900/60' },
  warning: { label: 'warning', cls: 'bg-amber-950/30 text-amber-400 border-amber-900/50' },
};

/** Validation issues grouped by semantic model / metric / saved query, with Open YAML. */
export function SemanticIssues({ projectId, results }: { projectId: number; results: SemanticCheckDto['results'] }) {
  const navigate = useNavigate();
  const { data: graph } = useQuery({ queryKey: ['graph', projectId], queryFn: () => api.models.graph(projectId) });
  const groups = useMemo(() => groupIssues(results), [results]);
  const uidFor = (type: string | null, name: string | null) =>
    graph?.nodes.find((n) => n.resource_type === type && n.name === name && n.original_file_path)?.unique_id;
  const failedMetrics = (results.warehouse ?? []).filter((w) => !w.ok);

  if (groups.length === 0 && failedMetrics.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-emerald-400">
        <CheckCircle2 className="w-4 h-4" />
        No problems found{results.warehouse ? ` — all ${results.warehouse.length} metrics ran in the warehouse` : ''}.
      </p>
    );
  }

  const openButton = (uid: string | undefined) => uid && (
    <button
      onClick={() => navigate(`/projects/${projectId}/files?model=${encodeURIComponent(uid)}`)}
      className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-brand-300 transition-colors"
    >
      <FileCode2 className="w-3 h-3" />Open YAML
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      {groups.map((g) => (
        <div key={g.key} className="bg-surface-panel border border-gray-800 rounded-lg px-4 py-3 flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-gray-500">{g.objectType ? OBJECT_LABEL[g.objectType] : 'Project'}</span>
            {g.objectName && <span className="font-mono text-xs text-gray-100">{g.objectName}</span>}
            <span className="flex-1" />
            {openButton(uidFor(g.objectType, g.objectName))}
          </div>
          {g.issues.map((i, idx) => (
            <div key={idx} className="flex items-start gap-2 text-xs">
              <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-mono ${SEVERITY[i.severity].cls}`}>{SEVERITY[i.severity].label}</span>
              <span className="text-gray-300 leading-relaxed break-words">
                {i.element && <span className="font-mono text-gray-400">{i.element}: </span>}
                {i.message}
              </span>
            </div>
          ))}
        </div>
      ))}
      {failedMetrics.length > 0 && (
        <div className="bg-surface-panel border border-gray-800 rounded-lg px-4 py-3 flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-wider text-gray-500">Failed in the warehouse</span>
          {failedMetrics.map((w) => (
            <div key={w.metric} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-red-300">{w.metric}</span>
                <span className="flex-1" />
                {openButton(uidFor('metric', w.metric))}
              </div>
              {w.error && <pre className="text-[10px] font-mono text-gray-400 whitespace-pre-wrap max-h-28 overflow-auto">{w.error}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
