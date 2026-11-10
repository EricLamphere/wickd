// Create / edit a scheduled run: name, dbt command, when (off / every N h / cron),
// target, catch-up and how long to wait when the runner is busy.
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../../../../lib/api';
import { CronField } from '../../../../components/schedule/CronField';
import { CUSTOM, INTERVALS, timingChoice, timingFor } from '../../../../components/schedule/scheduleView';
import type { RunScheduleBody } from '../../../../lib/schedulesApi';
import { MAX_BUSY_WAIT_MINUTES, bodyFromDraft, commandTarget, draftProblem, type ScheduleDraft } from './scheduleDraft';
import type { FieldError } from './useScheduleActions';

const FIELD_CLS = 'w-full px-2 py-1.5 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';

interface Props {
  projectId: number;
  title: string;
  initial: ScheduleDraft;
  saving: boolean;
  onSave: (body: RunScheduleBody) => Promise<FieldError | null>;
  onClose: () => void;
}

function FieldMessage({ error, field }: { error: FieldError | null; field: string }) {
  return error?.field === field ? <span className="text-[11px] text-red-400">{error.message}</span> : null;
}

export function ScheduleEditorDialog({ projectId, title, initial, saving, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<ScheduleDraft>(initial);
  const [choice, setChoice] = useState(() => timingChoice(initial));
  const [cronValid, setCronValid] = useState<string | null>(initial.cron);
  const [error, setError] = useState<FieldError | null>(null);
  const targets = useQuery({ queryKey: ['dbt-targets', projectId], queryFn: () => api.profiles.dbtTargets(projectId) });
  const pinned = commandTarget(draft.command);
  const set = (patch: Partial<ScheduleDraft>) => { setDraft((d) => ({ ...d, ...patch })); setError(null); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changeChoice = (value: string) => {
    setChoice(value);
    const timing = timingFor(value);
    if (timing) set(timing);
    else set({ interval_hours: null, cron: cronValid ?? draft.cron ?? '' });
  };
  const onCronValid = useCallback((expr: string | null) => {
    setCronValid(expr);
    if (expr) setDraft((d) => ({ ...d, cron: expr, interval_hours: null }));
  }, []);

  const problem = draftProblem(draft) ?? (choice === CUSTOM && !cronValid ? 'Enter a valid cron schedule.' : null);
  const submit = async () => {
    if (problem || saving) return;
    const result = await onSave(bodyFromDraft(draft));
    if (result) setError(result);
    else onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="flex flex-col w-full max-w-lg bg-gray-900 rounded-xl shadow-2xl border border-gray-700 overflow-hidden"
        onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="font-semibold text-gray-100">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-200"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-gray-400">Name</span>
            <input value={draft.name} onChange={(e) => set({ name: e.target.value })} className={FIELD_CLS} placeholder="Nightly build" />
            <FieldMessage error={error} field="name" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-400">dbt command</span>
            <div className="flex items-center gap-2 px-2 py-1.5 bg-surface-app border border-gray-700 rounded focus-within:border-brand-600">
              <span className="font-mono text-brand-400">dbt</span>
              <input value={draft.command} onChange={(e) => set({ command: e.target.value })} spellCheck={false}
                placeholder="build -s tag:nightly" className="flex-1 bg-transparent font-mono text-gray-100 outline-none" />
            </div>
            <FieldMessage error={error} field="command" />
          </label>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center justify-between gap-3">
              <span className="text-gray-400">When</span>
              <select value={choice} onChange={(e) => changeChoice(e.target.value)} className={`${FIELD_CLS} w-auto`}>
                <option value="off">Off (Run now only)</option>
                {INTERVALS.map((h) => <option key={h} value={`interval:${h}`}>Every {h === 1 ? 'hour' : `${h} hours`}</option>)}
                <option value={CUSTOM}>Custom schedule…</option>
              </select>
            </label>
            {choice === CUSTOM && (
              <CronField initial={draft.cron ?? ''} onSave={() => void submit()} onValidChange={onCronValid} hideSave />
            )}
            <FieldMessage error={error} field="cron" />
            <FieldMessage error={error} field="interval_hours" />
          </div>
          <label className="flex items-center justify-between gap-3">
            <span className="text-gray-400">Target</span>
            <select value={pinned ? '' : draft.target} disabled={pinned !== null}
              onChange={(e) => set({ target: e.target.value })} className={`${FIELD_CLS} w-auto disabled:opacity-50`}>
              <option value="">Active target when it runs</option>
              {(targets.data?.targets ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
              {draft.target && !(targets.data?.targets ?? []).includes(draft.target) && <option value={draft.target}>{draft.target}</option>}
            </select>
          </label>
          {pinned && <p className="-mt-2 self-end text-[11px] text-gray-500">The command sets <code className="font-mono">--target {pinned}</code>, which wins.</p>}
          <FieldMessage error={error} field="target" />
          <label className="flex items-center justify-between gap-3">
            <span className="text-gray-400" title="If another dbt command is running when this one is due">Wait if busy</span>
            <span className="flex items-center gap-1.5 text-gray-500">
              <input type="number" min={0} max={MAX_BUSY_WAIT_MINUTES} value={draft.busy_wait_minutes}
                onChange={(e) => set({ busy_wait_minutes: Number(e.target.value) })} className={`${FIELD_CLS} w-20 text-right`} />
              min, then skip
            </span>
          </label>
          <FieldMessage error={error} field="busy_wait_minutes" />
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={draft.catch_up} onChange={(e) => set({ catch_up: e.target.checked })} className="mt-0.5" />
            <span className="text-gray-400">
              Catch up missed run
              <span className="block text-[11px] text-gray-600">
                If wickd was closed at the scheduled time, run once when it next opens. Off: the run is recorded as missed.
              </span>
            </span>
          </label>
          {error && error.field === null && <p className="text-[11px] text-red-400">{error.message}</p>}
        </div>
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-gray-800">
          <p className="text-[11px] text-gray-500">Schedules run only while wickd is open.</p>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
            <button onClick={() => void submit()} disabled={problem !== null || saving} title={problem ?? undefined}
              className="px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
