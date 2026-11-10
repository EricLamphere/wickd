import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import NavRail from '../components/NavRail';
import { api, type RunInvocationDto, type RunTrigger } from '../../../lib/api';
import { useProjectEvents } from '../../../lib/sse';
import { useUrlTab } from '../../../lib/useUrlTab';
import { alertError } from '../../../lib/dialogs';
import { slimApi } from '../../../lib/slimApi';
import { apiErrorMessage } from '../../../lib/slimBuild';
import { DetailPanel } from './DetailPanel';
import { DetailPaneShell } from './DetailPaneShell';
import { PerformanceTab } from './PerformanceTab';
import { RunList } from './RunList';
import { useResizablePane } from './useResizablePane';
import type { FailedRowsCache } from './shared';
import { saveSeen } from '../../../lib/scheduleAlerts';
import { useRunSchedules, useScheduleAlerts } from '../../../lib/useRunSchedules';
import { ScheduleDetail } from './schedule/ScheduleDetail';
import { ScheduleTab } from './schedule/ScheduleTab';
import { draftFromInvocation, emptyDraft, type ScheduleDraft } from './schedule/scheduleDraft';

interface ListFilters {
  q: string;
  command: string;
  status: string;
  trigger: '' | RunTrigger;
}

/** `?new=<dbt command>` opens the Schedule tab's editor prefilled (command palette → Schedule). */
const NEW_SCHEDULE_PARAM = 'new';

const PAGE_SIZE = 50;

const PAGE_TABS = ['runs', 'schedule', 'performance'] as const;
type PageTab = (typeof PAGE_TABS)[number];
const PAGE_TAB_LABELS: Record<PageTab, string> = { runs: 'Runs', schedule: 'Schedule', performance: 'Performance' };

export default function RunHistoryPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = Number(projectId);
  const qc = useQueryClient();

  const sessionKey = `run-history:${id}`;
  // remembered per project, so coming back to Runs reopens the last tab
  const [tab, setTab] = useUrlTab<PageTab>('tab', PAGE_TABS, 'runs', `run-history-tab:${id}`);
  const pane = useResizablePane(sessionKey);
  const schedulePane = useResizablePane(`${sessionKey}:schedule`);
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: scheduleList } = useRunSchedules(id);
  const { failures: scheduleFailures } = useScheduleAlerts(id);
  const [selectedScheduleId, setSelectedScheduleId] = useState<number | null>(null);
  const [incomingDraft, setIncomingDraft] = useState<ScheduleDraft | null>(null);
  const selectedSchedule = scheduleList?.items.find((s) => s.id === selectedScheduleId) ?? null;

  // Schedule from the command palette: /runs?tab=schedule&new=<command>
  const newCommand = searchParams.get(NEW_SCHEDULE_PARAM);
  useEffect(() => {
    if (newCommand === null) return;
    setIncomingDraft(emptyDraft(newCommand));
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(NEW_SCHEDULE_PARAM);
      next.set('tab', 'schedule');
      return next;
    }, { replace: true });
  }, [newCommand, setSearchParams]);
  const clearIncoming = useCallback(() => setIncomingDraft(null), []);

  const [failedRowsCache, setFailedRowsCache] = useState<FailedRowsCache>(() => {
    try {
      const raw = sessionStorage.getItem(`failed-rows-cache-${id}`);
      return raw ? new Map(JSON.parse(raw) as [string, { columns: string[]; rows: unknown[][] }][]) : new Map();
    } catch { return new Map(); }
  });

  function handleFailedRowsCached(uid: string, data: { columns: string[]; rows: unknown[][] }) {
    setFailedRowsCache((prev) => {
      const next = new Map(prev);
      next.set(uid, data);
      try { sessionStorage.setItem(`failed-rows-cache-${id}`, JSON.stringify(Array.from(next.entries()))); } catch {}
      return next;
    });
  }

  const cancelMutation = useMutation({
    mutationFn: () => api.runHistory.cancel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['run-history', id], exact: false });
    },
  });

  const rerunMutation = useMutation({
    mutationFn: (invocationId: number) => api.runHistory.rerun(id, invocationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['run-history', id], exact: false });
    },
  });

  const retryMutation = useMutation({
    mutationFn: (invocationId: number) => slimApi.retry(id, invocationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['run-history', id], exact: false });
    },
    onError: (err) => alertError(new Error(apiErrorMessage(err, 'Retry failed'))),
  });

  const [selectedId, setSelectedId] = useState<number | null>(() => {
    try { const v = sessionStorage.getItem(`${sessionKey}:selected`); return v ? Number(v) : null; } catch { return null; }
  });
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<ListFilters>({ q: '', command: '', status: '', trigger: '' });
  const [draftQ, setDraftQ] = useState('');

  function persistSelected(invId: number | null) {
    try {
      if (invId === null) sessionStorage.removeItem(`${sessionKey}:selected`);
      else sessionStorage.setItem(`${sessionKey}:selected`, String(invId));
    } catch {}
  }

  function selectInvocation(inv: RunInvocationDto) {
    setSelectedId(inv.id);
    persistSelected(inv.id);
    pane.reveal();
    const failed = scheduleFailures.find((f) => f.last_invocation_id === inv.id);
    if (failed?.last_event_id) saveSeen(id, failed.last_event_id);
  }

  /** From the Schedule tab: show that run in the Runs tab (latest runs, no filters). */
  function openRun(invocationId: number) {
    setFilters({ q: '', command: '', status: '', trigger: '' });
    setDraftQ('');
    setPage(0);
    setSelectedId(invocationId);
    persistSelected(invocationId);
    pane.reveal();
    setTab('runs');
  }

  function scheduleFromRun(inv: RunInvocationDto) {
    setIncomingDraft(draftFromInvocation(inv));
    setTab('schedule');
  }

  function selectSchedule(scheduleId: number | null) {
    setSelectedScheduleId(scheduleId);
    if (scheduleId !== null) schedulePane.reveal();
  }

  function clearSelected() {
    setSelectedId(null);
    persistSelected(null);
  }

  const queryParams = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    command: filters.command || undefined,
    status: filters.status || undefined,
    q: filters.q || undefined,
    trigger: filters.trigger || undefined,
  };

  const { data, isLoading } = useQuery({
    queryKey: ['run-history', id, queryParams],
    queryFn: () => api.runHistory.list(id, queryParams),
  });

  useProjectEvents(id, useCallback((event) => {
    if (event.type === 'run_started') {
      qc.invalidateQueries({ queryKey: ['run-history', id], exact: false });
    }
    if (event.type === 'run_history_changed') {
      qc.invalidateQueries({ queryKey: ['run-history', id], exact: false });
      // also invalidate the detail if it's open
      qc.invalidateQueries({ queryKey: ['run-invocation', id], exact: false });
    }
    if (event.type === 'statuses_changed') {
      // Fires after every persisted run, so new timing has landed
      qc.invalidateQueries({ queryKey: ['run-analysis', id], exact: false });
      qc.invalidateQueries({ queryKey: ['performance', id], exact: false });
    }
  }, [id, qc]));

  const invocations = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const selected = invocations.find((inv) => inv.id === selectedId) ?? null;

  function applySearch() {
    setFilters((f) => ({ ...f, q: draftQ }));
    setPage(0);
    clearSelected();
  }

  function setFilter(key: keyof ListFilters, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(0);
    clearSelected();
  }

  return (
    <div className="flex h-full overflow-hidden">
      <NavRail projectId={id} current="runs" />

      <div className="flex-1 flex min-w-0 overflow-hidden">
        {/* Left: list */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

          {/* Header */}
          <div className="shrink-0 border-b border-gray-800 px-6 pt-5 pb-3 bg-surface-app">
            <div className="flex items-center gap-2.5 mb-1">
              <svg className="w-5 h-5 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h1 className="text-base font-semibold text-gray-100">Runs</h1>
              {tab === 'runs' && total > 0 && <span className="text-xs text-gray-500">{total} total</span>}
              <div className="ml-auto flex items-center gap-1">
                {PAGE_TABS.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                      tab === t ? 'bg-brand-900/30 text-brand-300' : 'text-gray-500 hover:text-gray-300 hover:bg-surface-elevated'
                    }`}
                  >
                    {PAGE_TAB_LABELS[t]}
                    {t === 'schedule' && scheduleFailures.length > 0 && (
                      <span title="A scheduled run failed" className="inline-block ml-1.5 mb-px w-1.5 h-1.5 rounded-full bg-red-500" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Filter bar */}
            {tab === 'runs' && (
              <div className="flex items-center gap-2 mt-3">
                <form
                  className="flex-1 flex gap-1.5"
                  onSubmit={(e) => { e.preventDefault(); applySearch(); }}
                >
                  <input
                    type="text"
                    placeholder="Search by selector…"
                    value={draftQ}
                    onChange={(e) => setDraftQ(e.target.value)}
                    className="flex-1 min-w-0 form-input border rounded px-2.5 py-1 text-xs"
                  />
                  <button type="submit" className="px-2.5 py-1 form-btn border rounded text-xs transition-colors">
                    Search
                  </button>
                </form>
                <select
                  value={filters.command}
                  onChange={(e) => setFilter('command', e.target.value)}
                  className="form-select border rounded px-2 py-1 text-xs"
                >
                  <option value="">All commands</option>
                  <option value="run">run</option>
                  <option value="build">build</option>
                  <option value="test">test</option>
                  <option value="seed">seed</option>
                </select>
                <select
                  value={filters.status}
                  onChange={(e) => setFilter('status', e.target.value)}
                  className="form-select border rounded px-2 py-1 text-xs"
                >
                  <option value="">All statuses</option>
                  <option value="success">success</option>
                  <option value="error">error</option>
                  <option value="running">running</option>
                </select>
                <select
                  value={filters.trigger}
                  onChange={(e) => setFilter('trigger', e.target.value)}
                  className="form-select border rounded px-2 py-1 text-xs"
                  aria-label="Trigger"
                >
                  <option value="">All triggers</option>
                  <option value="manual">Manual</option>
                  <option value="schedule">Scheduled</option>
                  <option value="rerun">Rerun</option>
                </select>
              </div>
            )}
          </div>

          {tab === 'performance' ? (
            <PerformanceTab projectId={id} />
          ) : tab === 'schedule' ? (
            <ScheduleTab projectId={id} selectedId={selectedScheduleId} onSelect={selectSchedule} onOpenRun={openRun}
              incoming={incomingDraft} onIncomingHandled={clearIncoming} />
          ) : (
            <>
              <RunList
                invocations={invocations}
                total={total}
                isLoading={isLoading}
                selectedId={selectedId}
                onRowClick={(inv) => { if (inv.id === selectedId) clearSelected(); else selectInvocation(inv); }}
                onStop={() => cancelMutation.mutate()}
                onRerun={(invId) => rerunMutation.mutate(invId)}
                onRetry={(invId) => retryMutation.mutate(invId)}
              />

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="shrink-0 flex items-center justify-between px-4 py-2 border-t border-gray-800 text-xs text-gray-500">
                  <span>Page {page + 1} of {totalPages}</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => { setPage((p) => Math.max(0, p - 1)); clearSelected(); }}
                      disabled={page === 0}
                      className="px-2.5 py-1 form-btn disabled:opacity-40 disabled:cursor-not-allowed rounded transition-colors"
                    >
                      ← Prev
                    </button>
                    <button
                      onClick={() => { setPage((p) => Math.min(totalPages - 1, p + 1)); clearSelected(); }}
                      disabled={page >= totalPages - 1}
                      className="px-2.5 py-1 form-btn disabled:opacity-40 disabled:cursor-not-allowed rounded transition-colors"
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right: draggable detail pane */}
        {tab === 'runs' && (
          <DetailPaneShell pane={pane}>
            {selected
              ? <DetailPanel projectId={id} invocation={selected} onRerun={(invId) => rerunMutation.mutate(invId)} onRetry={(invId) => retryMutation.mutate(invId)} onSchedule={scheduleFromRun} failedRowsCache={failedRowsCache} onFailedRowsCached={handleFailedRowsCached} />
              : (
                <div className="flex items-center justify-center h-full text-gray-500 text-sm px-6 text-center">
                  Select a run to see node timings and logs.
                </div>
              )
            }
          </DetailPaneShell>
        )}
        {tab === 'schedule' && (
          <DetailPaneShell pane={schedulePane}>
            {selectedSchedule
              ? <ScheduleDetail projectId={id} schedule={selectedSchedule} paused={scheduleList?.paused ?? false} onOpenRun={openRun} />
              : (
                <div className="flex items-center justify-center h-full text-gray-500 text-sm px-6 text-center">
                  Select a schedule to see its settings and history.
                </div>
              )}
          </DetailPaneShell>
        )}
      </div>
    </div>
  );
}
