// Right rail. "Widgets": the widget types; drag one onto the canvas (or click to add it at the
// end). "Configure": the selected widget's settings (WidgetSettings, shared with Drill into…).
import { useEffect, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { BarChart3, Gauge, LineChart, ListOrdered, Table2, Type } from 'lucide-react';
import type { DashboardWidget, WidgetType } from '../../../../../lib/dashboardsApi';
import { clampCanvasWidth, WIDGET_TYPES, widgetInfo } from '../dashboardModel';
import { FIELD, Row } from './TypeOptions';
import { FloatingRail, type Rail } from './RailResize';
import { WidgetSettings, type WidgetSettingsProps } from './WidgetSettings';

export const WIDGET_ICONS: Record<WidgetType, typeof Gauge> = {
  summary: Gauge, timeseries: LineChart, bar: BarChart3, leaderboard: ListOrdered, table: Table2, text: Type,
};

export type RailTab = 'widgets' | 'configure';

function PaletteItem({ type, onAdd }: { type: WidgetType; onAdd: () => void }) {
  const info = widgetInfo(type);
  const Icon = WIDGET_ICONS[type];
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `type:${type}`, data: { kind: 'type', type } });
  return (
    <button ref={setNodeRef} {...attributes} {...listeners} type="button" onClick={onAdd}
      className={`flex items-start gap-2.5 w-full p-2 text-left rounded border border-gray-800 bg-surface-app hover:border-gray-600 cursor-grab ${isDragging ? 'opacity-40' : ''}`}>
      <span className="flex items-center justify-center w-8 h-8 shrink-0 rounded bg-brand-950/50 text-brand-300"><Icon className="w-4 h-4" /></span>
      <span className="flex flex-col min-w-0">
        <span className="text-xs font-medium text-gray-100">{info.label}</span>
        <span className="text-[11px] leading-snug text-gray-500">{info.description}</span>
      </span>
    </button>
  );
}

interface Props extends Omit<WidgetSettingsProps, 'widget'> {
  tab: RailTab;
  onTab: (tab: RailTab) => void;
  widget: DashboardWidget | null;
  onAddType: (type: WidgetType) => void;
  rail: Rail;
  canvasWidth: number;
  onCanvasWidth: (px: number) => void;
}

/** The dashboard's fixed width: edited as text, applied on Enter or blur (clamped). */
function CanvasWidth({ value, onChange }: { value: number; onChange: (px: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0) onChange(clampCanvasWidth(n)); else setDraft(String(value));
  };
  return (
    <Row label="Dashboard width" hint="Fixed, so widgets keep their size whatever the window or these panes do. You can also drag the dashboard's right edge.">
      <div className="flex items-center gap-1.5">
        <input value={draft} inputMode="numeric" onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} className={`${FIELD.replace('w-full ', '')} w-24`} aria-label="Dashboard width" />
        <span className="text-[11px] text-gray-500">px</span>
      </div>
    </Row>
  );
}

export function WidgetsRail({ tab, onTab, widget, onAddType, rail, canvasWidth, onCanvasWidth, ...config }: Props) {
  const shown = widget ? tab : 'widgets';
  return (
    <FloatingRail side="right" rail={rail}>
      <div className="flex items-center gap-1 px-3 border-b border-gray-800" role="tablist">
        {(['widgets', 'configure'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={shown === t} disabled={t === 'configure' && !widget} onClick={() => onTab(t)}
            className={`px-2 py-2 text-xs border-b-2 -mb-px disabled:opacity-40 ${shown === t ? 'border-brand-500 text-gray-100' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            {t === 'widgets' ? 'Widgets' : 'Configure'}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {shown === 'widgets' || !widget ? (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] text-gray-500">Drag a widget onto the dashboard, or click to add it at the end.</p>
            {WIDGET_TYPES.map((t) => <PaletteItem key={t.type} type={t.type} onAdd={() => onAddType(t.type)} />)}
            <div className="pt-3 mt-1 border-t border-gray-800"><CanvasWidth value={canvasWidth} onChange={onCanvasWidth} /></div>
          </div>
        ) : (
          <WidgetSettings {...config} widget={widget} />
        )}
      </div>
    </FloatingRail>
  );
}
