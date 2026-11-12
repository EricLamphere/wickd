import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { BookOpen, ChevronsDownUp, Database, ExternalLink, FileText, LayoutGrid, Loader2, RefreshCw, Search } from 'lucide-react';
import { api, type DocsDataDto } from '../../lib/api';
import { isDocsRunActive } from '../../lib/workspaceApi';
import { useUrlTab } from '../../lib/useUrlTab';
import { FilterDropdown } from '../Project/components/FilterDropdown';
import { DocsScopeProvider, type DocsScope } from '../Project/DocsBrowser/docsScope';
import { FlatTree, ProjectRootTree } from '../Project/DocsBrowser/DocsTrees';
import { collectMatching, findPathToUid } from '../Project/DocsBrowser/docsTree';
import { MacroDetail } from '../Project/DocsBrowser/MacroDetail';
import { NodeDetail } from '../Project/DocsBrowser/NodeDetail';
import { ProjectOverview } from '../Project/DocsBrowser/ProjectOverview';
import { useExpandedSet } from '../Project/DocsBrowser/useExpandedSet';
import { useListWidth } from '../Project/DocsBrowser/useListWidth';
import { pagePathOf, readSessionValue, restorableDocsView } from '../Project/lib/docsLastView';
import { macroCallName } from '../Project/lib/macroCall';
import {
  buildCombinedTrees, buildProjectDocs, lookupMaps, nodeKey, parseNodeKey, PROJECT_OVERVIEW, resolveNodeKey,
  type ProjectDocs,
} from './docsJoin';
import { CombinedDocsOverview, NoProjectsSelected } from './CombinedDocsOverview';
import { CombinedPageDetail, CombinedPagesTree, isKnownPageKey, useCombinedPages } from './CombinedPages';
import { useWorkspaceDocs } from './useWorkspaceDocs';

const BROWSE_TABS = ['project', 'database', 'group', 'pages'] as const;
const BROWSE_TABS_NO_PAGES = ['project', 'database', 'group'] as const;
type BrowseTab = (typeof BROWSE_TABS)[number];

const BROWSE: { id: BrowseTab; label: string; icon: React.ReactNode }[] = [
  { id: 'project', label: 'Project', icon: <BookOpen className="w-3.5 h-3.5" /> },
  { id: 'database', label: 'Database', icon: <Database className="w-3.5 h-3.5" /> },
  { id: 'group', label: 'Group', icon: <LayoutGrid className="w-3.5 h-3.5" /> },
  { id: 'pages', label: 'Pages', icon: <FileText className="w-3.5 h-3.5" /> },
];

const LAST_VIEW_KEY = 'combined-docs-last-view';

/** One project's tree in the Project view; each remembers its own expanded folders. */
function ProjectTree({ docs, selectedKey, onSelect, filterQ, collapseSignal }: {
  docs: ProjectDocs;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  filterQ: string;
  collapseSignal: number;
}) {
  const [expanded, toggle, collapse, expandMany] = useExpandedSet(`combined-docs-expanded-${docs.projectId}`);
  const overviewKey = nodeKey(docs.projectId, PROJECT_OVERVIEW);

  useEffect(() => { if (collapseSignal > 0) collapse(); }, [collapseSignal, collapse]);

  useEffect(() => {
    if (!selectedKey) return;
    for (const section of docs.sections) {
      const paths = findPathToUid(section.tree, selectedKey, section.id);
      if (paths) {
        expandMany(paths);
        return;
      }
    }
  }, [selectedKey, docs.sections, expandMany]);

  if (filterQ && !docs.sections.some((s) => collectMatching(s.tree, filterQ).size > 0)) return null;

  return (
    <ProjectRootTree
      projectName={docs.name}
      sections={docs.sections}
      selectedUid={selectedKey === overviewKey ? PROJECT_OVERVIEW : selectedKey}
      onSelect={(uid) => onSelect(uid === PROJECT_OVERVIEW ? overviewKey : uid)}
      filterQ={filterQ}
      expanded={expanded}
      onToggle={toggle}
    />
  );
}

/** The selected node or project page, wired to its own project's lookups. */
function CombinedDetail({ projects, selectedKey, onShowAll }: {
  projects: ProjectDocs[];
  selectedKey: string;
  onShowAll: () => void;
}) {
  const parsed = parseNodeKey(selectedKey);
  const docs = parsed ? projects.find((p) => p.projectId === parsed.projectId) : undefined;
  const scope = useMemo<DocsScope | null>(() => (docs
    ? { nodeParam: (uid) => resolveNodeKey(projects, docs.projectId, uid), canEdit: false }
    : null), [projects, docs]);
  const lookups = useMemo(() => (docs ? lookupMaps(projects, docs.projectId) : null), [projects, docs]);

  if (!parsed || !docs || !scope || !lookups) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 h-full text-sm text-gray-600 select-none">
        <p>This node&rsquo;s project isn&rsquo;t in your combined docs.</p>
        <button onClick={onShowAll} className="text-xs text-brand-400 hover:text-brand-300">Back to all projects</button>
      </div>
    );
  }

  const node = docs.nodes.get(parsed.uid);
  const macro = docs.macros.get(parsed.uid);
  const isOverview = parsed.uid === PROJECT_OVERVIEW;

  return (
    <DocsScopeProvider value={scope}>
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-8 py-2 border-b border-gray-800 text-xs text-gray-500 shrink-0">
          <button onClick={onShowAll} className="hover:text-gray-300 transition-colors">All projects</button>
          <span className="text-gray-700">/</span>
          <span className="font-mono text-gray-300">{docs.name}</span>
          <Link
            to={`/projects/${docs.projectId}`}
            className="flex items-center gap-1 ml-auto text-gray-500 hover:text-gray-300 transition-colors"
          >
            Open project <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {isOverview && (
            <ProjectOverview
              projectId={docs.projectId}
              projectName={docs.name}
              description={docs.data.project_description}
            />
          )}
          {node && <NodeDetail node={node} allNodes={lookups.nodes} allMacros={lookups.macros} projectId={docs.projectId} />}
          {macro && (
            <MacroDetail
              key={selectedKey}
              macro={macro}
              projectId={docs.projectId}
              callName={macroCallName(macro.name, macro.package_name, docs.data.project_name, docs.data.adapter_type)}
            />
          )}
          {!isOverview && !node && !macro && (
            <div className="flex items-center justify-center h-full text-sm text-gray-600 select-none">
              This node isn&rsquo;t in {docs.name}&rsquo;s generated docs.
            </div>
          )}
        </div>
      </div>
    </DocsScopeProvider>
  );
}

/** Home → Docs: the selected projects' docs in one browser. */
export function CombinedDocs() {
  const { projects, selection, isLoading, error, setSelection, generate } = useWorkspaceDocs();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [collapseSignal, setCollapseSignal] = useState(0);
  const { listWidth, startResize } = useListWidth();
  const [databaseExpanded, toggleDatabase, collapseDatabase, expandDatabase] = useExpandedSet('combined-docs-expanded-database');
  const [groupExpanded, toggleGroup, collapseGroup, expandGroup] = useExpandedSet('combined-docs-expanded-group');

  const selectedProjects = useMemo(
    () => selection.flatMap((id) => projects.filter((p) => p.id === id)),
    [selection, projects],
  );

  // Markdown pages: the Pages tab exists when a selected project has a docs folder (kept while loading)
  const { pages, isLoading: pagesLoading } = useCombinedPages(selectedProjects);
  const hasPagesTab = pagesLoading || pages.length > 0;
  const [browse, setBrowse] = useUrlTab<BrowseTab>('browse', hasPagesTab ? BROWSE_TABS : BROWSE_TABS_NO_PAGES, 'project');

  const queries = useQueries({
    queries: selectedProjects.map((p) => ({
      queryKey: ['docs-data', p.id],
      queryFn: () => api.docs.data(p.id),
      enabled: !!p.generated_at,
      refetchInterval: false as const,
    })),
  });

  // Each project's trees are only rebuilt when its own data changes
  const built = useRef(new WeakMap<DocsDataDto, ProjectDocs>());
  const loadedKey = queries.map((q) => q.dataUpdatedAt).join(',') + selectedProjects.map((p) => p.id + p.name).join(',');
  const loaded = useMemo(() => selectedProjects.flatMap((p, i) => {
    const data = queries[i]?.data;
    if (!data) return [];
    const cached = built.current.get(data);
    if (cached && cached.projectId === p.id && cached.name === p.name) return [cached];
    const docs = buildProjectDocs(p.id, p.name, data);
    built.current.set(data, docs);
    return [docs];
  }), [loadedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const { databaseTree, groupTree } = useMemo(() => buildCombinedTrees(loaded), [loaded]);
  const stillLoading = queries.some((q) => q.isLoading);
  const q = filter.toLowerCase().trim();

  const selectedKey = searchParams.get('node');
  const selectedPage = useMemo(() => {
    const parsed = selectedKey ? parseNodeKey(selectedKey) : null;
    const path = parsed ? pagePathOf(parsed.uid) : null;
    return parsed && path ? { projectId: parsed.projectId, path } : null;
  }, [selectedKey]);

  const selectNode = useCallback((key: string) => {
    if (searchParams.get('node') === key) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('node', key);
      next.delete('view');
      return next;
    });
  }, [searchParams, setSearchParams]);

  const showAll = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('node');
      next.delete('view');
      return next;
    });
  }, [setSearchParams]);

  // Remember the open node for this session, and reopen it on arriving without one
  useEffect(() => {
    if (!selectedKey) return;
    try { sessionStorage.setItem(LAST_VIEW_KEY, searchParams.toString()); } catch { /* storage unavailable */ }
  }, [selectedKey, searchParams]);

  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || stillLoading || loaded.length === 0) return;
    restored.current = true;
    if (selectedKey) return;
    const view = restorableDocsView(readSessionValue(LAST_VIEW_KEY), (key) => {
      const parsed = parseNodeKey(key);
      const docs = parsed && loaded.find((p) => p.projectId === parsed.projectId);
      if (isKnownPageKey(pages, key)) return true;
      return !!parsed && !!docs && (parsed.uid === PROJECT_OVERVIEW || docs.nodes.has(parsed.uid) || docs.macros.has(parsed.uid));
    });
    if (!view) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      view.forEach((value, key) => { if (key !== 'browse') next.set(key, value); });
      return next;
    }, { replace: true });
  }, [stillLoading, loaded, pages, selectedKey, setSearchParams]);

  // Reveal the selection in the merged views
  useEffect(() => {
    if (!selectedKey) return;
    const db = findPathToUid(databaseTree, selectedKey, '');
    if (db) expandDatabase(db.filter(Boolean));
    const group = findPathToUid(groupTree, selectedKey, '');
    if (group) expandGroup(group.filter(Boolean));
  }, [selectedKey, databaseTree, groupTree, expandDatabase, expandGroup]);

  useEffect(() => { setFilter(''); }, [browse]);

  const collapseAll = () => {
    if (browse === 'project' || browse === 'pages') setCollapseSignal((n) => n + 1);
    else if (browse === 'database') collapseDatabase();
    else collapseGroup();
  };

  const missing = selectedProjects.filter((p) => !p.generated_at && !isDocsRunActive(p.state));
  const busy = selectedProjects.some((p) => isDocsRunActive(p.state));

  if (isLoading) {
    return <div className="flex flex-1 items-center justify-center text-xs text-gray-600">Loading…</div>;
  }
  if (error) {
    return <p className="p-6 text-sm text-red-400">Couldn&rsquo;t load combined docs: {String(error)}</p>;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Selection + generation */}
      <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-800 shrink-0">
        <FilterDropdown
          label="Projects"
          options={projects.map((p) => String(p.id))}
          selected={new Set(selection.map(String))}
          onChange={(next) => setSelection(projects.filter((p) => next.has(String(p.id))).map((p) => p.id))}
          optionLabel={(id) => projects.find((p) => String(p.id) === id)?.name ?? id}
        />
        <span className="text-xs text-gray-500">
          {selectedProjects.length} of {projects.length} {projects.length === 1 ? 'project' : 'projects'} combined
        </span>
        <div className="flex items-center gap-2 ml-auto">
          {busy && (
            <span className="flex items-center gap-1.5 text-xs text-gray-500">
              <Loader2 className="w-3 h-3 animate-spin" /> Generating…
            </span>
          )}
          {missing.length > 0 && (
            <button
              onClick={() => generate(missing.map((p) => p.id))}
              className="px-2.5 py-1 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white transition-colors"
            >
              Generate {missing.length} missing
            </button>
          )}
          {selectedProjects.length > 0 && (
            <button
              onClick={() => generate(selectedProjects.map((p) => p.id))}
              disabled={busy}
              title="Runs each selected project's init pipeline, then compiles it against its warehouse, one at a time, with the profile picked in the header"
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-gray-700 bg-surface-elevated hover:bg-gray-700 text-gray-300 transition-colors disabled:opacity-50"
            >
              <RefreshCw className="w-3 h-3" /> Regenerate all
            </button>
          )}
        </div>
      </div>

      {selectedProjects.length === 0 ? (
        <NoProjectsSelected projects={projects} onSelectAll={() => setSelection(projects.map((p) => p.id))} />
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* Tree */}
          <div style={{ width: listWidth }} className="relative flex flex-col shrink-0 overflow-hidden border-r border-gray-800 bg-surface-app">
            <div className="flex flex-col gap-2 px-3 py-2 border-b border-gray-800 shrink-0">
              <div className="flex items-center gap-0.5">
                {BROWSE.filter((t) => t.id !== 'pages' || hasPagesTab).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setBrowse(t.id)}
                    className={`flex flex-1 items-center justify-center gap-1 px-1.5 py-1 text-[11px] rounded transition-colors ${
                      browse === t.id ? 'bg-brand-900/50 text-brand-300' : 'text-gray-500 hover:text-gray-300 hover:bg-surface-elevated/40'
                    }`}
                  >
                    {t.icon}
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <div className="relative flex-1">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600 pointer-events-none" />
                  <input
                    type="search"
                    placeholder="Filter all projects…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="w-full pl-6 pr-2 py-1 text-xs bg-surface-elevated border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </div>
                <button onClick={collapseAll} title="Collapse all folders" className="shrink-0 p-1 text-gray-600 hover:text-gray-300 transition-colors">
                  <ChevronsDownUp className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="flex-1 py-1 overflow-auto select-none">
              {browse === 'pages' && (
                <CombinedPagesTree
                  pages={pages}
                  isLoading={pagesLoading}
                  selectedKey={selectedKey}
                  onSelect={selectNode}
                  filterQ={q}
                  collapseSignal={collapseSignal}
                />
              )}
              {browse !== 'pages' && stillLoading && <div className="px-3 py-2 text-xs text-gray-600">Loading…</div>}
              {browse !== 'pages' && !stillLoading && loaded.length === 0 && (
                <p className="px-3 py-4 text-xs text-gray-600">None of the selected projects have docs yet.</p>
              )}
              {browse === 'project' && loaded.map((docs) => (
                <ProjectTree
                  key={docs.projectId}
                  docs={docs}
                  selectedKey={selectedKey}
                  onSelect={selectNode}
                  filterQ={q}
                  collapseSignal={collapseSignal}
                />
              ))}
              {browse === 'database' && loaded.length > 0 && (
                <FlatTree
                  tree={databaseTree}
                  selectedUid={selectedKey}
                  onSelect={selectNode}
                  filterQ={q}
                  emptyLabel="No database objects found."
                  expanded={databaseExpanded}
                  onToggle={toggleDatabase}
                />
              )}
              {browse === 'group' && loaded.length > 0 && (
                <FlatTree
                  tree={groupTree}
                  selectedUid={selectedKey}
                  onSelect={selectNode}
                  filterQ={q}
                  emptyLabel="No grouped nodes found."
                  expanded={groupExpanded}
                  onToggle={toggleGroup}
                />
              )}
            </div>
            <div onMouseDown={startResize} className="absolute top-0 bottom-0 right-0 w-1 cursor-col-resize hover:bg-brand-500/40 transition-colors" />
          </div>

          {/* Detail */}
          <div className="flex-1 min-w-0 overflow-auto bg-surface-app">
            {selectedPage ? (
              <CombinedPageDetail
                pages={pages}
                loaded={loaded}
                projectId={selectedPage.projectId}
                path={selectedPage.path}
                onShowAll={showAll}
              />
            ) : selectedKey ? (
              <CombinedDetail projects={loaded} selectedKey={selectedKey} onShowAll={showAll} />
            ) : (
              <CombinedDocsOverview
                projects={selectedProjects}
                loaded={loaded}
                failed={selectedProjects.filter((_, i) => queries[i]?.isError).map((p) => p.id)}
                onOpen={(id) => selectNode(nodeKey(id, PROJECT_OVERVIEW))}
                onGenerate={(id) => generate([id])}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
