// The Monitors tab's cards, reorderable by drag and drop (same dnd-kit setup as the
// Home page's pinned projects). A drag moves the card and saves the new order; a plain
// click (under 5 px of movement) still opens the monitor.
import { useRef, useState } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { MonitorDto } from '../../../../lib/monitorsApi';
import { MonitorCard } from './MonitorCard';

interface Props {
  monitors: MonitorDto[];
  activeTarget: string | null;
  running: boolean;
  onOpen: (id: number) => void;
  /** the full new order, after a drop that moved something */
  onReorder: (ids: number[]) => void;
}

function SortableMonitorCard({ monitor, activeTarget, running, onOpen, dragging, cardRefs }: {
  monitor: MonitorDto; activeTarget: string | null; running: boolean; onOpen: () => void;
  dragging: boolean; cardRefs: React.MutableRefObject<Map<number, HTMLElement>>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: monitor.id });
  return (
    <MonitorCard
      monitor={monitor}
      activeTarget={activeTarget}
      running={running}
      onOpen={onOpen}
      cardRef={(el) => {
        setNodeRef(el);
        if (el) cardRefs.current.set(monitor.id, el); else cardRefs.current.delete(monitor.id);
      }}
      dragProps={{ ...attributes, ...listeners } as React.HTMLAttributes<HTMLButtonElement>}
      style={{ transform: CSS.Translate.toString(transform) ?? undefined, transition: transition ?? undefined, opacity: isDragging ? 0.4 : 1 }}
      className={dragging ? 'cursor-grabbing' : 'cursor-grab'}
    />
  );
}

export function MonitorGrid({ monitors, activeTarget, running, onOpen, onReorder }: Props) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const cardRefs = useRef(new Map<number, HTMLElement>());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = (event: DragStartEvent) => setActiveId(event.active.id as number);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const ids = monitors.map((m) => m.id);
    onReorder(arrayMove(ids, ids.indexOf(active.id as number), ids.indexOf(over.id as number)));
  };

  const active = monitors.find((m) => m.id === activeId) ?? null;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart}
      onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
      <SortableContext items={monitors.map((m) => m.id)} strategy={rectSortingStrategy}>
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]">
          {monitors.map((m) => (
            <SortableMonitorCard key={m.id} monitor={m} activeTarget={activeTarget} running={running}
              onOpen={() => onOpen(m.id)} dragging={activeId !== null} cardRefs={cardRefs} />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {active && (
          <MonitorCard monitor={active} activeTarget={activeTarget} running={running} onOpen={() => {}}
            style={{ width: cardRefs.current.get(active.id)?.getBoundingClientRect().width, opacity: 0.9 }}
            className="rotate-1 cursor-grabbing shadow-2xl" />
        )}
      </DragOverlay>
    </DndContext>
  );
}
