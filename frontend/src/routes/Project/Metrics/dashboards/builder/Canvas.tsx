// The whiteboard: a fixed-width board (the dashboard's canvas_width), centred, that the side
// rails float over; the inset leaves room to scroll it out from under them. Widgets flow left
// to right in file order, each at its own width (percent of the board) and height (px), reorder
// by their grip (dnd-kit sortable) and resize by their edges. The board's right edge drags its
// width. Empty space is a drop zone for new widgets; clicking it clears the selection.
import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, type AnimateLayoutChanges, type SortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LayoutDashboard } from 'lucide-react';
import type { DashboardWidget } from '../../../../../lib/dashboardsApi';
import { clampCanvasWidth, GAP, widthLockLines } from '../dashboardModel';
import { startDrag } from './drag';
import { WidgetFrame } from '../widgets/WidgetFrame';

export const CANVAS_ID = 'canvas';
/** the drop zone pinned to the bottom of the visible canvas while dragging (the grid may be full) */
export const DROP_ZONE_ID = 'canvas-drop-zone';
export const widgetDndId = (id: string) => `widget:${id}`;

type FrameProps = Omit<React.ComponentProps<typeof WidgetFrame>, 'dragHandle' | 'nodeRef' | 'style' | 'containerWidth'>;

// Widgets have different sizes, so the builder reorders them for real while one is dragged
// (useBuilderDnd `ordered`) instead of shifting them by guessed transforms…
const noShift: SortingStrategy = () => null;
// …and dnd-kit animates each widget from its old place to its new one
const animateReflow: AnimateLayoutChanges = ({ isSorting, wasDragging }) => isSorting || wasDragging;

function SortableWidget({ props, containerWidth, present }: { props: FrameProps; containerWidth: number; present: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: widgetDndId(props.widget.id), data: { kind: 'widget', id: props.widget.id }, disabled: present,
    animateLayoutChanges: animateReflow,
  });
  return (
    <WidgetFrame {...props} containerWidth={containerWidth} nodeRef={setNodeRef}
      dragHandle={{ ...attributes, ...listeners } as React.HTMLAttributes<HTMLButtonElement>}
      style={{
        transform: CSS.Translate.toString(transform) ?? undefined, transition: transition ?? undefined,
        // the dragged widget's spot: a dashed placeholder (a copy follows the pointer)
        ...(isDragging ? { opacity: 0.25, outline: '2px dashed rgb(var(--brand-500))', outlineOffset: -2 } : {}),
      }} />
  );
}

interface Props {
  widgets: DashboardWidget[];
  present: boolean;
  frameProps: (widget: DashboardWidget) => FrameProps;
  onClearSelection: () => void;
  /** a metric or widget type is being dragged (show the drop zone) */
  dropping: boolean;
  gridRef: React.MutableRefObject<HTMLDivElement | null>;
  canvasWidth: number;
  onCanvasWidth: (px: number) => void;
  /** px kept clear on each side for the floating rails (0 in Present) */
  insetLeft: number;
  insetRight: number;
}

/**
 * The dashboard's width lock lines, across the whole board, shown while any widget's width is
 * dragged: every 100 px (labelled at the top of the view) and the quarters (labelled 25% / 50% /
 * 75% at the bottom of the view); the labels stay in view while the dashboard scrolls. A widget's right edge locks to them, wherever the widget is.
 */
function WidthGuides({ width }: { width: number }) {
  return (
    <div className="dash-guides absolute top-0 left-0 right-0 pointer-events-none" aria-hidden="true" data-export-hide="">
      {widthLockLines(width).filter((l) => l.kind !== 'edge').map((l) => (
        // The labels are sticky inside their line, so they stay in view while the dashboard scrolls
        <div key={`${l.kind}-${l.x}`} style={{ left: l.x }}
          className={`absolute top-0 bottom-0 flex flex-col ${l.kind === 'quarter' ? 'justify-end' : 'justify-start'} border-l border-dashed ${
            l.kind === 'quarter' ? 'border-sky-400/50' : 'border-brand-500/40'}`}>
          <span className={`sticky w-max -translate-x-1/2 px-1 text-[9px] font-mono rounded bg-surface-app/90 ${
            l.kind === 'quarter' ? 'bottom-1 text-sky-300' : 'top-1 text-brand-300'}`}>
            {l.kind === 'quarter' ? `${Math.round((((l.x + GAP) / (width + GAP)) * 100))}%` : l.x}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Drag the board's right edge to change the dashboard's width (saved on release). */
function WidthHandle({ width, onChange, onPreview }: { width: number; onChange: (px: number) => void; onPreview: (px: number | null) => void }) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    // A centred board grows on both sides (the edge moves half as far), so double the drag;
    // one wider than the view is anchored on the left and grows by exactly the drag
    const scroller = e.currentTarget.closest<HTMLElement>('.overflow-auto');
    const factor = scroller && scroller.scrollWidth > scroller.clientWidth + 1 ? 1 : 2;
    let last = width;
    startDrag(e, {
      scroller, cursor: 'ew-resize',
      move: (dx) => { last = clampCanvasWidth(width + dx * factor); onPreview(last); },
      end: (commit) => { onPreview(null); if (commit && last !== width) onChange(last); },
    });
  };
  return (
    <div role="separator" aria-orientation="vertical" aria-label="Resize dashboard" title="Drag to change the dashboard's width"
      onPointerDown={start} onClick={(e) => e.stopPropagation()} data-export-hide=""
      className="absolute top-0 bottom-0 -right-3 w-2 cursor-ew-resize rounded hover:bg-brand-500/30 active:bg-brand-500/50" />
  );
}

function DropZone({ dropping, canvasOver }: { dropping: boolean; canvasOver: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: DROP_ZONE_ID });
  const hot = dropping && (isOver || canvasOver);
  return (
    <div ref={setNodeRef} data-export-hide=""
      className={`${dropping ? 'sticky bottom-3 z-20' : ''} flex flex-col items-center justify-center gap-2 mt-3 py-8 text-center rounded border-2 border-dashed backdrop-blur-sm transition-colors ${
        hot ? 'border-brand-500 bg-brand-950/60 text-brand-100' : 'border-gray-700 bg-surface-app/80 text-gray-500'}`}>
      <LayoutDashboard className="w-5 h-5" />
      <p className="text-xs">{dropping ? 'Drop here for a new widget' : 'Drag a metric from the left, or a widget from the right, to start.'}</p>
    </div>
  );
}

export function Canvas({ widgets, present, frameProps, onClearSelection, dropping, gridRef, canvasWidth, onCanvasWidth, insetLeft, insetRight }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: CANVAS_ID });
  const [preview, setPreview] = useState<number | null>(null);
  const width = preview ?? canvasWidth;

  return (
    <div ref={setNodeRef} onClick={onClearSelection}
      className={`relative min-w-full min-h-full w-max transition-colors ${isOver && dropping ? 'bg-brand-950/20' : ''}`}
      style={{ paddingLeft: insetLeft + 24, paddingRight: insetRight + 24, paddingTop: 16, paddingBottom: 16 }}>
      <div className="relative mx-auto" style={{ width }}>
        <div className="dashboard-grid-wrap">
          <div ref={gridRef}
            className={`dashboard-grid flex flex-wrap items-start content-start ${present ? '' : 'select-none'}`}
            style={{ gap: GAP, width }}>
            <SortableContext items={widgets.map((w) => widgetDndId(w.id))} strategy={noShift}>
              {widgets.map((w) => <SortableWidget key={w.id} props={frameProps(w)} containerWidth={width} present={present} />)}
            </SortableContext>
          </div>
        </div>
        {!present && <WidthGuides width={width} />}
        {!present && <WidthHandle width={canvasWidth} onChange={onCanvasWidth} onPreview={setPreview} />}
        {preview !== null && (
          <span className="absolute top-1 -right-3 translate-x-full ml-2 px-1.5 py-0.5 text-[10px] font-mono rounded bg-gray-900/90 text-gray-200 pointer-events-none">
            {preview}px
          </span>
        )}
        {!present && (widgets.length === 0 || dropping) && <DropZone dropping={dropping} canvasOver={isOver} />}
      </div>
    </div>
  );
}
