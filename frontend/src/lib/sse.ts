import { useEffect, useRef } from 'react';

export type SseHandler = (event: { type: string; data: unknown }) => void;

const PROJECT_EVENT_TYPES = [
  'run_started', 'run_log', 'run_finished', 'run_error', 'run_history_changed',
  'statuses_changed', 'graph_changed', 'files_changed',
  'init_pipeline_started', 'init_step', 'init_pipeline_finished',
  'compile_started', 'compile_finished',
  'docs_generating', 'docs_generated',
  'test_failed',
  'git_status_changed', 'git_started', 'git_log', 'git_finished', 'git_error',
  'project_log', 'api_log',
  'health_check_started', 'health_check_finished',
  'drift_started', 'drift_progress', 'drift_finished',
  'freshness_started', 'freshness_finished',
  'column_lineage_compiling', 'column_lineage_started', 'column_lineage_progress', 'column_lineage_finished',
  'ai_proposal_updated', 'ai_proposal_progress', 'ai_query_updated',
  'semantic_check_started', 'semantic_check_finished',
  'metric_monitor_started', 'metric_monitor_progress', 'metric_monitor_finished',
  'dashboards_changed',
];

/** Events on the `global` topic (not tied to a project). */
const GLOBAL_EVENT_TYPES = ['ai_model_download', 'metricflow_env'];

const RECONNECT_DELAY_MS = 3000;

/**
 * One EventSource per stream (a project's, or the global one), shared by every
 * subscriber to it.
 *
 * Browsers cap HTTP/1.1 at 6 open connections per host. With one EventSource
 * per hook, a page with 6+ subscribers (homepage, bottom pane, panels…) uses
 * every slot, and all later fetches queue forever — the app hangs until reload.
 */
interface SharedStream {
  url: string;
  types: readonly string[];
  listeners: Set<SseHandler>;
  es: EventSource | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const sharedStreams = new Map<string, SharedStream>();

function dispatch(stream: SharedStream, type: string, raw: string) {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  stream.listeners.forEach((listener) => {
    try {
      listener({ type, data });
    } catch (err) {
      // One broken handler must not starve the other subscribers.
      console.error(`SSE handler failed for ${type}`, err);
    }
  });
}

function openStream(stream: SharedStream) {
  const es = new EventSource(stream.url);
  stream.es = es;
  stream.types.forEach((type) => {
    es.addEventListener(type, (e: MessageEvent) => dispatch(stream, type, e.data));
  });
  es.onerror = () => {
    es.close();
    stream.es = null;
    if (stream.listeners.size === 0) return;
    stream.retryTimer = setTimeout(() => {
      stream.retryTimer = null;
      if (sharedStreams.get(stream.url) === stream) openStream(stream);
    }, RECONNECT_DELAY_MS);
  };
}

function subscribeToStream(url: string, types: readonly string[], listener: SseHandler): () => void {
  let stream = sharedStreams.get(url);
  if (!stream) {
    stream = { url, types, listeners: new Set(), es: null, retryTimer: null };
    sharedStreams.set(url, stream);
    openStream(stream);
  }
  const active = stream;
  active.listeners.add(listener);
  return () => {
    active.listeners.delete(listener);
    if (active.listeners.size > 0) return;
    active.es?.close();
    if (active.retryTimer) clearTimeout(active.retryTimer);
    sharedStreams.delete(url);
  };
}

/**
 * useProjectEvents — subscribe to a project's SSE stream.
 * All subscribers for a project share one connection, which reconnects
 * automatically and closes when the last subscriber unmounts.
 */
export function useProjectEvents(projectId: number | null, onEvent: SseHandler) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (projectId === null) return;
    const url = `/api/projects/${projectId}/events`;
    return subscribeToStream(url, PROJECT_EVENT_TYPES, (event) => handlerRef.current(event));
  }, [projectId]);
}

/** useGlobalEvents — events not tied to a project (e.g. AI model downloads); shared like useProjectEvents. */
export function useGlobalEvents(onEvent: SseHandler) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    return subscribeToStream('/api/events/global', GLOBAL_EVENT_TYPES, (event) => handlerRef.current(event));
  }, []);
}

/**
 * useTerminalEvents — subscribe to a terminal session's SSE stream.
 * Same wire format as init sessions (init_output / init_finished).
 */
export function useTerminalEvents(
  sessionId: string | null,
  onEvent: SseHandler,
) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!sessionId) return;
    const url = `/api/terminal/${sessionId}/events`;
    let es: EventSource;
    let dead = false;
    let finished = false;

    function connect() {
      if (dead) return;
      es = new EventSource(url);

      es.addEventListener('init_output', (e: MessageEvent) => {
        try { handlerRef.current({ type: 'init_output', data: JSON.parse(e.data) }); }
        catch { handlerRef.current({ type: 'init_output', data: e.data }); }
      });

      es.addEventListener('init_finished', (e: MessageEvent) => {
        finished = true;
        es.close();
        try { handlerRef.current({ type: 'init_finished', data: JSON.parse(e.data) }); }
        catch { handlerRef.current({ type: 'init_finished', data: e.data }); }
      });

      es.onerror = () => {
        es.close();
        if (!dead && !finished) setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      dead = true;
      es?.close();
    };
  }, [sessionId]);
}

/**
 * useInitSessionEvents — subscribe to a PTY init session's SSE stream.
 * Does NOT reconnect after init_finished — the session is done.
 */
export function useInitSessionEvents(
  sessionId: string | null,
  onEvent: SseHandler,
) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!sessionId) return;
    const url = `/api/projects/init-session/${sessionId}/events`;
    let es: EventSource;
    let dead = false;
    let finished = false;

    function connect() {
      if (dead) return;
      es = new EventSource(url);

      es.addEventListener('init_output', (e: MessageEvent) => {
        try { handlerRef.current({ type: 'init_output', data: JSON.parse(e.data) }); }
        catch { handlerRef.current({ type: 'init_output', data: e.data }); }
      });

      es.addEventListener('init_finished', (e: MessageEvent) => {
        finished = true;
        es.close();
        try { handlerRef.current({ type: 'init_finished', data: JSON.parse(e.data) }); }
        catch { handlerRef.current({ type: 'init_finished', data: e.data }); }
      });

      es.onerror = () => {
        es.close();
        // Only reconnect on unexpected errors, not after a clean finish.
        if (!dead && !finished) setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      dead = true;
      es?.close();
    };
  }, [sessionId]);
}
