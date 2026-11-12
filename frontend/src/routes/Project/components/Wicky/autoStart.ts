import type { FocusHint, WickyAction } from '../../lib/wickyEvents';
import type { ChatRequest } from './AiChat';

export interface AutoStart {
  nonce: number;
  action: WickyAction;
  focusHint?: FocusHint;
}

/**
 * The quick action QuickActions should start for `uniqueId`, if any. An action asked
 * for with openWicky({ action }) runs once (`takenNonce` = the last one started) and only
 * on the node it named. QuickActions remounts per node, so without this the action
 * would start again on every node the user clicks afterwards.
 */
export function autoStartFor(request: ChatRequest | null, takenNonce: number | null, uniqueId: string): AutoStart | null {
  if (!request?.action || request.nonce === takenNonce) return null;
  if (request.uniqueId && request.uniqueId !== uniqueId) return null;
  return { nonce: request.nonce, action: request.action, focusHint: request.focusHint };
}
