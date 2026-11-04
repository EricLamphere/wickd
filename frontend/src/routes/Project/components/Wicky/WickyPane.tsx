import { useEffect, useState } from 'react';
import type { GraphDto } from '../../../../lib/api';
import { WickyContent } from './WickyContent';
import { useWickyPaneLayout, WickyPaneFrame } from './WickyPaneFrame';
import type { ChatRequest } from './AiChat';
import { OPEN_WICKY_EVENT, type OpenWickyDetail } from '../../lib/wickyEvents';

interface WickyPaneProps {
  projectId: number;
  graph: GraphDto | null;
  /** Node selected on the current page (SelectedNodeContext); null → project-level context. */
  selectedNodeId: string | null;
}

/**
 * Wicky, the AI assistant, as a right-hand panel on every project page. Open
 * state and width persist; ⌘I toggles it. Follows the page's selected node.
 */
export function WickyPane({ projectId, graph, selectedNodeId }: WickyPaneProps) {
  const layout = useWickyPaneLayout();
  const { open, setOpen } = layout;
  const [request, setRequest] = useState<ChatRequest | null>(null);
  // Node passed with openWicky() — wins over the page's selection until that changes
  const [contextNodeId, setContextNodeId] = useState<string | null>(null);

  useEffect(() => setContextNodeId(null), [selectedNodeId]);

  const nodeId = contextNodeId ?? selectedNodeId;
  const model = nodeId ? graph?.nodes.find((n) => n.unique_id === nodeId) ?? null : null;

  // Closing drops a request that never reached the chat (e.g. Wicky not set up yet)
  useEffect(() => { if (!open) setRequest(null); }, [open]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const { question = '', chatMode, uniqueId, mode = 'ask', action } = (e as CustomEvent<OpenWickyDetail>).detail ?? {};
      setOpen(true);
      if (uniqueId) setContextNodeId(uniqueId);
      setRequest({ nonce: Date.now(), text: question, mode, chatMode, action });
    };
    window.addEventListener(OPEN_WICKY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_WICKY_EVENT, onOpen);
  }, [setOpen]);

  return (
    <WickyPaneFrame layout={layout} scope={model ? model.name : 'Project'}>
      <WickyContent
        projectId={projectId}
        model={model}
        graph={graph}
        request={request}
        onRequestTaken={() => setRequest(null)}
      />
    </WickyPaneFrame>
  );
}
