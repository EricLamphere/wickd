// Runs → Schedule (plan 27): dbt commands run every N hours or on a cron schedule while
// wickd is open. Pause all, drag to reorder, Run now / Edit / Duplicate / Delete; a
// row opens its settings and history in the side pane (rendered by the Runs page).
import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Info, Plus } from 'lucide-react';
import type { RunScheduleDto } from '../../../../lib/schedulesApi';
import { confirmDialog } from '../../../../lib/dialogs';
import { useRunSchedules, useScheduleAlerts } from '../../../../lib/useRunSchedules';
import { ScheduleEditorDialog } from './ScheduleEditorDialog';
import { ScheduleList, type RowActions } from './ScheduleList';
import { draftFromSchedule, emptyDraft, type ScheduleDraft } from './scheduleDraft';
import { useScheduleActions } from './useScheduleActions';

interface Editing {
  id: number | null;
  title: string;
  draft: ScheduleDraft;
}

interface Props {
  projectId: number;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onOpenRun: (invocationId: number) => void;
  /** A draft to open the editor with (Schedule this… / Schedule from the command palette). */
  incoming: ScheduleDraft | null;
  onIncomingHandled: () => void;
}

export function ScheduleTab({ projectId, selectedId, onSelect, onOpenRun, incoming, onIncomingHandled }: Props) {
  const { data, isLoading } = useRunSchedules(projectId);
  const { failures, markAllSeen } = useScheduleAlerts(projectId);
  const actions = useScheduleActions(projectId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const schedules = data?.items ?? [];
  const paused = data?.paused ?? false;
  const alertIds = useMemo(() => new Set(failures.map((f) => f.id)), [failures]);

  // Viewing the tab counts as seeing its failures (the rows keep their own dot until then).
  useEffect(() => {
    if (failures.length === 0) return;
    const timer = setTimeout(markAllSeen, 4000);
    return () => clearTimeout(timer);
  }, [failures.length, markAllSeen]);

  useEffect(() => {
    if (!incoming) return;
    setEditing({ id: null, title: 'Schedule a run', draft: incoming });
    onIncomingHandled();
  }, [incoming, onIncomingHandled]);

  const rowActions: RowActions = {
    onSelect: (id) => onSelect(id === selectedId ? null : id),
    onOpenRun,
    onToggle: (id, enabled) => void actions.setEnabled(id, enabled),
    onRunNow: (id) => void actions.runNow(id),
    onEdit: (s: RunScheduleDto) => setEditing({ id: s.id, title: 'Edit schedule', draft: draftFromSchedule(s) }),
    onDuplicate: (s: RunScheduleDto) =>
      setEditing({ id: null, title: 'Duplicate schedule', draft: { ...draftFromSchedule(s), name: `${s.name} (copy)` } }),
    onDelete: async (s: RunScheduleDto) => {
      const ok = await confirmDialog(`Delete the schedule '${s.name}'? Its past runs stay in Runs.`, { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      if (selectedId === s.id) onSelect(null);
      await actions.remove(s.id);
    },
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="shrink-0 flex flex-wrap items-center gap-3 px-4 py-2 border-b border-gray-800 bg-surface-panel text-xs">
        <span className="flex items-center gap-1.5 text-gray-400">
          <Info className="w-3.5 h-3.5 text-sky-400" />
          Schedules run only while wickd is open. Runs it misses while closed are skipped unless Catch up is on.
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-gray-400 cursor-pointer">
          <input type="checkbox" checked={paused} onChange={(e) => void actions.setPaused(e.target.checked)} />
          Pause all schedules
        </label>
        <button onClick={() => setEditing({ id: null, title: 'Schedule a run', draft: emptyDraft() })}
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-brand-600 text-white hover:bg-brand-500">
          <Plus className="w-3.5 h-3.5" />New schedule
        </button>
      </div>
      {paused && schedules.length > 0 && (
        <div className="shrink-0 px-4 py-1.5 border-b border-gray-800 bg-amber-950/30 text-xs text-amber-400">
          All schedules are paused. Nothing runs until you turn Pause all off.
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-gray-500 text-sm">Loading…</div>
        ) : schedules.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 h-48 px-6 text-center text-gray-500">
            <CalendarClock className="w-8 h-8 opacity-40" />
            <p className="text-sm">No scheduled runs yet.</p>
            <p className="text-xs text-gray-600">Run any dbt command every few hours or on a cron schedule, e.g. <code className="font-mono">build -s tag:nightly</code> on weekdays at 7:00.</p>
          </div>
        ) : (
          <ScheduleList schedules={schedules} paused={paused} selectedId={selectedId} alertIds={alertIds}
            actions={rowActions} onReorder={(ids) => void actions.reorder(ids)} />
        )}
      </div>
      {editing && (
        <ScheduleEditorDialog projectId={projectId} title={editing.title} initial={editing.draft} saving={actions.saving}
          onSave={(body) => actions.save(editing.id, body)} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
