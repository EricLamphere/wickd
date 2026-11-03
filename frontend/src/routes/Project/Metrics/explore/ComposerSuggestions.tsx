// The query composer's suggestion list, under the line. Mouse-down keeps the focus in the input.
import type { Suggestion, SuggestionKind } from '../lib/composerSuggest';

const KIND_LABEL: Record<SuggestionKind, string> = {
  metric: 'metric', dimension: 'dimension', grain: 'grain', keyword: '', date: 'period', compare: 'compare',
  operator: 'operator', number: '', value: 'value',
};

export function ComposerSuggestions({ items, highlight, onPick, onHover, loading }: {
  items: Suggestion[];
  highlight: number;
  onPick: (item: Suggestion) => void;
  onHover: (index: number) => void;
  /** filter values being fetched */
  loading: boolean;
}) {
  if (!items.length && !loading) return null;
  return (
    <ul role="listbox" aria-label="Suggestions"
      className="absolute left-0 top-full z-30 mt-1 w-[28rem] max-w-full max-h-72 overflow-auto py-1 bg-surface-elevated border border-gray-700 rounded shadow-xl">
      {loading && !items.length && <li className="px-3 py-1.5 text-[11px] text-gray-500">Loading values…</li>}
      {items.map((item, i) => (
        <li key={`${item.kind}:${item.insert}`} role="option" aria-selected={i === highlight}
          onMouseDown={(e) => { e.preventDefault(); onPick(item); }} onMouseEnter={() => onHover(i)}
          className={`flex items-center gap-2 px-3 py-1 text-xs cursor-pointer ${i === highlight ? 'bg-gray-800 text-gray-100' : 'text-gray-300'}`}>
          <span className={`truncate ${item.kind === 'dimension' || item.kind === 'value' ? 'font-mono' : ''}`}>{item.label}</span>
          {item.detail && <span className="truncate text-[10px] text-gray-500">{item.detail}</span>}
          {KIND_LABEL[item.kind] && <span className="ml-auto shrink-0 text-[10px] text-gray-600">{KIND_LABEL[item.kind]}</span>}
        </li>
      ))}
    </ul>
  );
}
