import { Check, RotateCcw, X } from 'lucide-react';
import type { ProposalItem } from './proposalItems';
import { SmokeRows } from './SmokeRows';

export type ItemState = 'pending' | 'accepted' | 'rejected';

interface ChangeListProps {
  items: ProposalItem[];
  stateOf: (key: string) => ItemState;
  focused: string | null;
  disabled: boolean;
  onFocus: (item: ProposalItem) => void;
  onDecide: (key: string, decision: 'accept' | 'reject' | 'undo') => void;
}

const ROW_STATE: Record<ItemState, string> = {
  pending: 'text-gray-300',
  accepted: 'text-gray-300',
  rejected: 'text-gray-600 line-through',
};

/** The proposal's changes, one per row: click to jump to it in the diff, ✓ / ✗ to decide it. */
export function ChangeList({ items, stateOf, focused, disabled, onFocus, onDecide }: ChangeListProps) {
  const decided = items.filter((i) => stateOf(i.key) !== 'pending').length;
  return (
    <div className="w-72 shrink-0 border-r border-gray-800 overflow-auto">
      <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">
        Changes ({decided} of {items.length} reviewed)
      </div>
      {items.map((item) => {
        const state = stateOf(item.key);
        const failures = item.test?.failures;
        return (
          <div
            key={item.key}
            onClick={() => state !== 'rejected' && onFocus(item)}
            className={`group flex items-start gap-2 px-3 py-1.5 text-xs border-l-2 ${
              focused === item.key ? 'border-brand-500 bg-surface-elevated' : 'border-transparent hover:bg-surface-elevated/60'
            } ${state === 'rejected' ? 'cursor-default' : 'cursor-pointer'}`}
          >
            <span className={`min-w-0 flex-1 ${ROW_STATE[state]}`}>
              <code className="text-brand-300 break-all">{item.title}</code>{' '}
              <span className="break-words">{item.detail}</span>
              {failures === 0 && <span className="ml-1 text-emerald-400 no-underline">✓ passes</span>}
              {typeof failures === 'number' && failures > 0 && (
                <span className="ml-1 text-amber-400">✗ {failures} failing</span>
              )}
              {item.why && <span className="block text-gray-500 break-words">{item.why}</span>}
              {item.semantic?.kind === 'metric' && <SmokeRows smoke={item.semantic.smoke} />}
            </span>
            <span className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
              {state === 'pending' ? (
                <>
                  <button
                    onClick={() => onDecide(item.key, 'reject')}
                    disabled={disabled}
                    className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-800 disabled:opacity-40"
                    title="Reject this change"
                  >
                    <X size={13} />
                  </button>
                  <button
                    onClick={() => onDecide(item.key, 'accept')}
                    disabled={disabled}
                    className="p-1 rounded text-gray-500 hover:text-emerald-400 hover:bg-gray-800 disabled:opacity-40"
                    title="Accept this change"
                  >
                    <Check size={13} />
                  </button>
                </>
              ) : (
                <>
                  {state === 'accepted' && <Check size={13} className="text-emerald-400" />}
                  <button
                    onClick={() => onDecide(item.key, 'undo')}
                    disabled={disabled}
                    className="p-1 rounded text-gray-600 hover:text-gray-300 hover:bg-gray-800 disabled:opacity-40"
                    title="Undo"
                  >
                    <RotateCcw size={12} />
                  </button>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
