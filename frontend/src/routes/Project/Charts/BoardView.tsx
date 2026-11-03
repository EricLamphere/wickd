// One board: header (title, path, build status), Static / Live switch (sticky per project),
// Build, Open YAML, the board's issues, then the board in a frame.
import { FileCode2, Hammer, Loader2 } from 'lucide-react';
import type { BoardValidation, ChartBoard } from '../../../lib/chartsApi';
import { useStickyTab } from '../../../lib/useUrlTab';
import { LiveFrame, StaticFrame } from './BoardFrame';
import { IssueList } from './IssueList';
import { boardIssues, buildLabel, VIEW_MODES, type ViewMode } from './chartsView';

interface Props {
  projectId: number;
  board: ChartBoard;
  validation: BoardValidation | undefined;
  onBuild: () => void;
  onOpenFile: (path: string) => void;
}

const BTN = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-gray-700 text-xs text-gray-300 hover:bg-surface-elevated disabled:opacity-50';

function ModeSwitch({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="flex rounded-md border border-gray-700 overflow-hidden" role="tablist">
      {VIEW_MODES.map((m) => (
        <button key={m} role="tab" aria-selected={m === mode} onClick={() => onChange(m)}
          title={m === 'live' ? 'Interactive: dct serve (variables, filters, drill links)' : 'The last build, as a snapshot'}
          className={`px-2.5 py-1 text-xs capitalize ${m === mode ? 'bg-brand-900/50 text-brand-200' : 'text-gray-400 hover:bg-surface-elevated'}`}>
          {m}
        </button>
      ))}
    </div>
  );
}

export function BoardView({ projectId, board, validation, onBuild, onOpenFile }: Props) {
  const [mode, setMode] = useStickyTab<ViewMode>(`charts-mode:${projectId}`, VIEW_MODES, 'static');
  const issues = boardIssues(validation, board.build);
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-800">
        <div className="flex-1 min-w-0">
          <h1 className="truncate text-sm font-medium text-gray-100">{board.title}</h1>
          <p className="truncate text-[11px] text-gray-500">
            <span className="font-mono">{board.path}</span>
            {board.chart_count > 0 && ` · ${board.chart_count} chart${board.chart_count === 1 ? '' : 's'}`}
            {board.build && ` · ${buildLabel(board.build)}`}
          </p>
        </div>
        <ModeSwitch mode={mode} onChange={setMode} />
        {mode === 'static' && (
          <button onClick={onBuild} disabled={board.building || !!board.error} className={BTN}
            title="Run the board's queries and render it again">
            {board.building ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Hammer className="w-3.5 h-3.5" />}
            {board.building ? 'Building…' : board.build ? 'Rebuild' : 'Build'}
          </button>
        )}
        <button onClick={() => onOpenFile(board.path)} className={BTN}><FileCode2 className="w-3.5 h-3.5" />Open YAML</button>
      </div>
      {board.error && <p className="px-4 py-2 text-xs text-red-400 border-b border-gray-800">{board.error}</p>}
      {board.build && !board.build.ok && board.build.error && (
        <p className="px-4 py-2 text-xs text-red-400 border-b border-gray-800 whitespace-pre-wrap">Last build failed: {board.build.error}</p>
      )}
      <IssueList issues={issues} onOpenLine={() => onOpenFile(board.path)} />
      {mode === 'static'
        ? <StaticFrame projectId={projectId} board={board} onBuild={onBuild} />
        : <LiveFrame projectId={projectId} board={board} />}
    </div>
  );
}
