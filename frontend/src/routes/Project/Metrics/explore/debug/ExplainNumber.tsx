// Debug tab, Pro: "Why is this number this?" — a written explanation built from the stored checks
// and the definition, its evidence linking back to the plan steps.
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ProFeatureButton } from '../../../../../components/ProFeatureButton';
import type { ExplanationDto, FindingDto } from '../../../../../lib/metricDebugApi';
import type { MetricQueryBody } from '../../../../../lib/semanticApi';
import { UpgradeModal } from '../../../components/UpgradeModal';
import { useProEntitled } from '../../../RunHistory/usePerformance';
import { errorText } from '../../dashboards/useDashboards';
import { useExplainNumber } from './useMetricDebug';

const SEVERITY_TONE = { fail: 'text-red-300', warn: 'text-amber-300', info: 'text-gray-300' } as const;

export function ExplainNumberButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <ProFeatureButton onClick={onClick} disabled={busy}
      title="Write up what the checks and the definition say about this number, most likely cause first (Pro)">
      {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Explain this number
    </ProFeatureButton>
  );
}

export function useExplainState(projectId: number) {
  const { entitled } = useProEntitled();
  const [upgrade, setUpgrade] = useState(false);
  const explain = useExplainNumber(projectId);
  const start = (body: MetricQueryBody) => (entitled ? explain.mutate(body) : setUpgrade(true));
  const modal = upgrade ? <UpgradeModal feature="Metric explanations" onClose={() => setUpgrade(false)} /> : null;
  return { start, modal, busy: explain.isPending, data: explain.data, error: explain.error, reset: explain.reset };
}

export function Explanation({ data, error, findings, onShowFinding }: {
  data: ExplanationDto | undefined; error: unknown; findings: FindingDto[]; onShowFinding: (f: FindingDto) => void;
}) {
  if (error) return <p className="px-3 py-2 text-[11px] text-red-300 rounded border border-red-900/60 bg-red-950/30">{errorText(error)}</p>;
  if (!data) return null;
  const byId = new Map(findings.map((f) => [f.id, f]));
  return (
    <section aria-label="Explanation" className="flex flex-col gap-1.5 px-3 py-2 rounded border border-brand-900/60 bg-brand-950/20">
      <p className="text-xs font-medium text-gray-100">{data.headline}</p>
      <ul className="flex flex-col gap-1">
        {data.points.map((p, i) => (
          <li key={i} className={`text-[11px] ${SEVERITY_TONE[p.severity]}`}>
            {p.text}
            {p.finding_ids.map((id) => byId.get(id)).filter((f): f is FindingDto => !!f).map((f) => (
              <button key={f.id} onClick={() => onShowFinding(f)} className="ml-1.5 text-[10px] text-brand-400 hover:text-brand-300 underline">
                {f.title}
              </button>
            ))}
          </li>
        ))}
      </ul>
      {data.causes.length > 1 && (
        <p className="text-[10px] text-gray-500">Other possible causes: {data.causes.slice(1).map((c) => c.title).join(' · ')}</p>
      )}
    </section>
  );
}
