// "Save as saved query" in a chart's ⋯ menu (dashboard widgets, the metric page's charts, the
// Investigate widget): asks for a name, then shows the YAML change in the review window
// (POST …/saved-queries/propose → a `saved_query` proposal); the file is written only when it's
// accepted there. The query saved is the chart's own (its metrics, group-bys and filters; no dates).
import { useState } from 'react';
import { Bookmark } from 'lucide-react';
import type { AiProposalDto } from '../../../../lib/aiApi';
import type { WidgetResultDto } from '../../../../lib/dashboardsApi';
import { alertDialog, promptDialog } from '../../../../lib/dialogs';
import { semanticApi } from '../../../../lib/semanticApi';
import { ProposalReviewModal } from '../../components/Wicky/ProposalReviewModal';
import { errorText } from '../dashboards/useDashboards';
import type { WidgetMenuItem } from '../dashboards/widgets/WidgetMenu';
import { savedQueryName } from '../lib/chartExport';
import { mainQuery, savedQueryBody } from '../lib/exploreWidget';

export function useSaveAsSavedQuery(projectId: number) {
  const [review, setReview] = useState<AiProposalDto | null>(null);

  const save = async (result: WidgetResultDto | null | undefined) => {
    const main = mainQuery(result ?? undefined);
    if (!main) return;
    const body = savedQueryBody(main.body);
    const name = await promptDialog('Name for the saved query (lowercase, digits, underscores). You’ll review the YAML before anything is written.',
      savedQueryName(body), { title: 'Save as saved query', confirmLabel: 'Review' });
    if (!name?.trim()) return;
    try {
      setReview(await semanticApi.proposeSavedQuery(projectId, { ...body, name: name.trim() }));
    } catch (err) {
      await alertDialog(errorText(err) ?? 'Saving failed', { title: "Couldn't save the query" });
    }
  };

  const item = (result: WidgetResultDto | null | undefined): WidgetMenuItem => ({
    label: 'Save as saved query', icon: <Bookmark className="w-3.5 h-3.5" />,
    disabled: !mainQuery(result ?? undefined)?.body.metrics?.length, onClick: () => { void save(result); },
  });

  const modal = review && <ProposalReviewModal projectId={projectId} proposal={review} onClose={() => setReview(null)} />;
  return { item, modal };
}
