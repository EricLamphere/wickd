import type { SemanticInfo } from '../../../../lib/api';
import { describeMetric } from '../../lib/semantic';

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">{label}</span>
      {children}
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="block px-2 py-1 rounded bg-surface-elevated text-[11px] font-mono text-gray-300 break-all whitespace-pre-wrap">{children}</code>;
}

function Chips({ names }: { names: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {names.map((n) => (
        <span key={n} className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-gray-700 text-gray-300 border border-gray-600">{n}</span>
      ))}
    </div>
  );
}

/** Name + secondary detail rows (entities, dimensions, measures). */
function ItemList({ items }: { items: { name: string; detail: string }[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((it) => (
        <li key={it.name} className="flex items-baseline justify-between gap-2 text-xs">
          <span className="font-mono text-gray-200 truncate">{it.name}</span>
          <span className="font-mono text-[10px] text-gray-500 shrink-0">{it.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function SemanticModelDetails({ s }: { s: SemanticInfo }) {
  const entities = s.entities ?? [];
  const dimensions = s.dimensions ?? [];
  const measures = s.measures ?? [];
  return (
    <>
      {s.relation_name && <Section label="Relation"><Mono>{s.relation_name}</Mono></Section>}
      {s.agg_time_dimension && <Section label="Default time dimension"><Mono>{s.agg_time_dimension}</Mono></Section>}
      {entities.length > 0 && (
        <Section label={`Entities (${entities.length})`}>
          <ItemList items={entities.map((e) => ({ name: e.name, detail: [e.type, e.expr && `= ${e.expr}`].filter(Boolean).join(' ') }))} />
        </Section>
      )}
      {dimensions.length > 0 && (
        <Section label={`Dimensions (${dimensions.length})`}>
          <ItemList items={dimensions.map((d) => ({ name: d.name, detail: d.time_granularity ? `time · ${d.time_granularity}` : d.type ?? '' }))} />
        </Section>
      )}
      {measures.length > 0 && (
        <Section label={`Measures (${measures.length})`}>
          <ItemList items={measures.map((m) => ({ name: m.name, detail: m.expr ? `${m.agg}(${m.expr})` : m.agg ?? '' }))} />
        </Section>
      )}
    </>
  );
}

function MetricDetails({ s }: { s: SemanticInfo }) {
  return (
    <>
      <Section label="Definition"><Mono>{describeMetric(s)}</Mono></Section>
      {s.filter && <Section label="Filter"><Mono>{s.filter}</Mono></Section>}
      {(s.input_metrics ?? []).length > 0 && <Section label="Input metrics"><Chips names={s.input_metrics!} /></Section>}
      {s.time_granularity && <Section label="Default grain"><Mono>{s.time_granularity}</Mono></Section>}
    </>
  );
}

function SavedQueryDetails({ s }: { s: SemanticInfo }) {
  return (
    <>
      {(s.metrics ?? []).length > 0 && <Section label="Metrics"><Chips names={s.metrics!} /></Section>}
      {(s.group_by ?? []).length > 0 && <Section label="Group by"><Chips names={s.group_by!} /></Section>}
      {s.where && <Section label="Where"><Mono>{s.where}</Mono></Section>}
      {(s.exports ?? []).length > 0 && <Section label="Exports"><Chips names={s.exports!} /></Section>}
    </>
  );
}

export interface SemanticDetailsProps {
  resourceType: string;
  name: string;
  label?: string | null;
  semantic?: SemanticInfo | null;
  /** Metrics / saved queries built on this one. */
  usedBy?: string[];
}

/** Details for semantic_model / metric / saved_query nodes (side pane and Docs). */
export function SemanticDetails({ resourceType, name, label, semantic, usedBy = [] }: SemanticDetailsProps) {
  const s = semantic ?? {};
  return (
    <div className="flex flex-col gap-3 bg-surface-elevated/40 rounded-lg p-3">
      {label && label !== name && <Section label="Label"><span className="text-xs text-gray-200">{label}</span></Section>}
      {resourceType === 'semantic_model' && <SemanticModelDetails s={s} />}
      {resourceType === 'metric' && <MetricDetails s={s} />}
      {resourceType === 'saved_query' && <SavedQueryDetails s={s} />}
      {usedBy.length > 0 && <Section label="Used by"><Chips names={usedBy} /></Section>}
    </div>
  );
}
