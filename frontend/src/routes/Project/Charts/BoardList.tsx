// The Charts page's left rail: the project's boards under charts/, grouped by folder.
// Click selects (a history entry); ⌘-click opens the board's YAML in Files.
import { AlertTriangle, LayoutDashboard, Loader2 } from 'lucide-react';
import type { BoardValidation, ChartBoard } from '../../../lib/chartsApi';
import { groupByFolder } from './chartsView';

interface Props {
  boards: ChartBoard[];
  selected: string | null;
  validation: Record<string, BoardValidation> | undefined;
  onSelect: (id: string) => void;
  onOpenFile: (path: string) => void;
}

function BoardRow({ board, active, validation, onSelect, onOpenFile }: {
  board: ChartBoard; active: boolean; validation: BoardValidation | undefined;
  onSelect: (id: string) => void; onOpenFile: (path: string) => void;
}) {
  const broken = !!board.error || (validation ? !validation.ok : false) || board.build?.ok === false;
  const name = board.id.includes('/') ? board.id.slice(board.id.lastIndexOf('/') + 1) : board.id;
  return (
    <button
      onClick={(e) => (e.metaKey || e.ctrlKey ? onOpenFile(board.path) : onSelect(board.id))}
      title={`${board.path} — ⌘-click to open the YAML`}
      className={`flex items-start gap-2 w-full px-3 py-1.5 rounded-md text-left transition-colors
        ${active ? 'bg-brand-900/40 text-brand-200' : 'text-gray-300 hover:bg-surface-elevated'}`}
    >
      <LayoutDashboard className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gray-500" />
      <span className="flex-1 min-w-0">
        <span className="block truncate text-xs">{board.title}</span>
        <span className="block truncate text-[10px] text-gray-500 font-mono">{name}</span>
      </span>
      {board.building && <Loader2 className="w-3.5 h-3.5 mt-0.5 shrink-0 animate-spin text-brand-400" />}
      {!board.building && broken && <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-400" />}
    </button>
  );
}

export function BoardList({ boards, selected, validation, onSelect, onOpenFile }: Props) {
  return (
    <div className="flex flex-col gap-3 p-2 overflow-y-auto">
      {groupByFolder(boards).map((group) => (
        <div key={group.folder || '/'} className="flex flex-col gap-0.5">
          {group.folder && (
            <p className="px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-widest text-gray-600">{group.folder}</p>
          )}
          {group.boards.map((b) => (
            <BoardRow key={b.id} board={b} active={b.id === selected} validation={validation?.[b.id]}
              onSelect={onSelect} onOpenFile={onOpenFile} />
          ))}
        </div>
      ))}
    </div>
  );
}
