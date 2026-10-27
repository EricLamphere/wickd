/**
 * Lets components outside the Wicky pane (e.g. the command palette) open it,
 * optionally sending a question. WickyPane owns its open state, so this is a
 * window event rather than lifted state (same pattern as bottomPaneEvents.ts).
 */
import type { AskMode } from '../../../lib/aiApi';

export const OPEN_WICKY_EVENT = 'wickd:open-wicky';

/** Ask = answers from the project's code and docs; Query = Wicky writes SQL you run;
 *  Refactor = Wicky turns a request into a rename / extract you confirm and review. */
export type WickyChatMode = 'ask' | 'query' | 'refactor';

export interface OpenWickyDetail {
  /** Sent as soon as the chat is ready; omitted → just open and focus the input. */
  question?: string;
  chatMode?: WickyChatMode;
  /** Ask about this node, for pages with no selection of their own (e.g. Run History).
   *  Stays Wicky's context until the page's selected node changes. */
  uniqueId?: string;
  mode?: AskMode;
}

export function openWicky(detail: OpenWickyDetail = {}): void {
  window.dispatchEvent(new CustomEvent<OpenWickyDetail>(OPEN_WICKY_EVENT, { detail }));
}
