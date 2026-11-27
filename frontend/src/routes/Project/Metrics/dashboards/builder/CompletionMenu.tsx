// The suggestions list MarkdownEditor shows at the caret (metric notes: `[[`, `model:`, `commit:`).
// Keyboard: ↑ ↓ move, Enter / Tab choose, Esc close (handled by the editor); click chooses.
export interface Completion {
  /** shown */
  label: string;
  /** shown muted beside it */
  detail?: string;
  /** passed back to the source's apply() */
  value: string;
}

export interface CompletionSource {
  /** suggestions for the text at the caret, or null when nothing is being typed there */
  suggest: (text: string, caret: number) => { title: string; items: Completion[] } | null;
  /** the text with `item` chosen, and where the caret goes */
  apply: (text: string, caret: number, item: Completion) => { text: string; caret: number } | null;
}

export function CompletionMenu({ title, items, index, left, top, onPick, onHover }: {
  title: string;
  items: Completion[];
  index: number;
  left: number;
  top: number;
  onPick: (item: Completion) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div role="listbox" aria-label={title} style={{ left, top }}
      className="absolute z-30 w-72 max-h-56 overflow-auto py-1 bg-surface-elevated border border-gray-700 rounded shadow-xl">
      <p className="px-2.5 pb-1 text-[10px] text-gray-500 border-b border-gray-800">{title}</p>
      {items.length === 0 && <p className="px-2.5 py-1.5 text-[11px] text-gray-500">No matches</p>}
      {items.map((item, i) => (
        <button key={`${item.value}-${i}`} type="button" role="option" aria-selected={i === index}
          onMouseDown={(e) => { e.preventDefault(); onPick(item); }} onMouseEnter={() => onHover(i)}
          className={`flex items-baseline gap-2 w-full px-2.5 py-1 text-left ${i === index ? 'bg-brand-950/60' : 'hover:bg-gray-800'}`}>
          <span className="text-xs text-gray-200 font-mono truncate">{item.label}</span>
          {item.detail && <span className="flex-1 min-w-0 text-[10px] text-gray-500 truncate text-right">{item.detail}</span>}
        </button>
      ))}
    </div>
  );
}
