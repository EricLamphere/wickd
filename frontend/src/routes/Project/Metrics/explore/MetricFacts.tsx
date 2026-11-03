// A metric page's facts under its title, as a definition list rather than code tiles: how it's
// calculated (in words), its filter (Jinja stripped), the metrics it's built from, the
// semantic models it reads, and its default grain.
import type { SemanticInfo } from '../../../../lib/api';
import type { CatalogMetric } from '../../../../lib/semanticApi';
import { calculationParts, readableFilter, type CalcPart } from '../lib/metricPage';

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-200 break-words">{children}</dd>
    </div>
  );
}

/** A name or expression inside a sentence: monospace, but no box around it. */
function Term({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[13px] text-brand-200">{children}</span>;
}

function Sentence({ parts }: { parts: CalcPart[] }) {
  return <>{parts.map((p, i) => ('code' in p ? <Term key={i}>{p.code}</Term> : <span key={i}>{p.text}</span>))}</>;
}

function List({ names, onOpen }: { names: string[]; onOpen?: (name: string) => void }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {names.map((n) => (onOpen ? (
        <button key={n} onClick={() => onOpen(n)} className="font-mono text-[13px] text-brand-300 hover:text-brand-200 hover:underline">{n}</button>
      ) : <Term key={n}>{n}</Term>))}
    </span>
  );
}

export function MetricFacts({ metric, semantic, onOpenMetric }: {
  metric: CatalogMetric; semantic: SemanticInfo | null; onOpenMetric: (name: string) => void;
}) {
  const s = semantic ?? {};
  const calc = calculationParts({ ...s, type: s.type ?? metric.type });
  const inputs = s.input_metrics ?? [];
  return (
    <dl className="grid gap-x-8 gap-y-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))' }}>
      {calc.length > 0 && <Fact label="How it's calculated"><Sentence parts={calc} /></Fact>}
      {s.filter && <Fact label="Only counts rows where"><Term>{readableFilter(s.filter)}</Term></Fact>}
      {inputs.length > 0 && <Fact label="Built from"><List names={inputs} onOpen={onOpenMetric} /></Fact>}
      {metric.semantic_models.length > 0 && (
        <Fact label={metric.semantic_models.length === 1 ? 'Semantic model' : 'Semantic models'}><List names={metric.semantic_models} /></Fact>
      )}
      {s.time_granularity && <Fact label="Default grain">{s.time_granularity}</Fact>}
    </dl>
  );
}
