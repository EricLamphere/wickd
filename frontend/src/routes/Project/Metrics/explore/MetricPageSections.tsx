// A metric page's sections below its charts (doc-style: a heading and plain content): where it comes from, what you can slice it by,
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
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2 pb-1.5 border-b border-gray-800">
        <h2 className="flex-1 text-sm font-semibold text-gray-200">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-gray-500">{children}</p>;
}

/** A node chip: click opens it (DAG, page…), ⌘-click opens its file when it has one. */
function NodeChip({ node, onOpen, onOpenFile }: { node: ModelNode; onOpen: () => void; onOpenFile: ((uid: string) => void) | null }) {
  return (
    <button title={onOpenFile && node.original_file_path ? OPEN_IN_FILES_TITLE : undefined}
      onClick={(e) => { if (onOpenFile && node.original_file_path && isOpenInFilesClick(e)) onOpenFile(node.unique_id); else onOpen(); }}
      className="flex items-center gap-1 max-w-full px-2 py-0.5 text-xs rounded-full border border-gray-700 text-gray-300 hover:border-brand-600 hover:text-brand-300">
      <span className="text-gray-500">{typeIconFor(node.resource_type)}</span>
      <span className="truncate">{node.label || node.name}</span>
    </button>
  );
}

function Row({ label, nodes, render }: { label: string; nodes: ModelNode[]; render: (n: ModelNode) => React.ReactNode }) {
  if (!nodes.length) return null;
  return (
    <div className="flex items-start gap-2">
      <span className="w-32 shrink-0 pt-0.5 text-xs text-gray-500">{label}</span>
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

/** A dimension's name under its entity's heading (`customer__region` → `region`). */
function shortName(entity: string, name: string): string {
  return name.startsWith(`${entity}__`) ? name.slice(entity.length + 2) : name;
}

export function DimensionsSection({ metric }: { metric: CatalogMetric }) {
  const groups = dimensionGroups(metric);
  return (
    <Section title={`Dimensions (${metric.dimensions.length})`}>
      {!groups.length ? <Empty>No dimensions.</Empty> : (
        <dl className="flex flex-col gap-2">
          {groups.map((g) => (
            <div key={g.entity} className="flex items-start gap-2">
              <dt className="w-32 shrink-0 pt-0.5 text-xs text-gray-500 truncate capitalize" title={g.entity}>{g.entity.replace(/_/g, ' ')}</dt>
              <dd className="flex flex-wrap gap-1 min-w-0">
                {g.names.map((n) => (
                  <span key={n} title={n} className="px-2 py-0.5 text-xs rounded-full border border-gray-700 text-gray-300">{shortName(g.entity, n)}</span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

export function UsageSection({ usage, dashboardTitle, onOpenDashboard, onRunSaved, onOpenMetric, onShowInDag, onOpenFile }: {
  usage: MetricUsage; dashboardTitle: (slug: string) => string;
  onOpenDashboard: (slug: string) => void; onRunSaved: (name: string) => void; onOpenMetric: (name: string) => void;
  onShowInDag: (uid: string) => void; onOpenFile: ((uid: string) => void) | null;
}) {
  const link = 'px-2 py-0.5 text-xs rounded-full border border-gray-700 text-gray-300 hover:border-brand-600 hover:text-brand-300 truncate';
  const nothing = !usage.dashboards.length && !usage.savedQueries.length && !usage.exposures.length && !usage.usedByMetrics.length;
  return (
    <Section title="Where it's used">
      {nothing ? <Empty>No dashboards, saved queries, exposures or other metrics use it yet.</Empty> : (
        <div className="flex flex-col gap-1.5">
          {usage.dashboards.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="w-32 shrink-0 pt-0.5 text-xs text-gray-500">Dashboards</span>
              <div className="flex flex-wrap gap-1 min-w-0">
                {usage.dashboards.map((d) => <button key={d.slug} onClick={() => onOpenDashboard(d.slug)} className={link}>{dashboardTitle(d.slug)}</button>)}
              </div>
            </div>
          )}
          {usage.savedQueries.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="w-32 shrink-0 pt-0.5 text-xs text-gray-500">Saved queries</span>
              <div className="flex flex-wrap gap-1 min-w-0">
                {usage.savedQueries.map((q) => <button key={q.name} onClick={() => onRunSaved(q.name)} title="Run it in the query view"
                  className={link}>{q.label || q.name}</button>)}
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
        <p className="flex items-center gap-1.5 text-xs text-gray-400">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />No issues in the last check ({relativeTime(checkedAt)}).
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {issues.map((i, n) => (
            <li key={n} className="flex items-start gap-1.5 text-xs text-gray-300">
              <AlertTriangle className={`w-3.5 h-3.5 shrink-0 mt-px ${i.level === 'error' ? 'text-red-400' : 'text-amber-300'}`} />
              <span><span className="text-gray-500">{i.object_name}: </span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}
      {monitor && style && (
        <button onClick={onOpenMonitors} title={monitor.headline}
          className="flex items-center gap-2 self-start text-xs text-gray-400 hover:text-gray-200">
          <span className={`px-1.5 py-px rounded border ${style.pill}`}>{style.label}</span>
          <span className="truncate">{monitor.monitors} monitor{monitor.monitors === 1 ? '' : 's'} · {monitor.headline}</span>
        </button>
      )}
    </Section>
  );
}
