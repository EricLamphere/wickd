import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../../../lib/api';
import { alertError } from '../../../../lib/dialogs';
import type { Activity } from '../../lib/activity';
import { SUCCESS_LINGER_MS, bubbleView, runsPageLink, type Celebration } from '../../lib/activityView';
import { openBottomTab } from '../../lib/bottomPaneEvents';
import { EDGE_MARGIN } from '../../lib/bubblePosition';
import { ActivityPanel } from './ActivityPanel';
import { Confetti } from './Confetti';
import { BUBBLE_TONE, STATUS_LABEL, StatusIcon } from './statusStyle';
import { BUBBLE_SIZE_PX, useBubbleDrag } from './useBubbleDrag';
import { useActivity } from './useActivity';

const TICK_MS = 1000;
const PANEL_GAP_PX = 8; // gap-2 between the bubble and the panel
const EFFECT_MS = 1000;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.(REDUCED_MOTION).matches ?? false);
  useEffect(() => {
    const mql = window.matchMedia?.(REDUCED_MOTION);
    if (!mql) return;
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** A clock for elapsed times and the success linger; ticks only while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

/** Plays each finish's celebration once (keyed by activity), for EFFECT_MS. */
function useCelebration(next: Celebration | null): Celebration | null {
  const played = useRef<string | null>(null);
  const [effect, setEffect] = useState<Celebration | null>(null);
  useEffect(() => {
    if (!next || played.current === next.key) return;
    played.current = next.key;
    setEffect(next);
  }, [next]);
  useEffect(() => {
    if (!effect) return;
    const timer = setTimeout(() => setEffect(null), EFFECT_MS);
    return () => clearTimeout(timer);
  }, [effect]);
  return effect;
}

/**
 * Running-status bubble (plan 29): bottom right of the page area, above the bottom pane and left
 * of Wicky, until dragged elsewhere. Shows what's running; click to expand the activity list.
 */
export function ActivityBubble({ projectId }: { projectId: number }) {
  const navigate = useNavigate();
  const { state, dismiss } = useActivity(projectId);
  const [open, setOpen] = useState(false);
  // Tick while something runs or a success is lingering as a pill; the resting circle needs no clock.
  const lingering = state.activities.some(
    (a) => a.status === 'success' && !a.acknowledged && a.finishedAt !== null && Date.now() - a.finishedAt <= SUCCESS_LINGER_MS,
  );
  const running = state.activities.some((a) => a.status === 'running');
  const now = useNow(open || running || lingering);
  const view = bubbleView(state, now);
  const reducedMotion = usePrefersReducedMotion();
  const effect = useCelebration(view.celebrate);
  const drag = useBubbleDrag();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // a dialog or the command palette on top handles its own Escape
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const toggle = useCallback(() => {
    setOpen((was) => !was);
    dismiss(); // clicking counts as seeing it: finished activities stop showing once closed
  }, [dismiss]);

  const openActivity = useCallback((a: Activity) => {
    if (a.open.kind === 'bottom-tab') openBottomTab(a.open.tab);
    else {
      navigate(`/projects/${projectId}/${a.open.page}`);
      setOpen(false);
    }
    // a bottom pane tab opens below the bubble: keep the list open
  }, [navigate, projectId]);

  const openInRuns = useCallback((a: Activity) => {
    if (a.invocationId === null) return;
    navigate(runsPageLink(projectId, a.invocationId));
    setOpen(false);
  }, [navigate, projectId]);

  const cancelActivity = useCallback(async (a: Activity) => {
    if (a.kind !== 'run') return;
    try {
      await api.runHistory.cancel(projectId);
    } catch (err) {
      await alertError(err);
    }
  }, [projectId]);

  const onBubbleClick = useCallback(() => {
    if (drag.consumeClick()) return; // the release of a drag
    toggle();
  }, [drag, toggle]);

  const shaking = effect?.effect === 'shake' && !reducedMotion;
  const popping = effect?.effect === 'confetti' && !reducedMotion;
  const pill = view.mode === 'pill';
  const label = `${STATUS_LABEL[view.status]}: ${view.title}${view.more ? ` and ${view.more} more` : ''}`;
  const { anchor, offset } = drag;
  const dragStyle: CSSProperties | undefined = offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined;

  const bubble = (
    <div className="relative pointer-events-auto">
      {popping && <Confetti />}
      <button
        type="button"
        {...drag.handlers}
        onClick={onBubbleClick}
        aria-expanded={open}
        aria-label={`${label}. Drag to move.`}
        title={pill ? undefined : view.title}
        style={{ touchAction: 'none' }}
        className={`flex items-center h-[30px] rounded-full border shadow-lg backdrop-blur text-xs transition-colors select-none
          ${pill ? 'gap-2 max-w-[20rem] pl-2.5 pr-3' : 'justify-center w-[30px]'}
          ${BUBBLE_TONE[view.status]}
          ${view.status === 'running' ? 'motion-safe:animate-step-glow' : ''}
          ${popping ? 'motion-safe:animate-bubble-pop' : ''}
          ${shaking ? 'motion-safe:animate-bubble-shake' : ''}
          ${offset ? 'cursor-grabbing' : ''}
          hover:brightness-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400`}
      >
        <StatusIcon status={view.status} className="w-3.5 h-3.5 shrink-0" />
        {pill && <span className="truncate">{view.title}</span>}
        {pill && view.more > 0 && <span className="shrink-0 opacity-70">+{view.more} more</span>}
      </button>
    </div>
  );

  const panel = open && (
    <ActivityPanel
      projectId={projectId}
      activities={state.activities}
      now={now}
      maxHeight={anchor ? drag.viewport.height - anchor.y - BUBBLE_SIZE_PX - PANEL_GAP_PX - EDGE_MARGIN : undefined}
      onOpen={openActivity}
      onOpenInRuns={openInRuns}
      onCancel={cancelActivity}
      onClose={() => setOpen(false)}
      onResetPosition={anchor ? drag.reset : undefined}
    />
  );

  const announcement = (
    <span role="status" aria-live="polite" className="sr-only">
      {view.status !== 'running' && view.status !== 'idle' ? `${view.title}: ${STATUS_LABEL[view.status]}` : ''}
    </span>
  );

  if (!anchor) {
    // default: bottom right of the page area, above the bottom pane and left of Wicky
    return (
      <div className="absolute inset-0 z-[48] flex flex-col items-end justify-end gap-2 p-3 pointer-events-none" style={dragStyle}>
        {announcement}
        {panel}
        {bubble}
      </div>
    );
  }
  // dragged: pinned to the nearest window corner; the panel opens away from that edge.
  // z-[48]: above the header (z-[45]) so it can sit there, below modals (z-50) and dialogs.
  const nearTop = anchor.vertical === 'top';
  return (
    <div
      className={`fixed z-[48] flex gap-2 pointer-events-none ${nearTop ? 'flex-col-reverse' : 'flex-col'} ${anchor.horizontal === 'left' ? 'items-start' : 'items-end'}`}
      style={{ [anchor.horizontal]: anchor.x, [anchor.vertical]: anchor.y, ...dragStyle }}
    >
      {announcement}
      {panel}
      {bubble}
    </div>
  );
}
