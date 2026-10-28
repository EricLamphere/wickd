// Metrics page, no metrics yet: pick a model and Wicky drafts its semantic model + metrics (Pro).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Boxes } from 'lucide-react';
import { api } from '../../../lib/api';
import { ProFeatureButton } from '../../../components/ProFeatureButton';
import { SEMANTIC_DRAFT_FEATURE, startSemanticDraft } from '../components/semantic/AddToSemanticLayerButton';
import { UpgradeModal } from '../components/UpgradeModal';
import { useProEntitled } from '../RunHistory/usePerformance';
import { semanticModelOf } from '../lib/semantic';

const FIELD = 'px-2 py-1.5 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';

export function DraftFromModel({ projectId }: { projectId: number }) {
  const { entitled, loading } = useProEntitled();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const { data: graph } = useQuery({ queryKey: ['graph', projectId], queryFn: () => api.models.graph(projectId) });
  const models = useMemo(
    () => (graph?.nodes ?? [])
      .filter((n) => n.resource_type === 'model' && !semanticModelOf(graph, n) && !n.name.startsWith('metricflow_'))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [graph],
  );
  const [picked, setPicked] = useState('');
  const uniqueId = picked || models[0]?.unique_id || '';
  if (loading) return null;

  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-xs text-gray-400">Start from one of your models: Wicky drafts the semantic model and metrics, checks them with MetricFlow and runs each one, and you review the YAML before anything is written.</p>
      {entitled ? (
        <div className="flex items-center gap-2">
          <select value={uniqueId} onChange={(e) => setPicked(e.target.value)} className={FIELD} aria-label="Model">
            {models.map((m) => <option key={m.unique_id} value={m.unique_id}>{m.name}</option>)}
          </select>
          <button
            onClick={() => uniqueId && startSemanticDraft(uniqueId)}
            disabled={!uniqueId}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40"
          >
            <Boxes className="w-3.5 h-3.5" />Draft from this model
          </button>
        </div>
      ) : (
        <ProFeatureButton onClick={() => setUpgradeOpen(true)} title="Draft a semantic model from a model (wickd Pro)">
          Draft from a model…
        </ProFeatureButton>
      )}
      {upgradeOpen && <UpgradeModal feature={SEMANTIC_DRAFT_FEATURE} onClose={() => setUpgradeOpen(false)} />}
    </div>
  );
}
