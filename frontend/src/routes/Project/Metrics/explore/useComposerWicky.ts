// The query composer's "ask in words" (Pro, plan 16): a line starting with `?` goes to Wicky's
// Query data mode (plan 09), and its MetricFlow request comes back as a widget for the composer
// to show as chips — the user sees and edits exactly what will run. Asks go into one Wicky
// conversation per composer, so they're in Wicky's history too.
import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiApi, type AiQueryPayload } from '../../../../lib/aiApi';
import type { DashboardWidget } from '../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import { widgetFromQuery } from '../dashboards/dashboardModel';
import { errorText } from '../dashboards/useDashboards';
import { EXPLORE_HEIGHT, EXPLORE_ID } from '../lib/exploreWidget';

export const WICKY_PREFIX = '?';

export function useComposerWicky(projectId: number, catalog: SemanticCatalogDto) {
  const qc = useQueryClient();
  const conversation = useRef<number | null>(null);
  const [asking, setAsking] = useState(false);

  /** Wicky's reading of `question` as the explorer's widget; throws with a message to show. */
  const ask = useCallback(async (question: string): Promise<DashboardWidget> => {
    setAsking(true);
    try {
      if (conversation.current === null) {
        conversation.current = (await aiApi.createConversation(projectId)).id;
        qc.invalidateQueries({ queryKey: ['ai-conversations', projectId] });
      }
      const messages = await aiApi.writeQuery(projectId, conversation.current, { content: question, unique_id: null });
      qc.invalidateQueries({ queryKey: ['ai-conversation', projectId] });
      const payload = messages.find((m) => m.role === 'query')?.payload as AiQueryPayload | undefined;
      const request = payload?.metric_request;
      if (!request) {
        throw new Error("Wicky couldn't answer that with your metrics (it wrote plain SQL instead). Ask in Wicky (⌘I) to run it there.");
      }
      return { ...widgetFromQuery(request, catalog, []), id: EXPLORE_ID, width: 100, height: EXPLORE_HEIGHT };
    } catch (err) {
      throw new Error(errorText(err) ?? 'Asking Wicky failed', { cause: err });
    } finally {
      setAsking(false);
    }
  }, [projectId, catalog, qc]);

  return { ask, asking };
}
