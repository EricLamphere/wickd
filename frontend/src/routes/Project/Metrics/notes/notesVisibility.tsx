// Whether note markers show (plan 33): a dashboard's Notes toggle (also in Present mode) hides
// them, and an export renders with notes left out or kept (kept pins then stay in the file).
// Everywhere else notes show, so the default is visible.
import { createContext, useContext, useEffect, useState } from 'react';

export interface NotesVisibility {
  show: boolean;
  /** rendering for an export that includes notes: pins stay in the captured markup */
  inExport: boolean;
}

export const NotesVisibilityContext = createContext<NotesVisibility>({ show: true, inExport: false });

export function useNotesVisible(): NotesVisibility {
  return useContext(NotesVisibilityContext);
}

const storageKey = (projectId: number, slug: string) => `wickd:dashboard-notes:${projectId}:${slug}`;

/** A dashboard's Notes toggle, remembered per dashboard (on by default). */
export function useDashboardNotesShown(projectId: number, slug: string): [boolean, (show: boolean) => void] {
  const read = () => {
    try { return localStorage.getItem(storageKey(projectId, slug)) !== 'off'; } catch { return true; }
  };
  const [shown, setShown] = useState(read);
  useEffect(() => { setShown(read()); }, [projectId, slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (show: boolean) => {
    setShown(show);
    try {
      if (show) localStorage.removeItem(storageKey(projectId, slug)); else localStorage.setItem(storageKey(projectId, slug), 'off');
    } catch { /* storage unavailable: kept for this visit */ }
  };
  return [shown, set];
}

/** Two frames: long enough for React to commit a visibility change and the charts to repaint. */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
