// The widget a note is about (plan 33), drawn in the note: stored results only (opening a note
// never queries the warehouse), Run to run it, Open as it was for the query view. Runs finish in
// the background (metric_queries_finished re-reads the stored result).
import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { dashboardsApi } from '../../../../lib/dashboardsApi';
import { useProjectEvents } from '../../../../lib/sse';
import { WidgetBody } from '../dashboards/widgets/WidgetBody';
import { useSemanticStatus } from '../../components/semantic/useSemantic';
import { useSemanticCatalog } from '../useMetricExplorer';
import { NOTE_WIDGET_HEIGHT, noteWidgetUrl, widgetFromNote, widgetSummary } from './lib/noteWidget';

const KEY = 'note-widget';

export function NoteWidgetPreview({ projectId, saved, onNavigate }: {
  projectId: number; saved: Record<string, unknown>; onNavigate?: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const widget = useMemo(() => widgetFromNote(saved), [saved]);
  const { data: status } = useSemanticStatus(projectId);
  const { data: catalog } = useSemanticCatalog(projectId, !!status?.available);
  const labels = useMemo(() => new Map((catalog?.metrics ?? []).map((m) => [m.name, m.label || m.name])), [catalog]);
  const queryKey = [KEY, projectId, JSON.stringify(saved)];
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'metric_queries_finished') qc.invalidateQueries({ queryKey: [KEY, projectId] });
  }, [projectId, qc]));
  const result = useQuery({
    queryKey,
    queryFn: async () => (await dashboardsApi.previewExplore(projectId, widget!, { run: false })).widget,
    enabled: !!widget && !!status?.can_query,
    retry: false,
    staleTime: 60_000,
  });
  const run = useMutation({
    mutationFn: async () => (await dashboardsApi.previewExplore(projectId, widget!, { run: true })).widget,
    onSuccess: (r) => qc.setQueryData(queryKey, r),
  });
  const open = () => { onNavigate?.(); navigate(noteWidgetUrl(projectId, saved)); };

  return (
    <section className="flex flex-col gap-1.5 pt-3 border-t border-gray-800">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 min-w-0 text-[11px] font-semibold uppercase tracking-wide text-gray-500 truncate" title={widgetSummary(saved)}>
          Written about · <span className="normal-case font-normal tracking-normal">{widgetSummary(saved)}</span>
        </h3>
        <button onClick={open} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200">
          <ExternalLink className="w-3 h-3" />Open as it was
        </button>
      </div>
      {!widget && <p className="text-[11px] text-gray-500">This widget can't be shown here.</p>}
      {widget && status && !status.can_query && <p className="text-[11px] text-gray-500">{status.reason || 'Metrics can\'t be queried in this project right now.'}</p>}
      {widget && status?.can_query && (
        <div className="rounded border border-gray-800 bg-surface-app p-1" style={{ height: NOTE_WIDGET_HEIGHT }}>
          <WidgetBody projectId={projectId} widget={widget} result={result.data} labels={labels} height={NOTE_WIDGET_HEIGHT - 8}
            loading={result.isLoading} refreshing={run.isPending || result.data?.status === 'running'} monitors={[]} filtered updating={false}
            onRun={() => run.mutate()} onPick={null} onPickMenu={null} drilled={null} />
        </div>
      )}
    </section>
  );
}
