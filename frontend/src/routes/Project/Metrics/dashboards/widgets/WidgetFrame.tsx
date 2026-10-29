// A widget on the canvas: header (grip, title, monitor pill, "as of", ⋯ menu), body, notes,
// and resize handles (right edge, bottom edge, corner). Click selects it (its settings open in
// the right rail). Clicking a value (bar, stacked segment, Top N row) splits the widget top and
// bottom with its timeseries; right-click a value for its menu (show timeseries, dashboard
// filter, drill into…, explorer). While a
// metric is dragged over it, it says whether it can take it.
import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import {
  Copy, CopyPlus, ExternalLink, GripVertical, Info, Loader2, MoreHorizontal, Plus, RefreshCw, Trash2, Ban,
} from 'lucide-react';
import type { DashboardDoc, DashboardWidget } from '../../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../../lib/semanticApi';
import { relativeTime } from '../../../lib/relativeTime';
import { statusStyle, type MetricMonitorState } from '../../monitors/monitorView';
import {
  HEIGHT_LOCK, MAX_HEIGHT, opt, pxToWidth, resized, toCsv, widthCss, type Resized, type ResizeLimits, type Size,
} from '../dashboardModel';
import type { Pick } from '../drill';
import { DrillPanel } from './DrillPanel';
import { InspectDialog } from './InspectDialog';
import { ValueMenu } from './ValueMenu';
import { startDrag } from '../builder/drag';
import { SqlDialog } from './SqlDialog';
import { formatOf, WidgetBody, type BodyProps } from './WidgetBody';

const HEADER_PX = 28;

/** One widget failing to draw shows its error instead of taking the whole page down. */
class WidgetErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('dashboard widget failed to render', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-col items-center justify-center gap-1 h-full px-3 text-center text-xs text-red-300">
        <span>This widget couldn't be drawn.</span>
        <span className="text-[11px] text-gray-500 line-clamp-3">{this.state.error.message}</span>
      </div>
    );
  }
}

export interface DropHint {
  ok: boolean;
  text: string;
}

export interface FrameActions {
  onSelect: () => void;
  onOpenInExplorer: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onResize: (size: Size) => void;
}

interface Props extends Omit<BodyProps, 'height' | 'onPick' | 'onPickMenu' | 'drilled'>, FrameActions {
  /** a picked value applied to the dashboard's filters */
  onApplyFilter: (pick: Pick) => void;
  /** the widget's query in the explorer, filtered to a picked value */
  onOpenFiltered: (pick: Pick) => void;
  /** for Drill into…'s breakdown dimensions */
  catalog: SemanticCatalogDto;
  /** Drill into…'s chosen draft widgets onto the dashboard, after this one */
  onAddDrilled: (widgets: DashboardWidget[]) => void;
  /** the dashboard (Drill into… plans its drafts with its period and filters) */
  doc: DashboardDoc;
  slug: string;
  title: string;
  selected: boolean;
  present: boolean;
  monitorStatus: MetricMonitorState | null;
  dropHint: DropHint | null;
  /** the canvas width (px): widths are percentages of it */
  containerWidth: number;
  dragHandle?: React.HTMLAttributes<HTMLButtonElement>;
  nodeRef?: (el: HTMLElement | null) => void;
  style?: React.CSSProperties;
}

function Menu({ items, onClose }: { items: { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" className="absolute right-0 top-6 z-30 min-w-[11rem] py-1 bg-surface-elevated border border-gray-700 rounded shadow-xl">
      {items.map((item) => (
        <button key={item.label} role="menuitem" disabled={item.disabled} onClick={(e) => { e.stopPropagation(); onClose(); item.onClick(); }}
          className={`flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-gray-800 disabled:opacity-40 ${item.danger ? 'text-red-300' : 'text-gray-300'}`}>
          {item.icon}{item.label}
        </button>
      ))}
    </div>
  );
}

type Axes = { x: boolean; y: boolean };

/**
 * Drag an edge or the corner: the widget follows the pointer (width as a percent of the canvas,
 * height in px, with a gentle snap) and the size is saved on release; Escape cancels. Dragging
 * past the edge of the view scrolls it (see builder/drag.ts, which also ends drags released
 * outside the window).
 */
/** What the widget can grow into without wrapping, and its row neighbours' heights, measured at drag start. */
function limitsFor(section: HTMLElement | null, containerWidth: number): ResizeLimits {
  const board = section?.closest<HTMLElement>('.dashboard-grid');
  if (!section || !board) return {};
  const b = board.getBoundingClientRect();
  const left = section.getBoundingClientRect().left - b.left;
  const room = b.right - section.getBoundingClientRect().left;
  const neighbours = Array.from(board.children)
    .filter((el): el is HTMLElement => el instanceof HTMLElement && el !== section && Math.abs(el.offsetTop - section.offsetTop) < 2)
    .map((el) => Math.round(el.getBoundingClientRect().height));
  return { maxWidth: Math.min(100, pxToWidth(room, containerWidth)), neighbours, left };
}

/** Where to draw the lock-point guides, measured at drag start: across the board, from this widget. */
export interface Guides {
  /** px from the widget's left / top edge back to the board's */
  left: number;
  top: number;
  boardWidth: number;
  boardHeight: number;
  /** px from the widget's left edge to the board's right edge */
  room: number;
  neighbours: number[];
  axes: Axes;
}

function useResize(widget: DashboardWidget, containerWidth: number, onResize: Props['onResize']) {
  const [preview, setPreview] = useState<Resized | null>(null);
  const [guides, setGuides] = useState<Guides | null>(null);
  const start = (axes: Axes) => (e: React.PointerEvent<HTMLElement>) => {
    const from: Size = { width: widget.width, height: widget.height };
    const section = e.currentTarget.closest<HTMLElement>('[data-widget-id]');
    const limits = limitsFor(section, containerWidth);
    const board = section?.closest<HTMLElement>('.dashboard-grid');
    if (section && board) {
      const b = board.getBoundingClientRect();
      const r = section.getBoundingClientRect();
      setGuides({ left: r.left - b.left, top: r.top - b.top, boardWidth: b.width, boardHeight: Math.max(b.height, r.height + 400),
        room: b.right - r.left, neighbours: limits.neighbours ?? [], axes });
    }
    let last: Resized = { ...from, locked: { x: false, y: false } };
    // the canvas shows its quarter guides while a width is being dragged (styles.css)
    if (axes.x) document.body.dataset.dashResize = 'x';
    startDrag(e, {
      scroller: e.currentTarget.closest<HTMLElement>('.overflow-auto'),
      cursor: axes.x && axes.y ? 'nwse-resize' : axes.x ? 'ew-resize' : 'ns-resize',
      move: (dx, dy) => { last = resized(from, dx, dy, containerWidth, axes, limits); setPreview(last); },
      end: (commit) => {
        delete document.body.dataset.dashResize;
        setPreview(null);
        setGuides(null);
        if (commit && (last.width !== from.width || last.height !== from.height)) onResize({ width: last.width, height: last.height });
      },
    });
  };
  return { preview, guides, start };
}

const label = (kind: 'grid' | 'row') => `absolute px-1 text-[9px] font-mono rounded bg-surface-app/90 ${kind === 'row' ? 'text-amber-300' : 'text-brand-300'}`;
const lineColor = (on: boolean, kind: 'grid' | 'row') => (on ? 'border-brand-400' : kind === 'row' ? 'border-amber-400/60' : 'border-brand-500/45');

/**
 * Lines at the height lock points while resizing, drawn across the board from this widget: every
 * GRID_LOCK px from the top of its row plus the bottoms of the other widgets in the row ("row").
 * The width lock lines are the dashboard's own grid, drawn by the canvas (Canvas WidthGuides).
 */
function GuideLines({ guides, size }: { guides: Guides; size: Size }) {
  const heights = guides.axes.y
    ? Array.from({ length: Math.floor(MAX_HEIGHT / HEIGHT_LOCK) }, (_, i) => (i + 1) * HEIGHT_LOCK)
      .filter((h) => h <= Math.max(size.height + 3 * HEIGHT_LOCK, HEIGHT_LOCK * 4))
    : [];
  const rows = guides.axes.y ? [...new Set(guides.neighbours)].filter((h) => !heights.includes(h)) : [];
  const hLine = (h: number, kind: 'grid' | 'row') => (
    <div key={`h-${kind}-${h}`} className="absolute pointer-events-none" style={{ top: h, left: -guides.left, width: guides.boardWidth }}>
      <div className={`border-t border-dashed ${lineColor(h === size.height, kind)}`} />
      <span className={`${label(kind)} -top-2`} style={{ left: guides.left > 40 ? 2 : guides.boardWidth - 36 }}>{kind === 'row' ? 'row' : h}</span>
    </div>
  );
  return (
    <div className="absolute inset-0 z-40 pointer-events-none overflow-visible" aria-hidden="true" data-export-hide="">
      {heights.map((h) => hLine(h, 'grid'))}
      {rows.map((h) => hLine(h, 'row'))}
    </div>
  );
}

function ResizeHandles({ start }: { start: (axes: Axes) => (e: React.PointerEvent<HTMLElement>) => void }) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <>
      <div role="separator" aria-orientation="vertical" aria-label="Resize width" onPointerDown={start({ x: true, y: false })} onClick={stop}
        className="absolute z-20 top-2 bottom-4 -right-1.5 w-3 cursor-ew-resize rounded hover:bg-brand-500/25" data-export-hide="" />
      <div role="separator" aria-orientation="horizontal" aria-label="Resize height" onPointerDown={start({ x: false, y: true })} onClick={stop}
        className="absolute z-20 left-2 right-4 -bottom-1.5 h-3 cursor-ns-resize rounded hover:bg-brand-500/25" data-export-hide="" />
      <div role="separator" aria-label="Resize" onPointerDown={start({ x: true, y: true })} onClick={stop} data-export-hide=""
        className="absolute z-30 -right-1.5 -bottom-1.5 w-5 h-5 cursor-nwse-resize flex items-end justify-end p-1.5 opacity-40 group-hover:opacity-100">
        <span className="block w-2 h-2 border-r-2 border-b-2 border-gray-400 rounded-br-sm" />
      </div>
    </>
  );
}

export function WidgetFrame(props: Props) {
  const { widget, result, title, selected, present, monitorStatus, dropHint, containerWidth, dragHandle, nodeRef, style } = props;
  const [menu, setMenu] = useState(false);
  const [sql, setSql] = useState(false);
  const { preview, guides, start } = useResize(widget, containerWidth, props.onResize);
  const [drill, setDrill] = useState<Pick | null>(null);
  const [menuAt, setMenuAt] = useState<{ pick: Pick; x: number; y: number } | null>(null);
  const [inspect, setInspect] = useState<Pick | null>(null);
  // A drill-down on a dimension the widget no longer shows goes away
  const dims = [opt<string | null>(widget, 'dimension', null), opt<string | null>(widget, 'stack_by', null),
    ...opt<string[]>(widget, 'dimensions', [])].filter(Boolean);
  const drilled = drill && drill.values.every((v) => dims.includes(v.dimension)) ? drill : null;
  const valueActions = {
    onDrill: (p: Pick) => setDrill(p),
    onApplyFilter: props.onApplyFilter,
    onInspect: (p: Pick) => setInspect(p),
    onOpenInExplorer: props.onOpenFiltered,
  };
  const size = preview ?? widget;
  const height = size.height;
  const notes = result?.notes ?? [];
  const bodyHeight = height - HEADER_PX - 16 - notes.length * 14;
  // A drill-down splits the widget top and bottom, so the timeseries gets the full width
  const chartHeight = drilled && result ? Math.floor((bodyHeight - 8) / 2) : bodyHeight;
  const pill = monitorStatus?.status && monitorStatus.status !== 'ok' ? statusStyle(monitorStatus.status) : null;
  const text = widget.type === 'text';
  const hasData = result?.status === 'ok' && Object.keys(result.queries).length > 0;
  const firstData = result ? Object.values(result.queries).find((q) => q.status === 'ok') : undefined;

  return (
    <section ref={nodeRef} data-widget-id={widget.id} onClick={(e) => { e.stopPropagation(); if (!present) props.onSelect(); }}
      className={`group relative flex flex-col min-w-0 px-3 py-2 rounded border transition-colors ${text ? 'bg-transparent' : 'bg-surface-panel'} ${
        dropHint ? (dropHint.ok ? 'border-brand-500 ring-2 ring-brand-500/30' : 'border-red-500/70') : preview ? 'border-brand-500' :
        selected ? 'border-brand-600 ring-1 ring-brand-600/40' : text ? 'border-transparent hover:border-gray-800' : 'border-gray-800'}`}
      style={{ width: widthCss(size.width), height: size.height, flex: 'none', ...(preview ? { zIndex: 30 } : {}), ...style }}>
      <header className="flex items-center gap-1.5 shrink-0" style={{ height: HEADER_PX - 6 }}>
        {!present && dragHandle && (
          <button {...dragHandle} aria-label="Drag to move" onClick={(e) => e.stopPropagation()}
            className="-ml-1.5 text-gray-600 opacity-0 group-hover:opacity-100 hover:text-gray-200 cursor-grab" data-export-hide="">
            <GripVertical className="w-4 h-4" />
          </button>
        )}
        {!text && <h3 className="flex-1 min-w-0 text-xs font-medium text-gray-200 truncate" title={title}>{title}</h3>}
        {text && <div className="flex-1" />}
        {pill && (
          <span title={monitorStatus?.headline} className={`shrink-0 px-1.5 py-px text-[10px] rounded border ${pill.pill}`}>{pill.label}</span>
        )}
        {result?.ran_at && (
          <span className="shrink-0 text-[10px] text-gray-500" title={new Date(result.ran_at).toLocaleString()} data-export-asof={result.ran_at}>
            {props.refreshing ? <Loader2 className="inline w-3 h-3 animate-spin" /> : relativeTime(result.ran_at)}
          </span>
        )}
        {!present && (
          <div className="relative shrink-0" data-export-hide="">
            <button onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }} aria-label="Widget menu"
              className="p-0.5 text-gray-500 opacity-60 group-hover:opacity-100 hover:text-gray-200">
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {menu && (
              <Menu onClose={() => setMenu(false)} items={[
                ...(text ? [] : [
                  { label: 'Open in explorer', icon: <ExternalLink className="w-3.5 h-3.5" />, onClick: props.onOpenInExplorer, disabled: !firstData },
                  { label: 'View SQL', icon: <Info className="w-3.5 h-3.5" />, onClick: () => setSql(true), disabled: !result || !Object.keys(result.queries).length },
                  { label: 'Copy CSV', icon: <Copy className="w-3.5 h-3.5" />, disabled: !hasData,
                    onClick: () => { if (firstData) navigator.clipboard?.writeText(toCsv(firstData.columns, firstData.rows)); } },
                  { label: 'Refresh', icon: <RefreshCw className="w-3.5 h-3.5" />, onClick: props.onRun, disabled: props.refreshing || !widget.metrics?.length },
                ]),
                { label: 'Duplicate', icon: <CopyPlus className="w-3.5 h-3.5" />, onClick: props.onDuplicate },
                { label: 'Remove', icon: <Trash2 className="w-3.5 h-3.5" />, onClick: props.onRemove, danger: true },
              ]} />
            )}
          </div>
        )}
      </header>
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col gap-2">
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          <WidgetErrorBoundary resetKey={`${JSON.stringify(widget)}|${result?.ran_at ?? ''}|${result?.status ?? ''}`}>
            <WidgetBody {...props} height={Math.max(40, chartHeight)} drilled={drilled}
              onPick={(p) => setDrill((cur) => (cur && JSON.stringify(cur) === JSON.stringify(p) ? null : p))}
              onPickMenu={(p, x, y) => setMenuAt({ pick: p, x, y })} />
          </WidgetErrorBoundary>
        </div>
        {drilled && result && (
          <div className="flex-1 min-w-0 min-h-0 overflow-hidden pt-2 border-t border-gray-800" onClick={(e) => e.stopPropagation()}>
            <WidgetErrorBoundary resetKey={JSON.stringify(drilled)}>
              <DrillPanel projectId={props.projectId} widget={widget} result={result} pick={drilled} labels={props.labels}
                format={formatOf(widget)} height={Math.max(60, chartHeight)} onClose={() => setDrill(null)} onApplyFilter={props.onApplyFilter} />
            </WidgetErrorBoundary>
          </div>
        )}
      </div>
      {notes.map((n) => <p key={n} className="shrink-0 text-[10px] leading-[14px] text-gray-500 truncate" title={n}>{n}</p>)}
      {dropHint && (
        <div className={`absolute inset-0 z-10 flex items-center justify-center gap-1.5 rounded text-xs font-medium pointer-events-none ${
          dropHint.ok ? 'bg-brand-950/70 text-brand-100' : 'bg-red-950/70 text-red-200'}`}>
          {dropHint.ok ? <Plus className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}{dropHint.text}
        </div>
      )}
      {!present && <ResizeHandles start={start} />}
      {preview && guides && <GuideLines guides={guides} size={preview} />}
      {preview && (
        <span className="absolute z-30 right-3 bottom-3 px-1.5 py-0.5 text-[10px] font-mono rounded bg-gray-900/90 text-gray-200 pointer-events-none">
          <span className={preview.locked.x ? 'text-brand-300' : ''}>{+preview.width.toFixed(1)}%</span>
          {' × '}
          <span className={preview.locked.y ? 'text-brand-300' : ''}>{preview.height}px</span>
          {(preview.locked.x || preview.locked.y) && <span className="ml-1 text-brand-300">· locked</span>}
        </span>
      )}
      {sql && result && <SqlDialog queries={result.queries} onClose={() => setSql(false)} />}
      {menuAt && <ValueMenu pick={menuAt.pick} x={menuAt.x} y={menuAt.y} actions={valueActions} onClose={() => setMenuAt(null)} />}
      {inspect && result && (
        <InspectDialog projectId={props.projectId} slug={props.slug} doc={props.doc} widget={widget} result={result} pick={inspect}
          labels={props.labels} catalog={props.catalog} actions={valueActions}
          onAddToDashboard={present ? null : props.onAddDrilled} onClose={() => setInspect(null)} />
      )}
    </section>
  );
}
