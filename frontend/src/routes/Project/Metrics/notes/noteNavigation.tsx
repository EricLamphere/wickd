// How a note shown in a dialog opens another note it links to (plan 33): the dialog's host pushes
// it onto its back / forward history. Outside a note dialog, links open the note through NoteHost.
import { createContext, useContext } from 'react';
import { openMetricNote } from './noteEvents';
import { canGoBack, canGoForward, goBack, goForward, pushNote, type NoteHistory } from './lib/noteHistory';

export const NoteNavigationContext = createContext<((slug: string) => void) | null>(null);

/** Open a linked note: in the same dialog (with history) when inside one, else through NoteHost. */
export function useOpenLinkedNote(): (slug: string) => void {
  return useContext(NoteNavigationContext) ?? openMetricNote;
}

/** Back / forward through the notes followed in a dialog, and how a link opens the next one. */
export interface NoteNav {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onOpen: (slug: string) => void;
}

/** The dialog's navigation over a history the host keeps (`set` gets each new history). */
export function noteNav(history: NoteHistory, set: (next: NoteHistory) => void): NoteNav {
  return {
    canBack: canGoBack(history),
    canForward: canGoForward(history),
    onBack: () => set(goBack(history)),
    onForward: () => set(goForward(history)),
    onOpen: (slug) => set(pushNote(history, slug)),
  };
}
