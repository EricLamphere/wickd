// The Execution DAG for a command without DAG nodes (compile, docs generate, debug, …): one node,
// the project, with the operation under its name, colored like a DAG node's run status (blue
// while running, green on success, red on failure, yellow with warnings).
import type { OperationStatus } from '../../lib/operationRun';

const RING: Record<OperationStatus, string> = {
  running: 'ring-blue-500 shadow-lg shadow-blue-500/30',
  success: 'ring-emerald-600',
  error: 'ring-red-600',
  warn: 'ring-yellow-500',
};

const DOT: Record<OperationStatus, string> = {
  running: 'bg-blue-400 animate-pulse',
  success: 'bg-emerald-400',
  error: 'bg-red-500',
  warn: 'bg-yellow-400',
};

const LABEL: Record<OperationStatus, string> = {
  running: 'Running', success: 'Succeeded', error: 'Failed', warn: 'Finished with warnings',
};

export function OperationNode({ project, operation, status }: { project: string; operation: string; status: OperationStatus }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center"
      style={{ backgroundImage: 'radial-gradient(rgb(var(--border-default)) 1px, transparent 1px)', backgroundSize: '24px 24px' }}>
      <div role="status" aria-label={`${project}: ${operation} — ${LABEL[status]}`} title={LABEL[status]}
        className={`flex items-center gap-2.5 min-w-[12rem] max-w-[24rem] px-3 py-2 rounded-md ring-2 bg-surface-panel ${RING[status]}`}>
        <span className={`w-2.5 h-2.5 shrink-0 rounded-full ${DOT[status]}`} />
        <span className="flex flex-col min-w-0">
          <span className="text-sm font-semibold text-gray-100 truncate">{project}</span>
          <span className="text-[11px] font-mono text-gray-400 truncate">{operation}</span>
        </span>
      </div>
    </div>
  );
}
