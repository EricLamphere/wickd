// One draft widget in Drill into…: its title, a running spinner and its body (the same renderers
// as on the dashboard). Click to configure it in the dialog's settings pane.
import { Loader2, Settings2 } from 'lucide-react';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { widgetTitle } from '../dashboardModel';
import { WidgetBody } from './WidgetBody';

interface Props {
  projectId: number;
  widget: DashboardWidget;
  result: WidgetResultDto | undefined;
  loading: boolean;
  fetching: boolean;
  error: string | null;
  labels: Map<string, string>;
  height: number;
  selected: boolean;
  onSelect: () => void;
  onRun: () => void;
  className?: string;
}

const HEADER_PX = 24;

export function DraftSlot({ projectId, widget, result, loading, fetching, error, labels, height, selected, onSelect, onRun, className = '' }: Props) {
  return (
    <section onClick={onSelect} role="button" tabIndex={0} aria-pressed={selected} aria-label={`Configure ${widgetTitle(widget, labels)}`}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(); } }}
      className={`group flex flex-col min-w-0 px-3 py-2 rounded border bg-surface-app cursor-pointer ${
        selected ? 'border-brand-600 ring-1 ring-brand-600/40' : 'border-gray-800 hover:border-gray-600'} ${className}`}
      style={{ height }}>
      <header className="flex items-center gap-1.5 shrink-0" style={{ height: HEADER_PX }}>
        <h3 className="flex-1 min-w-0 text-xs font-medium text-gray-200 truncate" title={widgetTitle(widget, labels)}>{widgetTitle(widget, labels)}</h3>
        {fetching && <Loader2 className="w-3 h-3 text-gray-500 animate-spin shrink-0" />}
        <Settings2 className={`w-3.5 h-3.5 shrink-0 ${selected ? 'text-brand-300' : 'text-gray-600 group-hover:text-gray-400'}`} aria-hidden="true" />
      </header>
      <div className="flex-1 min-h-0 overflow-hidden">
        {error ? (
          <p className="flex items-center justify-center h-full px-2 text-center text-xs text-red-300">{error}</p>
        ) : (
          <WidgetBody projectId={projectId} widget={widget} result={result} labels={labels} height={Math.max(40, height - HEADER_PX - 20)}
            loading={loading} refreshing={fetching} monitors={[]} filtered updating={false} onRun={onRun}
            onPick={null} onPickMenu={null} drilled={null} />
        )}
      </div>
    </section>
  );
}
