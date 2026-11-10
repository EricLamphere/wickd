// The Schedule tab's rows, reorderable by drag and drop (same dnd-kit setup as the
// Monitors grid). A plain click (under 5 px of movement) selects the row.
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Clock, Copy, GripVertical, Pencil, Play, Trash2 } from 'lucide-react';
import type { RunScheduleDto } from '../../../../lib/schedulesApi';
import { describeTiming, formatCheckTime } from '../../../../components/schedule/scheduleView';
import { TONE_CLS, outcomeView } from './scheduleDraft';

export interface RowActions {
  onSelect: (id: number) => void;
  onOpenRun: (invocationId: number) => void;
  onToggle: (id: number, enabled: boolean) => void;
  onRunNow: (id: number) => void;
  onEdit: (schedule: RunScheduleDto) => void;
  onDuplicate: (schedule: RunScheduleDto) => void;
  onDelete: (schedule: RunScheduleDto) => void;
}

const ICON_BTN = 'p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-surface-elevated disabled:opacity-40';

export function OutcomePill({ schedule, onOpenRun }: { schedule: RunScheduleDto; onOpenRun?: (id: number) => void }) {
  const view = outcomeView(schedule.last_status);
  const invocation = schedule.last_invocation_id;
  const cls = `inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${TONE_CLS[view.tone]}`;
  if (invocation === null || !onOpenRun) return <span className={cls}>{view.label}</span>;
  return (
    <button onClick={(e) => { e.stopPropagation(); onOpenRun(invocation); }} title="Open this run" className={`${cls} hover:brightness-125`}>
      {view.label}
    </button>
  );
}

function nextLabel(s: RunScheduleDto, paused: boolean): string {
  if (paused) return 'Paused';
  if (!s.enabled) return 'Disabled';
  if (s.pending) return 'Running now';
  return s.next_run_at ? `Next ${formatCheckTime(s.next_run_at)}` : 'Run now only';
}

function Row({ schedule, paused, selected, alert, actions }: {
  schedule: RunScheduleDto; paused: boolean; selected: boolean; alert: boolean; actions: RowActions;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: schedule.id });
  const target = schedule.command_target ?? schedule.target;
  return (
    <div ref={setNodeRef} onClick={() => actions.onSelect(schedule.id)}
      style={{ transform: CSS.Translate.toString(transform) ?? undefined, transition: transition ?? undefined, opacity: isDragging ? 0.4 : 1 }}
      className={`group flex items-center gap-3 px-4 py-2.5 border-b border-gray-800/60 cursor-pointer text-xs transition-colors ${
        selected ? 'bg-brand-900/20' : 'hover:bg-surface-elevated'} ${schedule.enabled && !paused ? '' : 'opacity-60'}`}>
      <button {...attributes} {...listeners} onClick={(e) => e.stopPropagation()} aria-label="Drag to reorder"
        className="text-gray-600 hover:text-gray-400 cursor-grab"><GripVertical className="w-3.5 h-3.5" /></button>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-200 truncate">{schedule.name}</span>
          {alert && <span title="Failed since you last looked" className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />}
        </div>
        <span className="font-mono text-gray-400 truncate">dbt {schedule.command}</span>
        <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <Clock className="w-3 h-3" />{describeTiming(schedule)}
          {target && <span className="px-1.5 rounded border border-gray-700 font-mono text-gray-400">{target}</span>}
          <span className="text-gray-600">·</span>{nextLabel(schedule, paused)}
        </span>
      </div>
      <OutcomePill schedule={schedule} onOpenRun={actions.onOpenRun} />
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => actions.onRunNow(schedule.id)} disabled={schedule.pending} title="Run now" className={ICON_BTN}><Play className="w-3.5 h-3.5" /></button>
        <button onClick={() => actions.onEdit(schedule)} title="Edit" className={ICON_BTN}><Pencil className="w-3.5 h-3.5" /></button>
        <button onClick={() => actions.onDuplicate(schedule)} title="Duplicate" className={ICON_BTN}><Copy className="w-3.5 h-3.5" /></button>
        <button onClick={() => actions.onDelete(schedule)} title="Delete" className={`${ICON_BTN} hover:text-red-400`}><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
      <label onClick={(e) => e.stopPropagation()} title={schedule.enabled ? 'Enabled' : 'Disabled'} className="flex items-center cursor-pointer">
        <input type="checkbox" checked={schedule.enabled} onChange={(e) => actions.onToggle(schedule.id, e.target.checked)}
          aria-label={`Enable ${schedule.name}`} />
      </label>
    </div>
  );
}

export function ScheduleList({ schedules, paused, selectedId, alertIds, actions, onReorder }: {
  schedules: RunScheduleDto[];
  paused: boolean;
  selectedId: number | null;
  alertIds: ReadonlySet<number>;
  actions: RowActions;
  onReorder: (ids: number[]) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = schedules.map((s) => s.id);
    onReorder(arrayMove(ids, ids.indexOf(active.id as number), ids.indexOf(over.id as number)));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={schedules.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        {schedules.map((s) => (
          <Row key={s.id} schedule={s} paused={paused} selected={s.id === selectedId} alert={alertIds.has(s.id)} actions={actions} />
        ))}
      </SortableContext>
    </DndContext>
  );
}
