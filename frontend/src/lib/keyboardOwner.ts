// App-wide shortcuts (⌘K command palette) listen on window in the capture phase, so they run
// before a focused editor's own handler. An element marked `data-keyboard-owner` (or inside one)
// handles its own ⌘ shortcuts, and the global ones step aside for it.
export function ownsShortcuts(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-keyboard-owner]') !== null;
}
