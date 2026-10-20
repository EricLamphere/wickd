import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { GraphDto, ModelNode } from '../../../../lib/api';
import type { ChatRequest } from './AiChat';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { UpgradeModal } from '../UpgradeModal';
import { useAiProposals, useAiStatus, useWickyConversation } from './useAi';
import { AiSetup } from './AiSetup';
import { QuickActions } from './QuickActions';
import { AiChat } from './AiChat';

interface WickyContentProps {
  projectId: number;
  model: ModelNode | null;
  graph: GraphDto | null;
}

const FAILED = new Set(['error', 'warn']);

/** The node failed, or one of its tests did, in the latest run. */
function isFailing(model: ModelNode, graph: GraphDto | null): boolean {
  if (FAILED.has(model.status)) return true;
  return !!graph?.nodes.some(
    (n) => n.resource_type === 'test' && n.attached_node === model.unique_id && FAILED.has(n.status),
  );
}

/** Wicky, the AI assistant (wickd Pro): unlock → set up a local model → document + ask. */
export function WickyContent({ projectId, model, graph }: WickyContentProps) {
  const { status, loading, downloads } = useAiStatus();
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  if (loading || !status) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-gray-500">
        <Loader2 size={14} className="animate-spin" />
      </div>
    );
  }

  if (!status.entitled) {
    return (
      <div className="flex flex-col items-start gap-2 p-3 text-xs text-gray-400">
        <p>Wicky is wickd&rsquo;s AI assistant. It documents models and answers questions about your project, running privately on this machine.</p>
        <ProFeatureButton onClick={() => setUpgradeOpen(true)}>Unlock Wicky</ProFeatureButton>
        {upgradeOpen && <UpgradeModal feature="Wicky" onClose={() => setUpgradeOpen(false)} />}
      </div>
    );
  }

  if (!status.pro_installed) {
    return (
      <p className="p-3 text-xs text-gray-500">
        AI features aren&rsquo;t available in this build (the wickd Pro package is not installed).
      </p>
    );
  }

  if (!status.ready) return <AiSetup status={status} downloads={downloads} />;

  return <WickyReady projectId={projectId} model={model} graph={graph} />;
}

function WickyReady({ projectId, model, graph }: WickyContentProps) {
  const { proposals, progress } = useAiProposals(projectId);
  const chat = useWickyConversation(projectId);
  const [request, setRequest] = useState<ChatRequest | null>(null);
  return (
    <div className="flex flex-col h-full">
      {model && (
        <QuickActions
          key={model.unique_id}
          projectId={projectId}
          model={model}
          proposals={proposals}
          ensureConversation={chat.ensure}
          failing={isFailing(model, graph)}
          onExplainFailure={() => setRequest({
            nonce: Date.now(),
            text: `Explain why ${model.name} is failing`,
            mode: 'explain_failure',
          })}
        />
      )}
      <AiChat
        projectId={projectId}
        model={model}
        progress={progress}
        conversations={chat.conversations}
        activeId={chat.activeId}
        onSelect={chat.select}
        ensureConversation={chat.ensure}
        request={request}
      />
    </div>
  );
}
