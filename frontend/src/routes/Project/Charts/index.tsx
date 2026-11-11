// Charts page (/projects/:id/charts; plan 17): the project's dbt Charts boards — YAML under
// charts/, rendered by the pinned `dct` (dbt-charts) from its sidecar venv. Board list on the
// left (?board=<id>, a history entry per selection; the last one is remembered per project for
// the session), the board on the right as a static build or live via `dct serve`.
// The nav item always shows; a project without boards gets an empty state here.
import { useCallback, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, ShieldCheck } from 'lucide-react';
import { chartsApi, chartsErrorMessage } from '../../../lib/chartsApi';
import { alertDialog } from '../../../lib/dialogs';
import NavRail from '../components/NavRail';
import { PageHeader } from '../components/PageHeader';
import { BoardList } from './BoardList';
import { BoardView } from './BoardView';
import { pickBoard } from './chartsView';
import { useChartBoards, useChartsEnv, useChartsValidation } from './useCharts';

const DOCS_URL = 'https://docs.getdbt.com/guides/dbt-charts';
const rememberKey = (id: number) => `charts-board:${id}`;

function remembered(id: number): string | null {
  try { return sessionStorage.getItem(rememberKey(id)); } catch { return null; }
}

function remember(id: number, board: string): void {
  try { sessionStorage.setItem(rememberKey(id), board); } catch { /* storage unavailable */ }
}

export default function ChartsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = Number(projectId);
  return (
    <div className="flex h-full overflow-hidden">
      <NavRail projectId={id} current="charts" />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <PageHeader page="charts" />
        <div className="flex-1 min-h-0 overflow-hidden"><ChartsContent id={id} /></div>
      </div>
    </div>
  );
}

function EmptyState({ hasDir }: { hasDir: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 h-full p-8 text-center">
      <h2 className="text-sm font-medium text-gray-200">No charts set up in this project yet</h2>
      <p className="max-w-md text-xs text-gray-500">
        {hasDir ? 'The charts/ folder has no boards yet.' : 'dbt Charts boards are YAML files in a charts/ folder next to dbt_project.yml.'}
        {' '}Add one (e.g. <span className="font-mono">charts/sales.yml</span>) and it shows up here, or export a metrics dashboard from its Export menu.
      </p>
      <a href={DOCS_URL} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-brand-400 hover:underline">
        dbt Charts guide <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  );
}

function ChartsContent({ id }: { id: number }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const list = useChartBoards(id);
  const env = useChartsEnv();
  const boards = list.data?.boards ?? [];
  const validation = useChartsValidation(id, boards.length > 0);
  const requested = searchParams.get('board');
  const selectedId = pickBoard(boards, requested, remembered(id));
  const selected = boards.find((b) => b.id === selectedId) ?? null;

  const select = useCallback((board: string, replace = false) => {
    remember(id, board);
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set('board', board); return p; }, { replace });
  }, [id, setSearchParams]);

  useEffect(() => { if (selectedId && selectedId !== requested) select(selectedId, true); }, [selectedId, requested, select]);

  const build = useMutation({
    mutationFn: (board: string) => chartsApi.build(id, board),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['charts', id] }),
    onError: (err) => { void alertDialog(`Couldn't build the board: ${chartsErrorMessage(err)}`); },
  });
  const openFile = useCallback((path: string) => navigate(`/projects/${id}/files?path=${encodeURIComponent(path)}`), [id, navigate]);

  if (list.isLoading) return <p className="p-6 text-xs text-gray-500">Loading boards…</p>;
  if (list.error || !list.data) return <p className="p-6 text-xs text-red-400">Couldn't load the boards: {chartsErrorMessage(list.error)}</p>;
  if (boards.length === 0) return <EmptyState hasDir={list.data.has_charts_dir} />;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex flex-col w-60 shrink-0 border-r border-gray-800">
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
          <span className="text-xs font-medium text-gray-300">Boards</span>
          <button onClick={() => validation.refetch()} disabled={validation.isFetching}
            title={`Check every board with dct validate (dbt Charts ${list.data.version})`}
            className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-200 disabled:opacity-50">
            {validation.isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />} Validate
          </button>
        </div>
        {env && <p className="px-3 py-2 text-[11px] text-brand-300 border-b border-gray-800">{env.message}…</p>}
        {validation.error && (
          <p className="px-3 py-2 text-[11px] text-red-400 border-b border-gray-800">{chartsErrorMessage(validation.error)}</p>
        )}
        <BoardList boards={boards} selected={selectedId} validation={validation.data?.boards}
          onSelect={(b) => select(b)} onOpenFile={openFile} />
        <p className="mt-auto px-3 py-2 text-[10px] text-gray-600 border-t border-gray-800">dbt Charts {list.data.version}</p>
      </aside>
      <main className="flex-1 min-w-0">
        {selected && (
          <BoardView projectId={id} board={selected} validation={validation.data?.boards[selected.id]}
            onBuild={() => build.mutate(selected.id)} onOpenFile={openFile} />
        )}
      </main>
    </div>
  );
}
