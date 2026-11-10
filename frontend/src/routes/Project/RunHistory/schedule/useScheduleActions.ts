// Mutations for the Schedule tab. Every success also arrives as `run_schedules_changed`
// (which invalidates the list); invalidating here too keeps the UI snappy.
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { schedulesApi, type RunScheduleBody } from '../../../../lib/schedulesApi';
import { runSchedulesKey } from '../../../../lib/useRunSchedules';
import { alertError } from '../../../../lib/dialogs';
import { apiErrorMessage } from '../../../../lib/slimBuild';
import { ApiError } from '../../../../lib/api';

/** A 400 from the schedule routes: which field and why. */
export interface FieldError {
  field: string | null;
  message: string;
}

export function fieldError(err: unknown): FieldError {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const body = err.body;
    if (Array.isArray(body) && body[0] && typeof body[0] === 'object') {
      // 422 from request validation: [{loc: ['body', field], msg}]
      const first = body[0] as { loc?: unknown[]; msg?: string };
      const field = Array.isArray(first.loc) ? String(first.loc[first.loc.length - 1]) : null;
      return { field, message: first.msg ?? 'Invalid value' };
    }
    if ('message' in body) {
      const d = body as { field?: string; message?: string };
      return { field: d.field ?? null, message: d.message ?? 'Invalid schedule' };
    }
  }
  return { field: null, message: apiErrorMessage(err, 'Something went wrong') };
}

export function useScheduleActions(projectId: number) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: runSchedulesKey(projectId) }), [projectId, qc]);

  /** Create or update; resolves to null on success, else the field error to show. */
  const save = useCallback(async (id: number | null, body: RunScheduleBody): Promise<FieldError | null> => {
    setSaving(true);
    try {
      if (id === null) await schedulesApi.create(projectId, body);
      else await schedulesApi.update(projectId, id, body);
      await refresh();
      return null;
    } catch (err) {
      return fieldError(err);
    } finally {
      setSaving(false);
    }
  }, [projectId, refresh]);

  const run = useCallback(async (fn: () => Promise<unknown>, what: string) => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      await alertError(new Error(`${what}: ${fieldError(err).message}`));
    }
  }, [refresh]);

  return {
    saving,
    save,
    setEnabled: (id: number, enabled: boolean) => run(() => schedulesApi.update(projectId, id, { enabled }), 'Couldn’t update the schedule'),
    remove: (id: number) => run(() => schedulesApi.remove(projectId, id), 'Couldn’t delete the schedule'),
    runNow: (id: number) => run(() => schedulesApi.runNow(projectId, id), 'Couldn’t start the run'),
    reorder: (ids: number[]) => run(() => schedulesApi.reorder(projectId, ids), 'Couldn’t reorder'),
    setPaused: (paused: boolean) => run(() => schedulesApi.setPaused(projectId, paused), 'Couldn’t change Pause all'),
  };
}
