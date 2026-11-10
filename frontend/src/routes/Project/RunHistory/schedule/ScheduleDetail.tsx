// A schedule's side pane: its settings and every fire, including missed / skipped ones
// that never became a run.
import { useQuery } from '@tanstack/react-query';
import { DataTable } from '../../../../components/DataTable';
import { describeTiming, formatCheckTime } from '../../../../components/schedule/scheduleView';
import { schedulesApi, type RunScheduleDto } from '../../../../lib/schedulesApi';
import { formatTime } from '../shared';
import { outcomeView } from './scheduleDraft';
import { OutcomePill } from './ScheduleList';

const HISTORY_COLUMNS = [{ key: 'When' }, { key: 'Trigger' }, { key: 'Outcome' }, { key: 'Run' }, { key: 'Details' }];

function Setting({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-gray-500 shrink-0">{label}</span>
      <span className="text-right text-gray-300 min-w-0 break-words">{children}</span>
    </div>
  );
}

export function ScheduleDetail({ projectId, schedule, paused, onOpenRun }: {
  projectId: number;
  schedule: RunScheduleDto;
  paused: boolean;
  onOpenRun: (invocationId: number) => void;
}) {
  const history = useQuery({
    queryKey: ['run-schedule-history', projectId, schedule.id],
    queryFn: () => schedulesApi.history(projectId, schedule.id),
  });
  const rows = (history.data?.items ?? []).map((e) => [
    formatTime(e.at), e.trigger === 'manual' ? 'Run now' : 'scheduled', outcomeView(e.outcome).label,
    e.invocation_id === null ? '' : `#${e.invocation_id}`, e.message,
  ]);
  const target = schedule.command_target
    ? `${schedule.command_target} (from the command)`
    : schedule.target ?? 'active target when it runs';

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto p-4 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-100 truncate">{schedule.name}</h2>
          <p className="font-mono text-gray-400 break-all">dbt {schedule.command}</p>
        </div>
        <OutcomePill schedule={schedule} onOpenRun={onOpenRun} />
      </div>
      <section className="flex flex-col gap-1.5">
        <Setting label="When">{describeTiming(schedule)}</Setting>
        <Setting label="Next run">
          {paused ? 'paused' : !schedule.enabled ? 'disabled' : schedule.next_run_at ? formatCheckTime(schedule.next_run_at) : '—'}
        </Setting>
        <Setting label="Target"><span className="font-mono">{target}</span></Setting>
        <Setting label="Wait if busy">
          {schedule.busy_wait_minutes === 0 ? 'skip right away' : `${schedule.busy_wait_minutes} min`}
        </Setting>
        <Setting label="Catch up missed run">{schedule.catch_up ? 'yes' : 'no (recorded as missed)'}</Setting>
      </section>
      <section className="flex flex-col gap-1.5 min-h-0">
        <h3 className="font-medium text-gray-300">History</h3>
        {rows.length === 0
          ? <p className="text-gray-500">{history.isLoading ? 'Loading…' : 'Hasn’t run yet.'}</p>
          : <div className="min-h-0 border border-gray-800 rounded overflow-hidden"><DataTable columns={HISTORY_COLUMNS} rows={rows} /></div>}
      </section>
    </div>
  );
}
