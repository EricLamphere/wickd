// A metric page's sections below the chart: where it comes from, what you can slice it by,
// where it's used, and its health (semantic check issues, monitor status).
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { ModelNode } from '../../../../lib/api';
import type { CatalogMetric, SemanticIssue } from '../../../../lib/semanticApi';
import { isOpenInFilesClick, OPEN_IN_FILES_TITLE } from '../../lib/openInFiles';
import { relativeTime } from '../../lib/relativeTime';
import { typeIconFor } from '../../lib/nodeTypeIcon';
import { statusStyle, type MetricMonitorState } from '../monitors/monitorView';
import { dimensionGroups, type MetricLineage, type MetricUsage } from '../lib/metricPage';

export function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 p-3 rounded border border-gray-800 bg-surface-panel">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-gray-600">{children}</p>;
}

/** A node chip: click opens it (DAG, page…), ⌘-click opens its file when it has one. */
function NodeChip({ node, onOpen, onOpenFile }: { node: ModelNode; onOpen: () => void; onOpenFile: ((uid: string) => void) | null }) {
  return (
    <button title={onOpenFile && node.original_file_path ? OPEN_IN_FILES_TITLE : undefined}
      onClick={(e) => { if (onOpenFile && node.original_file_path && isOpenInFilesClick(e)) onOpenFile(node.unique_id); else onOpen(); }}
      className="flex items-center gap-1 max-w-full px-1.5 py-0.5 text-[11px] rounded border border-gray-700 bg-surface-app text-gray-300 hover:border-brand-600 hover:text-brand-300">
      <span className="text-gray-500">{typeIconFor(node.resource_type)}</span>
      <span className="font-mono truncate">{node.label || node.name}</span>
    </button>
  );
}

function Row({ label, nodes, render }: { label: string; nodes: ModelNode[]; render: (n: ModelNode) => React.ReactNode }) {
  if (!nodes.length) return null;
  return (
    <div className="flex items-start gap-2">
      <span className="w-28 shrink-0 pt-0.5 text-[11px] text-gray-500">{label}</span>
      <div className="flex flex-wrap gap-1 min-w-0">{nodes.map(render)}</div>
    </div>
  );
}

export function LineageSection({ lineage, onOpenMetric, onShowInDag, onOpenFile }: {
  lineage: MetricLineage | null; onOpenMetric: (name: string) => void; onShowInDag: (uid: string) => void; onOpenFile: ((uid: string) => void) | null;
}) {
  const chip = (open: (n: ModelNode) => void) => (n: ModelNode) => <NodeChip key={n.unique_id} node={n} onOpen={() => open(n)} onOpenFile={onOpenFile} />;
  const toDag = chip((n) => onShowInDag(n.unique_id));
  return (
    <Section title="Where it comes from">
      {!lineage ? <Empty>Not in the manifest yet (dbt parses on the next run).</Empty> : (
        <div className="flex flex-col gap-1.5">
          <Row label="Input metrics" nodes={lineage.inputMetrics} render={chip((n) => onOpenMetric(n.name))} />
          <Row label="Semantic models" nodes={lineage.semanticModels} render={toDag} />
          <Row label="dbt models" nodes={lineage.models} render={toDag} />
          <Row label="Upstream" nodes={lineage.upstream} render={toDag} />
        </div>
      )}
    </Section>
  );
}

export function DimensionsSection({ metric }: { metric: CatalogMetric }) {
  const groups = dimensionGroups(metric);
  return (
    <Section title={`Slice it by (${metric.dimensions.length})`}>
      {!groups.length ? <Empty>No dimensions.</Empty> : groups.map((g) => (
        <div key={g.entity} className="flex items-start gap-2">
          <span className="w-28 shrink-0 pt-0.5 text-[11px] text-gray-500 truncate">{g.entity}</span>
          <div className="flex flex-wrap gap-1 min-w-0">
            {g.names.map((n) => (
              <span key={n} className="px-1.5 py-0.5 text-[11px] font-mono rounded bg-gray-800/60 text-gray-300">{n}</span>
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}

export function UsageSection({ usage, dashboardTitle, onOpenDashboard, onRunSaved, onOpenMetric, onShowInDag, onOpenFile }: {
  usage: MetricUsage; dashboardTitle: (slug: string) => string;
  onOpenDashboard: (slug: string) => void; onRunSaved: (name: string) => void; onOpenMetric: (name: string) => void;
  onShowInDag: (uid: string) => void; onOpenFile: ((uid: string) => void) | null;
}) {
  const link = 'px-1.5 py-0.5 text-[11px] rounded border border-gray-700 bg-surface-app text-gray-300 hover:border-brand-600 hover:text-brand-300 truncate';
  const nothing = !usage.dashboards.length && !usage.savedQueries.length && !usage.exposures.length && !usage.usedByMetrics.length;
  return (
    <Section title="Where it's used">
      {nothing ? <Empty>No dashboards, saved queries, exposures or other metrics use it yet.</Empty> : (
        <div className="flex flex-col gap-1.5">
          {usage.dashboards.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="w-28 shrink-0 pt-0.5 text-[11px] text-gray-500">Dashboards</span>
              <div className="flex flex-wrap gap-1 min-w-0">
                {usage.dashboards.map((d) => <button key={d.slug} onClick={() => onOpenDashboard(d.slug)} className={link}>{dashboardTitle(d.slug)}</button>)}
              </div>
            </div>
          )}
          {usage.savedQueries.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="w-28 shrink-0 pt-0.5 text-[11px] text-gray-500">Saved queries</span>
              <div className="flex flex-wrap gap-1 min-w-0">
                {usage.savedQueries.map((q) => <button key={q.name} onClick={() => onRunSaved(q.name)} title="Run it in the query view"
                  className={`${link} font-mono`}>{q.label || q.name}</button>)}
              </div>
            </div>
          )}
          <Row label="Exposures" nodes={usage.exposures}
            render={(n) => <NodeChip key={n.unique_id} node={n} onOpen={() => onShowInDag(n.unique_id)} onOpenFile={onOpenFile} />} />
          <Row label="Metrics built on it" nodes={usage.usedByMetrics}
            render={(n) => <NodeChip key={n.unique_id} node={n} onOpen={() => onOpenMetric(n.name)} onOpenFile={onOpenFile} />} />
        </div>
      )}
    </Section>
  );
}

export function HealthSection({ issues, checkedAt, monitor, onOpenCheck, onOpenMonitors }: {
  issues: SemanticIssue[]; checkedAt: string | null; monitor: MetricMonitorState | undefined;
  onOpenCheck: () => void; onOpenMonitors: () => void;
}) {
  const style = monitor ? statusStyle(monitor.status) : null;
  return (
    <Section title="Health" aside={<button onClick={onOpenCheck} className="text-[11px] text-brand-300 hover:text-brand-200">Semantic check</button>}>
      {checkedAt === null ? <Empty>The semantic layer hasn't been checked yet.</Empty> : issues.length === 0 ? (
        <p className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />No issues in the last check ({relativeTime(checkedAt)}).
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {issues.map((i, n) => (
            <li key={n} className="flex items-start gap-1.5 text-[11px] text-gray-300">
              <AlertTriangle className={`w-3.5 h-3.5 shrink-0 mt-px ${i.level === 'error' ? 'text-red-400' : 'text-amber-300'}`} />
              <span><span className="text-gray-500">{i.object_name}: </span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}
      {monitor && style && (
        <button onClick={onOpenMonitors} title={monitor.headline}
          className="flex items-center gap-2 self-start text-[11px] text-gray-400 hover:text-gray-200">
          <span className={`px-1.5 py-px rounded border ${style.pill}`}>{style.label}</span>
          <span className="truncate">{monitor.monitors} monitor{monitor.monitors === 1 ? '' : 's'} · {monitor.headline}</span>
        </button>
      )}
    </Section>
  );
}
