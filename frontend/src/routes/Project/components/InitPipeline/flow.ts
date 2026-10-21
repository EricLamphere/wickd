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
