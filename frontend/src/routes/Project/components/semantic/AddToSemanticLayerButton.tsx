// "Add to semantic layer" (Pro) for a model with no semantic model yet: opens Wicky, which
// drafts the semantic model + metrics and shows them for review (QuickActions runs it).
import { useState } from 'react';
import { Boxes } from 'lucide-react';
import type { GraphDto, ModelNode } from '../../../../lib/api';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { useProEntitled } from '../../RunHistory/usePerformance';
import { semanticModelOf } from '../../lib/semantic';
import { openWicky } from '../../lib/wickyEvents';
import { UpgradeModal } from '../UpgradeModal';

export const SEMANTIC_DRAFT_FEATURE = 'Semantic layer drafts';
const LABEL = 'Add to semantic layer';
const TITLE = 'Wicky drafts a semantic model and starting metrics, validated with MetricFlow and run against the '
  + 'warehouse. You review every change before anything is written.';

/** Start a draft for `uniqueId` in the Wicky pane. */
export function startSemanticDraft(uniqueId: string): void {
  openWicky({ uniqueId, action: 'semantic_draft' });
}

export function AddToSemanticLayerButton({ model, graph }: { model: ModelNode; graph: GraphDto | null | undefined }) {
  const { entitled, loading } = useProEntitled();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  if (loading || model.resource_type !== 'model' || semanticModelOf(graph, model)) return null;
  return (
    <>
      {entitled ? (
        <button
          onClick={() => startSemanticDraft(model.unique_id)}
          title={TITLE}
          className="flex items-center justify-center gap-2 w-full py-2 text-sm rounded bg-surface-elevated hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors"
        >
          <Boxes className="w-4 h-4" />{LABEL}
        </button>
      ) : (
        <ProFeatureButton onClick={() => setUpgradeOpen(true)} title={`${LABEL} (wickd Pro)`}>{LABEL}</ProFeatureButton>
      )}
      {upgradeOpen && <UpgradeModal feature={SEMANTIC_DRAFT_FEATURE} onClose={() => setUpgradeOpen(false)} />}
    </>
  );
}
