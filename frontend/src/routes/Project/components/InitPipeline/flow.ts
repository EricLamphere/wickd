// Layout + state helpers for the Initialization page's step flow. Pure, so
// the lane wave and connector colouring are unit-tested in flow.test.ts.

export type StepStatus = 'idle' | 'running' | 'success' | 'error';

export interface StepRunState {
  status: StepStatus;
  log: string;
  finishedAt: string | null;
}

/** Each tile's width as a percentage of the flow column. */
export const TILE_WIDTH_PCT = 78;

// Left offset (percent) per position: a gentle wave left → right → left, so
// consecutive tiles sit staggered and the connectors between them curve.
const LANE_OFFSETS_PCT = [0, 11, 22, 11] as const;

export function laneOffsetPct(index: number): number {
  return LANE_OFFSETS_PCT[index % LANE_OFFSETS_PCT.length];
}

/** Horizontal centre (percent of the column) of the tile at `index`. */
export function laneCenterPct(index: number): number {
  return laneOffsetPct(index) + TILE_WIDTH_PCT / 2;
}

/**
 * idle   — nothing has happened yet (slow grey flow)
 * active — the downstream step is running (fast blue flow)
 * done   — the upstream step succeeded (green flow)
 * failed — the upstream step failed (static red, the run stopped there)
 * add    — leads into the "add step" placeholder (static dashed grey)
 */
export type ConnectorState = 'idle' | 'active' | 'done' | 'failed' | 'add';

export function connectorState(from: StepStatus, to: StepStatus): ConnectorState {
  if (to === 'running') return 'active';
  if (from === 'error') return 'failed';
  if (from === 'success') return 'done';
  return 'idle';
}

interface PersistedStep {
  name: string;
  last_status: string;
  last_log: string;
  last_finished_at: string | null;
  run_state: 'pending' | 'running' | 'success' | 'error' | null;
}

/**
 * Tile states from the server's step rows, for when the page (re)mounts. During
 * a run, steps not reached yet are idle (their stored status is from the last
 * run) and the rest show their live status, the same as a page that watched the
 * run start; outside a run every step shows how it last finished.
 */
export function seedStepStates(steps: readonly PersistedStep[]): { states: Record<string, StepRunState>; running: boolean } {
  const states: Record<string, StepRunState> = {};
  let running = false;
  for (const s of steps) {
    if (s.run_state) running = true;
    const status = s.run_state ?? s.last_status;
    if (status === 'pending' || status === 'idle' || !status) continue;
    states[s.name] = {
      status: status as StepStatus,
      log: s.run_state === 'running' ? '' : s.last_log,
      finishedAt: s.run_state === 'running' ? null : s.last_finished_at,
    };
  }
  return { states, running };
}
