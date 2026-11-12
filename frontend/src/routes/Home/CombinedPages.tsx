import { useCallback, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, Package } from 'lucide-react';
import type { DocsNodeDto } from '../../lib/api';
import { docsPagesApi, type DocsPagesListDto } from '../../lib/docsPagesApi';
import { useGlobalEvents } from '../../lib/sse';
import { DocsScopeProvider, type DocsScope } from '../Project/DocsBrowser/docsScope';
import { PageDetail } from '../Project/DocsBrowser/pages/PageDetail';
import { foldersOf, filterPages } from '../Project/DocsBrowser/pages/pageFolders';
import { PagesTree } from '../Project/DocsBrowser/pages/PagesTree';
import { useExpandedSet } from '../Project/DocsBrowser/useExpandedSet';
import { pagePathOf } from '../Project/lib/docsLastView';
import { nodeKey, parseNodeKey, resolveNodeKey, type ProjectDocs } from './docsJoin';

/** One selected project's docs folder (Docs → Pages), for the combined Pages tab. */
export interface ProjectPages {
  projectId: number;
  name: string;
  list: DocsPagesListDto;
}

const ROOT_CLOSED = '__root__:closed';

/**
 * Every selected project's Markdown pages. Pages don't need generated docs. Kept fresh by
 * `docs_pages_changed` on the global stream (the watcher mirrors it there for this page).
 */
export function useCombinedPages(projects: { id: number; name: string }[]) {
  const qc = useQueryClient();
  useGlobalEvents(useCallback((event) => {
    if (event.type !== 'docs_pages_changed') return;
    const projectId = (event.data as { project_id?: number }).project_id;
    if (projectId === undefined) return;
    qc.invalidateQueries({ queryKey: ['docs-pages', projectId] });
    qc.invalidateQueries({ queryKey: ['docs-page', projectId] });
  }, [qc]));

  const queries = useQueries({
    queries: projects.map((p) => ({
      queryKey: ['docs-pages', p.id],
      queryFn: () => docsPagesApi.list(p.id),
      staleTime: 30_000,
    })),
  });

  const dataKey = queries.map((q) => q.dataUpdatedAt).join(',') + projects.map((p) => p.id + p.name).join(',');
  const pages = useMemo<ProjectPages[]>(() => projects.flatMap((p, i) => {
    const list = queries[i]?.data;
    return list?.dir ? [{ projectId: p.id, name: p.name, list }] : [];
  }), [dataKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { pages, isLoading: queries.some((q) => q.isLoading) };
}

/** Whether a combined docs key names a page that is in its project's docs folder. */
export function isKnownPageKey(pages: ProjectPages[], key: string): boolean {
  const parsed = parseNodeKey(key);
  const path = parsed && pagePathOf(parsed.uid);
  if (!parsed || !path) return false;
  return pages.some((p) => p.projectId === parsed.projectId && p.list.pages.some((page) => page.path === path));
}

/** One project's pages under a collapsible project row; folders remembered per project. */
function ProjectPagesTree({ entry, selectedKey, onSelect, filterQ, collapseSignal }: {
  entry: ProjectPages;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  filterQ: string;
  collapseSignal: number;
}) {
  const [expanded, toggle, collapse, expandMany] = useExpandedSet(`combined-docs-expanded-pages-${entry.projectId}`);
  const parsed = selectedKey ? parseNodeKey(selectedKey) : null;
  const selectedNode = parsed?.projectId === entry.projectId ? parsed.uid : null;
  const selectedPath = pagePathOf(selectedNode);

  useEffect(() => { if (collapseSignal > 0) collapse(); }, [collapseSignal, collapse]);
  useEffect(() => {
    if (!selectedPath) return;
    toggle(ROOT_CLOSED, false); // reveal the selection
    expandMany(foldersOf(selectedPath));
  }, [selectedPath, toggle, expandMany]);

  if (filterQ && filterPages(entry.list.pages, filterQ).length === 0) return null;
  const open = filterQ.length > 0 || !expanded.has(ROOT_CLOSED);

  return (
    <div>
      <button
        onClick={() => toggle(ROOT_CLOSED, open)}
        className="w-full flex items-center gap-1.5 py-1 pl-2 pr-3 text-left text-xs text-gray-300 hover:text-gray-100 transition-colors"
      >
        <span className="shrink-0 text-gray-600">{open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}</span>
        <Package className="w-3.5 h-3.5 shrink-0 text-brand-500" />
        <span className="font-semibold truncate">{entry.name}</span>
        <span className="ml-auto text-[10px] text-gray-600">{entry.list.pages.length}</span>
      </button>
      {open && (
        <div className="pl-3">
          <PagesTree
            pages={entry.list.pages}
            selectedNode={selectedNode}
            onSelect={(node) => onSelect(nodeKey(entry.projectId, node))}
            filterQ={filterQ}
            expanded={expanded}
            onToggle={toggle}
          />
        </div>
      )}
    </div>
  );
}

/** The Pages tab's tree: each selected project with a docs folder. */
export function CombinedPagesTree({ pages, isLoading, selectedKey, onSelect, filterQ, collapseSignal }: {
  pages: ProjectPages[];
  isLoading: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  filterQ: string;
  collapseSignal: number;
}) {
  if (isLoading && pages.length === 0) return <div className="px-3 py-2 text-xs text-gray-600">Loading…</div>;
  if (pages.length === 0) {
    return <p className="px-3 py-4 text-xs text-gray-600">None of the selected projects have a docs folder.</p>;
  }
  const anyMatch = !filterQ || pages.some((p) => filterPages(p.list.pages, filterQ).length > 0);
  return (
    <>
      {pages.map((entry) => (
        <ProjectPagesTree
          key={entry.projectId}
          entry={entry}
          selectedKey={selectedKey}
          onSelect={onSelect}
          filterQ={filterQ}
          collapseSignal={collapseSignal}
        />
      ))}
      {!anyMatch && <p className="px-3 py-4 text-xs text-gray-600 italic">No pages match.</p>}
    </>
  );
}

/** A selected page, with its links resolved inside the combined docs. */
export function CombinedPageDetail({ pages, loaded, projectId, path, onShowAll }: {
  pages: ProjectPages[];
  loaded: ProjectDocs[];
  projectId: number;
  path: string;
  onShowAll: () => void;
}) {
  const entry = pages.find((p) => p.projectId === projectId);
  const docs = loaded.find((p) => p.projectId === projectId);
  const scope = useMemo<DocsScope>(() => ({
    nodeParam: (uid) => resolveNodeKey(loaded, projectId, uid),
    canEdit: false,
  }), [loaded, projectId]);
  const nodes = useMemo(() => docs?.nodes ?? new Map<string, DocsNodeDto>(), [docs]);

  if (!entry) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 h-full text-sm text-gray-600 select-none">
        <p>This page&rsquo;s project isn&rsquo;t in your combined docs.</p>
        <button onClick={onShowAll} className="text-xs text-brand-400 hover:text-brand-300">Back to all projects</button>
      </div>
    );
  }

  return (
    <DocsScopeProvider value={scope}>
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-8 py-2 border-b border-gray-800 text-xs text-gray-500 shrink-0">
          <button onClick={onShowAll} className="hover:text-gray-300 transition-colors">All projects</button>
          <span className="text-gray-700">/</span>
          <span className="font-mono text-gray-300">{entry.name}</span>
          <Link
            to={`/projects/${projectId}/docs?browse=pages&node=${encodeURIComponent(`page:${path}`)}`}
            className="flex items-center gap-1 ml-auto text-gray-500 hover:text-gray-300 transition-colors"
          >
            Open in project <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          <PageDetail key={`${projectId}:${path}`} projectId={projectId} path={path} list={entry.list} nodes={nodes} />
        </div>
      </div>
    </DocsScopeProvider>
  );
}
