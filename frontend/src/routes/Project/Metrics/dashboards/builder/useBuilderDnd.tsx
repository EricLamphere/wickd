// Drag and drop on the builder (one DndContext for the rails and the canvas):
// - a metric onto a widget adds it there (or says why it can't); onto empty space it starts a
//   Metric summary;
// - a saved query onto empty space becomes a widget with its metrics, group-bys and filters;
// - a widget type from the palette is inserted before the widget it's dropped on, else at the end;
// - a widget dragged by its grip moves: the others reflow live into the order it would make
//   (widgets have different sizes, so shifting them by transforms can't be right), a copy
//   follows the pointer, and the new order is saved on drop (Escape puts it back).
import { useRef, useState } from 'react';
import {
  PointerSensor, closestCenter, pointerWithin, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { BarChart3 } from 'lucide-react';
import type { DashboardDoc, DashboardWidget, WidgetType } from '../../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../../lib/semanticApi';
import {
  addMetric, insertWidget, newWidget, orderWidgets, placeWidget, replaceWidget, widgetFromQuery, widgetInfo,
} from '../dashboardModel';
import type { DropHint } from '../widgets/WidgetFrame';
import { CANVAS_ID, DROP_ZONE_ID } from './Canvas';
import { RAIL_DROP_PREFIX } from './RailResize';
import { WIDGET_ICONS } from './WidgetsRail';

export type DragItem =
  | { kind: 'metric'; name: string }
  | { kind: 'saved'; name: string }
  | { kind: 'type'; type: WidgetType }
  | { kind: 'widget'; id: string };

/** How far the pointer must move after a reorder before the next one */
const MOVE_PX = 12;

const widgetIdOf = (dndId: string | null | undefined) => (dndId?.startsWith('widget:') ? dndId.slice(7) : null);

/** Widgets first under the pointer (a drop on a widget beats the canvas behind it); nothing over a rail. */
const collision: CollisionDetection = (args) => {
  const active = args.active.data.current as DragItem | undefined;
  if (active?.kind === 'widget') {
    const widgets = args.droppableContainers.filter((c) => String(c.id).startsWith('widget:'));
    const under = pointerWithin({ ...args, droppableContainers: widgets });
    return under.length ? under : closestCenter({ ...args, droppableContainers: widgets });
  }
  const hits = pointerWithin(args);
  // The rails float over the canvas: a drop over one isn't a drop on what's underneath
  if (hits.some((h) => String(h.id).startsWith(RAIL_DROP_PREFIX))) return [];
  const zone = hits.find((h) => h.id === DROP_ZONE_ID);
  if (zone) return [zone];
  const widget = hits.find((h) => String(h.id).startsWith('widget:'));
  return widget ? [widget] : hits.filter((h) => h.id === CANVAS_ID);
};

export function useBuilderDnd({ doc, catalog, labels, apply, onCreated, onNotice }: {
  doc: DashboardDoc | null;
  catalog: SemanticCatalogDto;
  labels: Map<string, string>;
  apply: (change: (doc: DashboardDoc) => DashboardDoc) => void;
  onCreated: (widget: DashboardWidget) => void;
  onNotice: (message: string) => void;
}) {
  const [active, setActive] = useState<DragItem | null>(null);
  const [overWidget, setOverWidget] = useState<string | null>(null);
  // While a widget is dragged: the order it would make (the canvas renders this, so the others reflow)
  const [order, setOrder] = useState<string[] | null>(null);
  // Where the pointer was at the last reorder: widgets reflowing under a still pointer would
  // otherwise keep triggering new moves, so only the pointer's own movement reorders
  const lastMove = useRef<{ x: number; y: number } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const ids = () => doc?.widgets.map((w) => w.id) ?? [];

  const hintFor = (widget: DashboardWidget): DropHint | null => {
    if (!active || active.kind === 'widget' || overWidget !== widget.id) return null;
    if (active.kind === 'type') return { ok: true, text: `Insert ${widgetInfo(active.type).label} here` };
    if (active.kind === 'saved') return { ok: false, text: 'Drop saved queries on empty space' };
    const result = addMetric(widget, active.name, catalog);
    return result.widget ? { ok: true, text: `Add ${labels.get(active.name) ?? active.name}` } : { ok: false, text: result.error };
  };

  const create = (widget: DashboardWidget, before: string | null) => {
    apply((d) => insertWidget(d, widget, before ? d.widgets.findIndex((w) => w.id === before) : undefined));
    onCreated(widget);
  };

  const onDragEnd = ({ active: a, over }: DragEndEvent) => {
    const item = a.data.current as DragItem | undefined;
    const finalOrder = order;
    setActive(null);
    setOverWidget(null);
    setOrder(null);
    if (item?.kind === 'widget') {
      if (finalOrder && doc && finalOrder.join() !== ids().join()) apply((d) => orderWidgets(d, finalOrder));
      return;
    }
    if (!item || !over || !doc) return;
    const target = widgetIdOf(String(over.id));
    if (item.kind === 'type') {
      create(newWidget(item.type, ids(), [], catalog), target);
      return;
    }
    if (item.kind === 'saved') {
      if (target) { onNotice('Drop saved queries on empty space to make a new widget'); return; }
      create(widgetFromQuery({ saved_query: item.name }, catalog, ids()), null);
      return;
    }
    if (target) {
      const widget = doc.widgets.find((w) => w.id === target);
      const result = widget ? addMetric(widget, item.name, catalog) : null;
      if (result?.widget) apply((d) => replaceWidget(d, result.widget)); else if (result?.error) onNotice(result.error);
      return;
    }
    create(newWidget('summary', ids(), [item.name], catalog), null);
  };

  const overlay = () => {
    if (!active || active.kind === 'widget') return null;
    const Icon = active.kind === 'type' ? WIDGET_ICONS[active.type] : BarChart3;
    const text = active.kind === 'type' ? widgetInfo(active.type).label : labels.get(active.name) ?? active.name;
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-brand-600 bg-surface-elevated text-gray-100 shadow-xl cursor-grabbing">
        <Icon className="w-3.5 h-3.5 text-brand-300" />{text}
      </span>
    );
  };

  const onDragOver = (e: DragOverEvent) => setOverWidget(widgetIdOf(e.over ? String(e.over.id) : null));

  /** While a widget is dragged: put it before or after the widget under the pointer (by its midpoint). */
  const onDragMove = (e: DragMoveEvent) => {
    const item = e.active.data.current as DragItem | undefined;
    const target = widgetIdOf(e.over ? String(e.over.id) : null);
    if (item?.kind !== 'widget' || !target || target === item.id || !e.over) return;
    const start = e.activatorEvent as PointerEvent;
    const pointer = { x: start.clientX + e.delta.x, y: start.clientY + e.delta.y };
    const last = lastMove.current;
    if (last && Math.hypot(pointer.x - last.x, pointer.y - last.y) < MOVE_PX) return;
    const r = e.over.rect;
    const after = pointer.x > r.left + r.width / 2;
    setOrder((prev) => {
      const next = placeWidget(prev ?? ids(), item.id, target, after);
      if (next.join() === (prev ?? ids()).join()) return prev;
      lastMove.current = pointer;
      return next;
    });
  };

  /** The widgets in the order to show: the live preview while one is dragged. */
  const ordered = (widgets: DashboardWidget[]): DashboardWidget[] => {
    if (!order) return widgets;
    const byId = new Map(widgets.map((w) => [w.id, w]));
    return order.map((id) => byId.get(id)).filter((w): w is DashboardWidget => !!w);
  };

  return {
    active, hintFor, overlay, ordered,
    dndProps: {
      sensors, collisionDetection: collision,
      onDragStart: (e: DragStartEvent) => {
        const item = (e.active.data.current as DragItem | undefined) ?? null;
        setActive(item);
        lastMove.current = null;
        if (item?.kind === 'widget') setOrder(ids());
      },
      onDragOver,
      onDragMove,
      onDragEnd,
      onDragCancel: () => { setActive(null); setOverWidget(null); setOrder(null); },
    },
  };
}

