// A cron expression input for monitor schedules: presets, the server's check as you type
// (GET …/schedule-preview: the next three times, or why it's invalid), Enter / Save.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { monitorsApi } from '../../../../lib/monitorsApi';
import { errorText } from './useMonitors';
import { CRON_PRESETS, formatCheckTime } from './scheduleView';

const FIELD_CLS = 'px-2 py-1 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';
const DEBOUNCE_MS = 300;

interface Props {
  projectId: number;
  initial: string;
  onSave: (expr: string) => void;
  onCancel?: () => void;
}

export function CronField({ projectId, initial, onSave, onCancel }: Props) {
  const [text, setText] = useState(initial);
  const [checked, setChecked] = useState(initial.trim());
  useEffect(() => {
    const timer = setTimeout(() => setChecked(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const preview = useQuery({
    queryKey: ['monitor-schedule-preview', projectId, checked],
    queryFn: () => monitorsApi.previewSchedule(projectId, checked),
    enabled: checked !== '',
    retry: false,
    staleTime: 60_000,
  });
  const valid = checked === text.trim() && preview.isSuccess;
  const save = () => { if (valid && preview.data) onSave(preview.data.expr); };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. 0 9 * * 1-5" spellCheck={false}
          aria-label="Cron schedule"
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel?.(); }}
          className={`${FIELD_CLS} w-40 font-mono`} />
        <select value="" onChange={(e) => { if (e.target.value) setText(e.target.value); }} className={FIELD_CLS} aria-label="Schedule presets">
          <option value="">Presets…</option>
          {CRON_PRESETS.map((p) => <option key={p.expr} value={p.expr}>{p.label}</option>)}
        </select>
        <button onClick={save} disabled={!valid || preview.data?.expr === initial}
          className="px-2 py-1 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
          Save
        </button>
        {onCancel && <button onClick={onCancel} className="px-1.5 py-1 text-xs text-gray-400 hover:text-gray-200">Cancel</button>}
      </div>
      <p className="text-[11px] text-gray-500">
        {checked === '' ? 'minute hour day-of-month month day-of-week, in local time (at most every 15 minutes)'
          : preview.error ? <span className="text-red-400">{errorText(preview.error)}</span>
            : preview.data ? `Next: ${preview.data.next.map((t) => formatCheckTime(t)).join(' · ')}`
              : 'Checking…'}
      </p>
    </div>
  );
}
