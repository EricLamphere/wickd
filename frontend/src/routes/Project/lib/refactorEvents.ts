/**
 * Starts a refactor from anywhere (side pane, Docs column rows, the Files editor).
 * RefactorHost (mounted once in ProjectLayout) asks for the new name, builds the
 * proposal, opens the review and reports the outcome — so entry points only
 * dispatch this event (same pattern as wickyEvents.ts / bottomPaneEvents.ts).
 */
import type { RefactorOp } from '../../../lib/aiApi';

export const START_REFACTOR_EVENT = 'wickd:start-refactor';

export interface StartRefactorDetail {
  op: RefactorOp;
  uniqueId: string;
  /** the model's name, for the dialog */
  model: string;
  /** rename_column */
  column?: string;
  /** extract_cte */
  cte?: string;
}

export function startRefactor(detail: StartRefactorDetail): void {
  window.dispatchEvent(new CustomEvent<StartRefactorDetail>(START_REFACTOR_EVENT, { detail }));
}
