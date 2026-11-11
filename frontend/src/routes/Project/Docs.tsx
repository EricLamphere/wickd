import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, BookOpen, Search,
  Database,
  LayoutGrid, ChevronsDownUp, Tag as TagIcon, FileText,
} from 'lucide-react';
import { api, type DocsNodeDto, type DocsMacroDto } from '../../lib/api';
import { useProjectEvents } from '../../lib/sse';
import { useUrlTab } from '../../lib/useUrlTab';
import { macroCallName } from './lib/macroCall';
import { pagePathOf, readSessionValue, restorableDocsView } from './lib/docsLastView';
import NavRail from './components/NavRail';
import { TagBrowseList } from './components/propagation/TagBrowseList';
import { TagFlowPanel } from './components/propagation/TagFlowPanel';
import { buildDatabaseTree, buildGroupTree, buildProjectSections, findPathToUid } from './DocsBrowser/docsTree';
import { useExpandedSet } from './DocsBrowser/useExpandedSet';
import { useListWidth } from './DocsBrowser/useListWidth';
import { useSelectDocsNode } from './DocsBrowser/docsScope';
import { FlatTree, ProjectRootTree } from './DocsBrowser/DocsTrees';
import { ProjectOverview } from './DocsBrowser/ProjectOverview';
import { NodeDetail } from './DocsBrowser/NodeDetail';
import { MacroDetail } from './DocsBrowser/MacroDetail';
import { PagesTree } from './DocsBrowser/pages/PagesTree';
import { PageDetail } from './DocsBrowser/pages/PageDetail';
import { foldersOf } from './DocsBrowser/pages/pageFolders';
import { useDocsPagesList } from './DocsBrowser/pages/useDocsPages';

// ---- tab type ----

type DocsTab = 'project' | 'database' | 'group' | 'tags' | 'pages';

const DOCS_TAB_IDS: readonly DocsTab[] = ['project', 'database', 'group', 'tags', 'pages'];
const DOCS_TAB_IDS_NO_PAGES: readonly DocsTab[] = ['project', 'database', 'group', 'tags'];
/** List width at which four labeled tabs fit. */
const TAB_LABELS_MIN_WIDTH = 290;


// ---- Docs page ----

export default function DocsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = Number(projectId);
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();

  const { listWidth, startResize } = useListWidth();
  const [generating, setGenerating] = useState(false);
  const [filter, setFilter] = useState('');
  // Markdown pages (plan 28): the Pages tab exists only when the project has a docs folder
  const { data: pagesList } = useDocsPagesList(id);
  const hasPagesTab = pagesList === undefined || pagesList.dir !== null; // kept while loading so ?browse=pages doesn't flicker
  const [docsTab, setDocsTab] = useUrlTab<DocsTab>('browse', hasPagesTab ? DOCS_TAB_IDS : DOCS_TAB_IDS_NO_PAGES, 'project', null); // Docs restores its last view itself (docsLastView.ts)
  const selectNode = useSelectDocsNode();
  const autoGenerateTriggered = useRef(false);

  const [projectExpanded, setProjectExpanded, collapseProject, expandProjectMany] = useExpandedSet(`docs-expanded-project-${id}`);
  const [databaseExpanded, setDatabaseExpanded, collapseDatabase, expandDatabaseMany] = useExpandedSet(`docs-expanded-database-${id}`);
  const [groupExpanded, setGroupExpanded, collapseGroup, expandGroupMany] = useExpandedSet(`docs-expanded-group-${id}`);
  const [pagesExpanded, setPagesExpanded, collapsePages, expandPagesMany] = useExpandedSet(`docs-expanded-pages-${id}`);

  const collapseAll = { project: collapseProject, database: collapseDatabase, group: collapseGroup, pages: collapsePages, tags: () => {} }[docsTab];

  const selectedUid = searchParams.get('node') ?? null;
  const selectedPage = pagePathOf(selectedUid);

  const { data: status, isFetching: statusFetching } = useQuery({
    queryKey: ['docs-status', id],
    queryFn: () => api.docs.status(id),
    refetchInterval: false,
  });

  const { data: docsData, isLoading: docsLoading } = useQuery({
    queryKey: ['docs-data', id],
    queryFn: () => api.docs.data(id),
    enabled: !!status?.generated_at,
    refetchInterval: false,
  });

  const hasDoc = !!status?.generated_at;
  const projectName = docsData?.project_name ?? '';

  useProjectEvents(id, useCallback((event) => {
    if (event.type === 'docs_generating') setGenerating(true);
    if (event.type === 'docs_generated') {
      setGenerating(false);
      qc.invalidateQueries({ queryKey: ['docs-status', id] });
      qc.invalidateQueries({ queryKey: ['docs-data', id] });
    }
  }, [id, qc]));

  useEffect(() => {
    if (autoGenerateTriggered.current) return;
    if (!status || statusFetching) return;
    if (!status.generated_at) {
      autoGenerateTriggered.current = true;
      setGenerating(true);
      api.docs.generate(id).catch(() => setGenerating(false));
    }
  }, [status, statusFetching, id]);

  const handleRefresh = async () => {
    setGenerating(true);
    try { await api.docs.generate(id); } catch { setGenerating(false); }
  };

  // Build trees for all three tab views
  const { projectSections, databaseTree, groupTree, nodeMap, macroMap } = useMemo(() => {
    const nodes = docsData?.nodes ?? [];
    const macros = docsData?.macros ?? [];

    const nMap = new Map<string, DocsNodeDto>(nodes.map((n) => [n.unique_id, n]));
    const mMap = new Map<string, DocsMacroDto>(macros.map((m) => [m.unique_id, m]));

    return {
      projectSections: buildProjectSections(nodes, macros, projectName),
      databaseTree: buildDatabaseTree(nodes),
      groupTree: buildGroupTree(nodes),
      nodeMap: nMap,
      macroMap: mMap,
    };
  }, [docsData, projectName]);

  // Remember where you were (node + browse/detail tabs) so the nav link back to Docs returns there
  const lastViewKey = `docs-last-view-${id}`;
  useEffect(() => {
    if (!selectedUid) return;
    try { sessionStorage.setItem(lastViewKey, searchParams.toString()); } catch { /* storage unavailable */ }
  }, [lastViewKey, selectedUid, searchParams]);

  // Arriving without ?node=: restore the last view if its node still exists, else the project overview
  const pagePaths = useMemo(() => new Set((pagesList?.pages ?? []).map((p) => p.path)), [pagesList]);
  const viewReady = (!!docsData || (!!status && !status.generated_at)) && pagesList !== undefined; // pages work without generated docs
  useEffect(() => {
    if (!viewReady || selectedUid) return;
    const exists = (uid: string) => {
      const page = pagePathOf(uid);
      return page !== null ? pagePaths.has(page) : nodeMap.has(uid) || macroMap.has(uid);
    };
    const restored = restorableDocsView(readSessionValue(lastViewKey), exists);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (restored) restored.forEach((value, key) => { if (!next.has(key)) next.set(key, value); });
      else next.set('node', '__project__');
      return next;
    }, { replace: true });
  }, [viewReady, selectedUid, lastViewKey, nodeMap, macroMap, pagePaths, setSearchParams]);

  // A selected page: open its folders in the Pages tree
  useEffect(() => {
    if (selectedPage) expandPagesMany(foldersOf(selectedPage));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPage]);

  // When a node is selected (e.g. via ReferencedBy link), expand the tree to reveal it
  useEffect(() => {
    if (!selectedUid || selectedUid === '__project__' || !docsData) return;
    // Project tab: sections like "type:model/folder/..."
    for (const section of projectSections) {
      const paths = findPathToUid(section.tree, selectedUid, section.id);
      if (paths) {
        expandProjectMany(paths);
        break;
      }
    }
    // Database tab
    const dbPaths = findPathToUid(databaseTree, selectedUid, '');
    if (dbPaths) expandDatabaseMany(dbPaths.filter(Boolean));
    // Group tab
    const grpPaths = findPathToUid(groupTree, selectedUid, '');
    if (grpPaths) expandGroupMany(grpPaths.filter(Boolean));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUid, docsData]);

  // Clear filter when switching tabs
  useEffect(() => { setFilter(''); }, [docsTab]);

  const isProjectOverview = selectedUid === '__project__';
  const selectedNode = selectedUid && !isProjectOverview ? nodeMap.get(selectedUid) ?? null : null;
  const selectedMacro = selectedUid && !isProjectOverview ? macroMap.get(selectedUid) ?? null : null;
  const q = filter.toLowerCase().trim();

  const TABS: { id: DocsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'project',  label: 'Project',  icon: <BookOpen className="w-3.5 h-3.5" /> },
    { id: 'database', label: 'Database', icon: <Database className="w-3.5 h-3.5" /> },
    { id: 'group',    label: 'Group',    icon: <LayoutGrid className="w-3.5 h-3.5" /> },
    { id: 'tags',     label: 'Tags',     icon: <TagIcon className="w-3.5 h-3.5" /> },
    ...(hasPagesTab ? [{ id: 'pages' as const, label: 'Pages', icon: <FileText className="w-3.5 h-3.5" /> }] : []),
  ];
  const nodeTab = docsTab !== 'tags' && docsTab !== 'pages';
  // Five labeled tabs don't fit a narrow panel: then only the active tab keeps its label, and
  // the others show theirs while hovered (the active tab is flex-1 + min-w-0, so it gives way)
  const showTabLabel = (tab: DocsTab) => docsTab === tab || listWidth >= TAB_LABELS_MIN_WIDTH * (TABS.length / 4);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Nav rail */}
      <NavRail projectId={id} current="docs" />

      {/* Folder tree panel */}
      <div style={{ width: listWidth }} className="shrink-0 bg-surface-app border-r border-gray-800 flex flex-col overflow-hidden relative">
        {/* Header */}
        <div className="px-3 py-2 border-b border-gray-800 shrink-0 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs text-gray-400 font-medium">
              <BookOpen className="w-3.5 h-3.5" /> Documentation
            </span>
            <button onClick={handleRefresh} disabled={generating} title="Regenerate docs" className="p-1 rounded text-gray-500 hover:text-gray-300 disabled:opacity-50 transition-colors">
              <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Project / Database / Group tabs */}
          <div className="flex items-center gap-0.5">
            {TABS.map((t) => {
              const labeled = showTabLabel(t.id);
              return (
                <button
                  key={t.id}
                  onClick={() => setDocsTab(t.id)}
                  aria-label={t.label}
                  className={`group flex items-center px-1.5 py-1 text-[11px] rounded transition-colors justify-center
                    ${labeled ? 'flex-1 min-w-0' : 'shrink-0'}
                    ${docsTab === t.id
                      ? 'bg-brand-900/50 text-brand-300'
                      : 'text-gray-500 hover:text-gray-300 hover:bg-surface-elevated/40'
                    }`}
                >
                  <span className="shrink-0">{t.icon}</span>
                  {/* Collapsed tabs slide their label open on hover / keyboard focus, and close again on leave */}
                  <span
                    className={`overflow-hidden whitespace-nowrap transition-all duration-150 ease-out
                      ${labeled
                        ? 'ml-1 truncate'
                        : 'max-w-0 opacity-0 group-hover:ml-1 group-hover:max-w-[6rem] group-hover:opacity-100 group-focus-visible:ml-1 group-focus-visible:max-w-[6rem] group-focus-visible:opacity-100'}`}
                  >
                    {t.label}
                  </span>
                </button>
              );
            })}
          </div>

          <div className={`flex items-center gap-1 ${docsTab === 'tags' ? 'hidden' : ''}`}>
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600 pointer-events-none" />
              <input type="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)}
                className="w-full bg-surface-elevated border border-gray-700 rounded pl-6 pr-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500" />
            </div>
            <button
              onClick={collapseAll}
              title="Collapse all folders"
              className="shrink-0 p-1 text-gray-600 hover:text-gray-300 transition-colors"
            >
              <ChevronsDownUp className="w-3.5 h-3.5" />
            </button>
          </div>
          {status?.generated_at && (
            <p className="text-[10px] text-gray-700 truncate">{new Date(status.generated_at).toLocaleString()}</p>
          )}
        </div>

        {/* Tree */}
        <div className="overflow-auto flex-1 py-1 select-none">
          {docsTab === 'tags' && <TagBrowseList projectId={id} />}
          {docsTab === 'pages' && pagesList?.dir && (
            <PagesTree
              pages={pagesList.pages}
              selectedNode={selectedUid}
              onSelect={selectNode}
              filterQ={q}
              expanded={pagesExpanded}
              onToggle={setPagesExpanded}
            />
          )}
          {nodeTab && generating && !hasDoc && (
            <div className="flex flex-col items-center justify-center h-32 gap-2 text-gray-600">
              <RefreshCw className="w-5 h-5 animate-spin text-brand-400" />
              <span className="text-xs">Generating…</span>
            </div>
          )}
          {nodeTab && !generating && !hasDoc && (
            <div className="flex flex-col items-center justify-center h-32 gap-2 text-gray-600 px-4 text-center">
              <BookOpen className="w-6 h-6" />
              <p className="text-xs">No docs yet.</p>
              <button onClick={handleRefresh} className="px-3 py-1 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white transition-colors">Generate</button>
            </div>
          )}
          {nodeTab && !generating && hasDoc && docsLoading && (
            <div className="flex items-center justify-center h-16 text-xs text-gray-600">Loading…</div>
          )}
          {!generating && hasDoc && !docsLoading && (
            <>
              {docsTab === 'project' && (
                <ProjectRootTree
                  projectName={projectName}
                  sections={projectSections}
                  selectedUid={selectedUid}
                  onSelect={selectNode}
                  filterQ={q}
                  expanded={projectExpanded}
                  onToggle={setProjectExpanded}
                />
              )}
              {docsTab === 'database' && (
                <FlatTree
                  tree={databaseTree}
                  selectedUid={selectedUid}
                  onSelect={selectNode}
                  filterQ={q}
                  emptyLabel="No database objects found."
                  expanded={databaseExpanded}
                  onToggle={setDatabaseExpanded}
                />
              )}
              {docsTab === 'group' && (
                <FlatTree
                  tree={groupTree}
                  selectedUid={selectedUid}
                  onSelect={selectNode}
                  filterQ={q}
                  emptyLabel="No grouped nodes found."
                  expanded={groupExpanded}
                  onToggle={setGroupExpanded}
                />
              )}
            </>
          )}
        </div>

        <div onMouseDown={startResize} className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/40 transition-colors" />
      </div>

      {/* Detail panel */}
      <div className="flex-1 overflow-auto bg-surface-app">
        {docsTab === 'tags' && <TagFlowPanel projectId={id} />}
        {docsTab !== 'tags' && isProjectOverview && (
          <ProjectOverview
            projectId={id}
            projectName={projectName}
            description={docsData?.project_description ?? ''}
          />
        )}
        {docsTab !== 'tags' && selectedNode && <NodeDetail node={selectedNode} allNodes={nodeMap} allMacros={macroMap} projectId={id} />}
        {docsTab !== 'tags' && selectedMacro && <MacroDetail
            key={selectedMacro.unique_id}
            macro={selectedMacro}
            projectId={id}
            callName={macroCallName(selectedMacro.name, selectedMacro.package_name, projectName, docsData?.adapter_type ?? '')}
          />}
        {docsTab !== 'tags' && selectedPage && pagesList?.dir && (
          <PageDetail key={selectedPage} projectId={id} path={selectedPage} list={pagesList} nodes={nodeMap} />
        )}
        {docsTab !== 'tags' && !isProjectOverview && !selectedNode && !selectedMacro && !selectedPage && (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm select-none">
            Select a node to view documentation
          </div>
        )}
      </div>
    </div>
  );
}
