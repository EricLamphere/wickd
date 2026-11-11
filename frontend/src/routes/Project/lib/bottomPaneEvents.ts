import type { ImpactMode } from './impactChanges';

/**
 * Lets components outside the bottom pane (e.g. the SidePane's impact card or
 * the Git page banner) open it on a specific tab. BottomPane owns its
 * open/tab state, so this is a window event rather than lifted state.
 */
export const OPEN_BOTTOM_TAB_EVENT = 'wickd:open-bottom-tab';

export type BottomTabRequest = 'impact' | 'node-dag' | 'run' | 'project-logs';

export interface OpenBottomTabDetail {
  tab: BottomTabRequest;
  /** For the Impact tab: which source to show. */
  impactMode?: ImpactMode;
  /** For the Impact tab: turn contract checks on. */
  contracts?: boolean;
  /** For the Impact tab: turn data diff (Pro) on. */
  dataDiff?: boolean;
  /** For the Impact tab: open this model's data diff (Pro) in the drawer. */
  openDiff?: string;
}

export function openBottomTab(tab: BottomTabRequest, options: Omit<OpenBottomTabDetail, 'tab'> = {}): void {
  window.dispatchEvent(new CustomEvent<OpenBottomTabDetail>(OPEN_BOTTOM_TAB_EVENT, { detail: { tab, ...options } }));
}
