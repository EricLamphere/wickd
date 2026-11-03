// The board itself, in an iframe: Static = the last `dct render --format html` (served by the
// backend, same origin, scripts only); Live = `dct serve` on its own 127.0.0.1 port (started on
// demand, kept alive with a touch every few minutes while shown — the server stops after 10 idle
// minutes). Live boards keep their variables, filters and drill links; static ones are a snapshot.
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Play, RefreshCw } from 'lucide-react';
import { chartsApi, chartsErrorMessage, staticBoardUrl, type ChartBoard } from '../../../lib/chartsApi';
import { liveBoardUrl } from './chartsView';

const TOUCH_EVERY_MS = 3 * 60 * 1000;
const FRAME = 'flex-1 w-full min-h-0 border-0 bg-white';

export function StaticFrame({ projectId, board, onBuild }: { projectId: number; board: ChartBoard; onBuild: () => void }) {
  if (!board.build?.has_output) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-3 p-8 text-center">
        <p className="max-w-sm text-xs text-gray-500">
          Building runs every query on the board against the warehouse, then shows the result here as a snapshot.
        </p>
        <button onClick={onBuild} disabled={board.building || !!board.error}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand-600 text-xs text-white hover:bg-brand-500 disabled:opacity-50">
          {board.building ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {board.building ? 'Building…' : 'Build board'}
        </button>
      </div>
    );
  }
  return (
    <iframe key={board.build.built_at} title={board.title} src={staticBoardUrl(projectId, board)}
      sandbox="allow-scripts allow-popups" className={FRAME} />
  );
}

export function LiveFrame({ projectId, board }: { projectId: number; board: ChartBoard }) {
  const [reload, setReload] = useState(0);
  const start = useMutation({ mutationFn: () => chartsApi.startLive(projectId) });
  const { mutate } = start;

  useEffect(() => { mutate(); }, [projectId, mutate]);
  useEffect(() => {
    if (!start.data) return undefined;
    const timer = setInterval(() => { chartsApi.touchLive(projectId).catch(() => undefined); }, TOUCH_EVERY_MS);
    return () => clearInterval(timer);
  }, [projectId, start.data]);

  if (start.isPending || (!start.data && !start.error)) {
    return (
      <div className="flex items-center justify-center flex-1 gap-2 text-xs text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin" /> Starting dct serve…
      </div>
    );
  }
  if (start.error || !start.data) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-3 p-8 text-center">
        <p className="max-w-lg text-xs text-red-400 whitespace-pre-wrap">Couldn't start the live server: {chartsErrorMessage(start.error)}</p>
        <button onClick={() => mutate()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-700 text-xs text-gray-300 hover:bg-surface-elevated">
          <RefreshCw className="w-3.5 h-3.5" /> Try again
        </button>
      </div>
    );
  }
  const url = liveBoardUrl(start.data.base_url, board.url_path);
  return (
    <div className="relative flex flex-col flex-1 min-h-0">
      <iframe key={`${url}#${reload}`} title={board.title} src={url}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups" className={FRAME} />
      <button onClick={() => setReload((n) => n + 1)} title="Reload the live board"
        className="absolute top-2 right-2 p-1.5 rounded-md bg-gray-900/70 text-gray-300 hover:text-white">
        <RefreshCw className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
