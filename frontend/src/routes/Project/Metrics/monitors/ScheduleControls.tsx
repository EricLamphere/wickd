// Auto-check schedule controls: the project's (Monitors toolbar: off / every N h / cron)
// and one monitor's override (Settings: the project's / off / its own cron).
import { useState } from 'react';
import { Clock } from 'lucide-react';
import type { MonitorDto, MonitorListDto, MonitorPatchBody, MonitorScheduleSettings } from '../../../../lib/monitorsApi';
import { CronField } from '../../../../components/schedule/CronField';
import {
  CUSTOM, describeProjectSchedule, FOLLOW_PROJECT, formatCheckTime, INTERVALS, monitorChoice, OFF, presetLabel,
  projectChoice, projectSettingsFor,
} from './scheduleView';

const FIELD_CLS = 'px-2 py-1 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';

function CronChip({ expr, onClick }: { expr: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title="Edit the schedule"
      className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-700 font-mono text-[11px] text-gray-300 hover:border-gray-500">
      <Clock className="w-3 h-3 text-gray-500" />{presetLabel(expr) ?? expr}
    </button>
  );
}

export function ProjectScheduleControl({ data, onSave }: {
  data: MonitorListDto;
  onSave: (body: MonitorScheduleSettings) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const choice = editing ? CUSTOM : projectChoice(data);
  const change = (value: string) => {
    const body = projectSettingsFor(value);
    setEditing(body === null);
    if (body) void onSave(body);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
      <label className="flex items-center gap-2">
        Auto-check
        <select value={choice} onChange={(e) => change(e.target.value)} className={FIELD_CLS}>
          <option value={OFF}>Off</option>
          {INTERVALS.map((h) => <option key={h} value={`interval:${h}`}>Every {h} h</option>)}
          <option value={CUSTOM}>Custom schedule…</option>
        </select>
      </label>
      {editing ? (
        <CronField initial={data.schedule ?? ''} onCancel={() => setEditing(false)}
          onSave={async (expr) => { if (await onSave({ interval_hours: null, schedule: expr })) setEditing(false); }} />
      ) : data.schedule && <CronChip expr={data.schedule} onClick={() => setEditing(true)} />}
    </div>
  );
}

export function MonitorScheduleSetting({ monitor, project, onUpdate }: {
  monitor: MonitorDto;
  project: Pick<MonitorListDto, 'interval_hours' | 'schedule'>;
  onUpdate: (body: MonitorPatchBody) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const choice = editing ? CUSTOM : monitorChoice(monitor);
  const change = (value: string) => {
    setEditing(value === CUSTOM);
    if (value === FOLLOW_PROJECT) void onUpdate({ schedule: null });
    if (value === OFF) void onUpdate({ schedule: OFF });
  };
  const own = monitor.schedule !== null && monitor.schedule !== OFF ? monitor.schedule : null;

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center justify-between gap-3">
        <span className="text-gray-400">Auto-check</span>
        <select value={choice} onChange={(e) => change(e.target.value)} className={FIELD_CLS}>
          <option value={FOLLOW_PROJECT}>Project schedule ({describeProjectSchedule(project)})</option>
          <option value={OFF}>Off for this monitor</option>
          <option value={CUSTOM}>Own schedule…</option>
        </select>
      </label>
      {editing ? (
        <CronField initial={own ?? ''} onCancel={() => setEditing(false)}
          onSave={async (expr) => { if (await onUpdate({ schedule: expr })) setEditing(false); }} />
      ) : own && <span className="self-end"><CronChip expr={own} onClick={() => setEditing(true)} /></span>}
      <p className="self-end text-[11px] text-gray-600">
        {monitor.next_check_at ? `Next automatic check ${formatCheckTime(monitor.next_check_at)}`
          : monitor.enabled ? 'No automatic checks: after builds and Check now only' : 'Paused'}
      </p>
    </div>
  );
}
