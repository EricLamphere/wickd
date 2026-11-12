// The Configure tab edits a draft of the selected widget: the canvas (and the file, and the
// warehouse) see nothing until Apply. Leaving the widget with unapplied changes asks first.
import { useCallback, useRef, useState } from 'react';
import type { DashboardWidget } from '../../../../../lib/dashboardsApi';
import { confirmDialog } from '../../../../../lib/dialogs';
import { sameConfig } from '../dashboardModel';

export interface WidgetDraft {
  /** what Configure shows: the draft, else the widget as saved */
  shown: DashboardWidget | null;
  dirty: boolean;
  edit: (w: DashboardWidget) => void;
  apply: () => void;
  discard: () => void;
  /** Before the selection moves off the widget: apply or discard unapplied changes (asks). */
  settle: () => Promise<void>;
}

export function useWidgetDraft(widget: DashboardWidget | null, title: string, commit: (w: DashboardWidget) => void): WidgetDraft {
  const [draft, setDraft] = useState<DashboardWidget | null>(null);
  const asking = useRef(false);
  // a draft belongs to one widget; selecting another (or deleting it) leaves it behind
  const current = draft && widget && draft.id === widget.id ? draft : null;
  const dirty = !!current && !!widget && !sameConfig(current, widget);

  const apply = useCallback(() => {
    // size and position stay as they are on the canvas (resizing doesn't wait for Apply)
    if (current && widget && dirty) commit({ ...current, width: widget.width, height: widget.height });
    setDraft(null);
  }, [current, widget, dirty, commit]);
  const discard = useCallback(() => setDraft(null), []);

  const settle = useCallback(async () => {
    if (!dirty) { setDraft(null); return; }
    if (asking.current) return;
    asking.current = true;
    try {
      const yes = await confirmDialog(`Apply your changes to ${title}?`, {
        title: 'Unapplied changes', confirmLabel: 'Apply', cancelLabel: 'Discard',
      });
      if (yes) apply(); else discard();
    } finally {
      asking.current = false;
    }
  }, [dirty, title, apply, discard]);

  return { shown: current ?? widget, dirty, edit: setDraft, apply, discard, settle };
}
