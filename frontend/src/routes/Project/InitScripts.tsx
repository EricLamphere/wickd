import { Fragment, useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api, type InitStepDto } from '../../lib/api';
import NavRail from './components/NavRail';
import { useProjectEvents } from '../../lib/sse';
import { FilePickerModal } from './components/FilePickerModal';
import { StepTile } from './components/InitPipeline/StepTile';
import { StepConnector } from './components/InitPipeline/StepConnector';
import { AddStepTile } from './components/InitPipeline/AddStepTile';
import { ScriptEditorModal } from './components/InitPipeline/ScriptEditorModal';
import { useElementWidth } from './components/InitPipeline/useElementWidth';
import {
  connectorState, laneCenterPct, laneOffsetPct,
  type StepRunState, type StepStatus,
} from './components/InitPipeline/flow';

// Stable reference for the "no data yet" default below — `data: steps = []`
// would otherwise allocate a brand-new empty array on every render where the
// query hasn't resolved, which fed a `useEffect(() => setLocalSteps(steps),
// [steps])` an ever-changing "new" array and caused a render loop (visible
// as React's "Maximum update depth exceeded" warning on this page).
const EMPTY_STEPS: InitStepDto[] = [];

// ---- main page ----

export default function InitScriptsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = Number(projectId);
  const qc = useQueryClient();

  // refetchOnMount: 'always' — navigating back to this page must never show a
  // cached last_init_status from before an init run that started while away.
  const { data: project } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.projects.get(id),
    refetchOnMount: 'always',
  });

  const { data: steps = EMPTY_STEPS, isLoading } = useQuery({
    queryKey: ['init-steps', id],
    queryFn: () => api.init.steps(id),
    refetchOnMount: 'always',
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['init-steps', id] });

  const [setupRunning, setSetupRunning] = useState(false);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [stepStates, setStepStates] = useState<Record<string, StepRunState>>({});

  // Seed stepStates from persisted step status once steps first load, so status/logs
  // survive navigation and server restarts. SSE overwrites this live during a run.
  const seededStepStatesRef = useRef(false);
  useEffect(() => {
    if (seededStepStatesRef.current || steps.length === 0) return;
    seededStepStatesRef.current = true;
    const seeded: Record<string, StepRunState> = {};
    for (const s of steps) {
      if (s.last_status && s.last_status !== 'idle') {
        seeded[s.name] = {
          status: s.last_status as StepStatus,
          log: s.last_log,
          finishedAt: s.last_finished_at,
        };
      }
    }
    setStepStates(seeded);
  }, [steps]);

  const runSetupMutation = useMutation({
    mutationFn: () => api.init.open(id),
    onMutate: () => {
      setSetupRunning(true);
      // Clear previous run states
      setStepStates({});
    },
    onError: (err) => {
      setSetupRunning(false);
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('409')) {
        alert('Init pipeline is already running for this project.');
      } else {
        alert(message);
      }
    },
  });

  useProjectEvents(id, useCallback((event) => {
    if (event.type === 'init_pipeline_started') {
      setSetupRunning(true);
      // Only clear state for the steps actually in this run (a single-step
      // run publishes the same event with just that one step's name) — other
      // steps' persisted status must not be wiped.
      const runningSteps = (event.data as { steps?: string[] }).steps ?? [];
      setStepStates((prev) => {
        const next = { ...prev };
        for (const name of runningSteps) {
          delete next[name];
        }
        return next;
      });
    }
    if (event.type === 'init_step') {
      const { name, status, log = '', finishedAt = null } = event.data as {
        name: string;
        status: StepStatus;
        log?: string;
        finishedAt?: string | null;
        finished_at?: string | null;
      };
      const resolvedFinishedAt = finishedAt ?? (event.data as Record<string, string | null>).finished_at ?? null;
      setStepStates((prev) => ({
        ...prev,
        [name]: { status, log, finishedAt: resolvedFinishedAt },
      }));
    }
    if (event.type === 'init_pipeline_finished') {
      setSetupRunning(false);
      setLastRunAt(new Date().toISOString());
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['init-steps', id] });
    }
  }, [id, qc]));

  const reorderMutation = useMutation({
    mutationFn: (names: string[]) => api.init.reorder(id, names),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => {
      const bareName = name.replace(/^custom:\s*/, '');
      return api.init.deleteStep(id, bareName);
    },
    onSuccess: invalidate,
  });

  const [newStepOpen, setNewStepOpen] = useState(false);
  const [editStep, setEditStep] = useState<InitStepDto | null>(null);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [flowRef, flowWidth] = useElementWidth();
  const [localSteps, setLocalSteps] = useState<InitStepDto[]>([]);
  // Pointer-based drag, not native HTML5 drag-and-drop: WKWebView (Tauri's
  // macOS webview) has a long-standing bug where dragover/drop don't
  // reliably fire for in-page reordering — dragstart fires, then the OS-level
  // drag session silently goes straight to dragend without ever crossing a
  // drop target. Chromium's implementation is more complete, so testing only
  // in a normal browser never surfaced this. Plain pointer events don't
  // involve the OS drag subsystem at all, so they work the same everywhere.
  const dragFromRef = useRef<number | null>(null);
  const dragStartIndexRef = useRef<number | null>(null);
  // Keyed by step name, not array index: the dragged tile's logical index
  // (dragFromRef) changes every time it crosses a sibling during the drag,
  // but it's still the SAME DOM node the whole time. Indexing this by
  // position (the array-index version this replaced) looked up whatever
  // tile now rendered at that position after a reorder — a different node —
  // so the "follow the cursor" transform silently applied to the wrong
  // (or no) element after the first swap.
  const tileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const draggedNameRef = useRef<string | null>(null);
  // Cursor Y and the dragged tile's own natural (untransformed) top edge,
  // both re-baselined every time the array reorders — see the
  // useLayoutEffect below. Each pointermove's transform is just "how far
  // has the cursor moved since the last time we re-baselined", so a swap
  // (which shifts the tile's natural flex position by about one tile
  // height) never stacks its own layout shift on top of the already-correct
  // cursor-tracking offset — the classic bug this replaced, where the tile
  // visibly jumped away from the cursor after each swap.
  const baselineClientYRef = useRef(0);
  const baselineTransformYRef = useRef(0);
  // Set right before a swap reorders localSteps, to whatever the dragged
  // tile's natural (untransformed) top edge was at that instant. The
  // useLayoutEffect below reads it back after React has reflowed the list
  // with the new order, to measure exactly how far the reflow itself moved
  // the tile, and folds that into baselineTransformYRef so the visible
  // (transformed) position never jumps.
  const preSwapNaturalTopRef = useRef<number | null>(null);
  // Genuinely discrete state — only changes on drag start/end — purely for
  // the isDragging visual (dimming the tile being dragged).
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Ref mirror of localSteps so the pointerup handler below (captured once
  // per effect run, at drag start) always mutates with the latest reordered
  // list rather than a stale closure from when the drag began.
  const localStepsRef = useRef(localSteps);
  useEffect(() => {
    localStepsRef.current = localSteps;
  }, [localSteps]);

  useEffect(() => {
    setLocalSteps(steps);
  }, [steps]);

  // Runs synchronously right after React reflows the list with a new order
  // (before the browser paints), so it can measure exactly how far that
  // reflow moved the dragged tile's natural position and fold that shift
  // into the transform. Without this, the transform kept accumulating
  // relative to the tile's position at drag START, so every swap's own
  // ~one-tile-height layout shift stacked on top of the (already correct)
  // cursor-tracking offset — visibly kicking the tile away from the cursor
  // with each crossing, worse the further it had already traveled.
  useLayoutEffect(() => {
    const draggedName = draggedNameRef.current;
    const preSwapTop = preSwapNaturalTopRef.current;
    if (draggedName === null || preSwapTop === null) return;
    const el = tileRefs.current.get(draggedName);
    if (!el) return;

    const prevTransform = el.style.transform;
    el.style.transform = '';
    const postSwapNaturalTop = el.getBoundingClientRect().top;
    el.style.transform = prevTransform;

    const reflowShift = postSwapNaturalTop - preSwapTop;
    baselineTransformYRef.current -= reflowShift;
    el.style.transform = `translateY(${baselineTransformYRef.current}px)`;

    preSwapNaturalTopRef.current = null;
  }, [localSteps]);

  // Global pointermove/pointerup while a drag is active — attached to
  // `document` (not the tile) so the drag keeps tracking even if the pointer
  // briefly leaves a tile's bounds between two adjacent tiles.
  useEffect(() => {
    if (dragIndex === null) return;

    const handlePointerMove = (e: PointerEvent) => {
      const from = dragFromRef.current;
      const draggedName = draggedNameRef.current;
      if (from === null || draggedName === null) return;

      // Move the dragged tile with the cursor. Written straight to the DOM
      // (not via setState) so this tracks every pointermove at full frame
      // rate — routing it through React state would mean a re-render per
      // pixel of movement. The transform is "the offset in effect at the
      // last baseline" plus "how far the cursor has moved since then" — NOT
      // raw distance from where the drag first started. When a swap below
      // reorders the array, the tile's own natural (untransformed) flex
      // position shifts by about one tile height on the next render; if the
      // transform kept accumulating from the original drag-start position,
      // that layout shift stacked on top of the cursor-tracking offset and
      // visibly kicked the tile away from the cursor with every swap.
      // Re-baselining on each swap (below) means this always measures
      // motion relative to the tile's current resting spot, so the two
      // effects never combine.
      const transformY = baselineTransformYRef.current + (e.clientY - baselineClientYRef.current);
      const draggedEl = tileRefs.current.get(draggedName);
      if (draggedEl) {
        draggedEl.style.transform = `translateY(${transformY}px)`;
      }

      // Hit-test against each OTHER tile's current bounding box rather than
      // the event target, since the pointer capture is on the handle, not
      // the tile the cursor is currently over.
      const names = localStepsRef.current.map((s) => s.name);
      for (let i = 0; i < names.length; i++) {
        if (i === from) continue;
        const el = tileRefs.current.get(names[i]);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          // The dragged tile's natural (untransformed) top edge right now,
          // derived from its current rendered position minus the transform
          // already applied to it — read BEFORE the reorder below changes
          // its natural position. The useLayoutEffect after this render
          // compares this to the tile's natural top once the swap has
          // settled, and folds the difference into the transform so the
          // rendered pixel position doesn't jump.
          if (draggedEl) {
            preSwapNaturalTopRef.current = draggedEl.getBoundingClientRect().top - transformY;
          }
          setLocalSteps((prev) => {
            const next = [...prev];
            const [moved] = next.splice(from, 1);
            next.splice(i, 0, moved);
            return next;
          });
          dragFromRef.current = i;
          setDragIndex(i);
          baselineTransformYRef.current = transformY;
          baselineClientYRef.current = e.clientY;
          break;
        }
      }
    };

    const handlePointerUp = () => {
      const moved = dragFromRef.current !== dragStartIndexRef.current;
      const draggedName = draggedNameRef.current;
      if (draggedName !== null) {
        const draggedEl = tileRefs.current.get(draggedName);
        if (draggedEl) draggedEl.style.transform = '';
      }
      dragFromRef.current = null;
      dragStartIndexRef.current = null;
      draggedNameRef.current = null;
      setDragIndex(null);
      if (moved) {
        reorderMutation.mutate(localStepsRef.current.map((s) => s.name));
      }
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragIndex, reorderMutation]);

  if (isLoading) {
    return (
      <PageShell id={id}>
        <p className="text-gray-500 text-sm p-6">Loading…</p>
      </PageShell>
    );
  }

  const handlePointerDown = (e: React.PointerEvent, idx: number, name: string) => {
    // Suppress the browser's default text-selection drag — without this,
    // moving the pointer across sibling tiles during a drag highlights their
    // text the same way a click-drag text selection would.
    e.preventDefault();
    dragFromRef.current = idx;
    dragStartIndexRef.current = idx;
    draggedNameRef.current = name;
    baselineClientYRef.current = e.clientY;
    baselineTransformYRef.current = 0;
    setDragIndex(idx);
  };

  const statusOf = (name: string): StepStatus => stepStates[name]?.status ?? 'idle';

  const handleDelete = (step: InitStepDto) => {
    if (!confirm(`Delete script "${step.name.replace(/^custom:\s*/, '')}"? This cannot be undone.`)) return;
    deleteMutation.mutate(step.name);
  };

  // Persisted status (survives navigation + restarts); local SSE-driven state
  // during an active run takes priority once it fires.
  const displayRunning = setupRunning || project?.last_init_status === 'running';
  const effectiveLastRunAt = lastRunAt ?? project?.last_init_finished_at ?? null;
  const formattedLastRun = effectiveLastRunAt
    ? new Date(effectiveLastRunAt).toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : null;

  return (
    <PageShell id={id}>
      <div className="max-w-3xl mx-auto p-6 flex flex-col gap-8">
        {/* Header with Run Setup button */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-sm font-semibold text-gray-200">Initialization</h1>
            {formattedLastRun && (
              <p className="text-xs text-gray-600 mt-0.5">Last run: {formattedLastRun}</p>
            )}
          </div>
          <button
            onClick={() => runSetupMutation.mutate()}
            disabled={displayRunning || runSetupMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 text-sm rounded bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-medium transition-colors"
          >
            {displayRunning && (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 100 16v-4l-3 3 3 3v-4a8 8 0 01-8-8z" />
              </svg>
            )}
            {displayRunning ? 'Running…' : 'Run Setup'}
          </button>
        </div>

        {/* Setup steps section — a staggered flow of tiles joined by connectors */}
        <div className="flex flex-col gap-4">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Setup steps
          </h2>

          {/* pl-3 leaves room for the step-number badges straddling each tile's left edge */}
          <div className="pl-3">
          <div ref={flowRef} className={`flex flex-col ${dragIndex !== null ? 'select-none' : ''}`}>
            {localSteps.map((step, idx) => {
              const status = statusOf(step.name);
              return (
                <Fragment key={step.name}>
                  {idx > 0 && (
                    <StepConnector
                      width={flowWidth}
                      fromPct={laneCenterPct(idx - 1)}
                      toPct={laneCenterPct(idx)}
                      state={connectorState(statusOf(localSteps[idx - 1].name), status)}
                      dimmed={dragIndex !== null}
                    />
                  )}
                  <StepTile
                    step={step}
                    index={idx}
                    offsetPct={laneOffsetPct(idx)}
                    projectId={id}
                    runState={stepStates[step.name] ?? null}
                    onToggle={(enabled) =>
                      api.init.toggleStep(id, step.name, enabled).then(invalidate)
                    }
                    onRunStep={() => api.init.runStep(id, step.name)}
                    onEdit={!step.is_base ? () => setEditStep(step) : undefined}
                    onDelete={!step.is_base ? () => handleDelete(step) : undefined}
                    tileRef={(el) => {
                      if (el) tileRefs.current.set(step.name, el);
                      else tileRefs.current.delete(step.name);
                    }}
                    onHandlePointerDown={(e) => handlePointerDown(e, idx, step.name)}
                    isDragging={dragIndex === idx}
                  />
                </Fragment>
              );
            })}

            {localSteps.length > 0 && (
              <StepConnector
                width={flowWidth}
                fromPct={laneCenterPct(localSteps.length - 1)}
                toPct={laneCenterPct(localSteps.length)}
                state="add"
                dimmed={dragIndex !== null}
              />
            )}
            <AddStepTile
              offsetPct={laneOffsetPct(localSteps.length)}
              isFirst={localSteps.length === 0}
              onCreate={() => setNewStepOpen(true)}
              onLinkExisting={() => setFilePickerOpen(true)}
            />
          </div>
          </div>
        </div>
      </div>

      {newStepOpen && (
        <ScriptEditorModal
          projectId={id}
          initScriptPath={project?.init_script_path || 'wickd/init'}
          onClose={() => { setNewStepOpen(false); invalidate(); }}
        />
      )}

      {editStep && (
        <ScriptEditorModal
          projectId={id}
          initScriptPath={project?.init_script_path || 'wickd/init'}
          existing={editStep}
          onClose={() => { setEditStep(null); invalidate(); }}
        />
      )}

      {filePickerOpen && (
        <FilePickerModal
          projectPath={project?.path ?? '/'}
          onClose={() => setFilePickerOpen(false)}
          onSelect={async (path) => {
            try {
              await api.init.linkStep(id, path);
              setFilePickerOpen(false);
              invalidate();
            } catch (e) {
              alert(String(e));
            }
          }}
        />
      )}
    </PageShell>
  );
}

// ---- layout wrapper ----

function PageShell({ id, children }: { id: number; children: React.ReactNode }) {
  return (
    <div className="flex h-full overflow-hidden">
      <NavRail projectId={id} current="init" />
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}

