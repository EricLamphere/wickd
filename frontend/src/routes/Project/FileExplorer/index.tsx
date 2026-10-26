import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type FileContentDto, type GraphDto, type ModelNode, type MovedPathDto } from '../../../lib/api';
import { useProjectEvents } from '../../../lib/sse';
import NavRail from '../components/NavRail';
import { SidePane, type FailedRowsCache } from '../components/SidePane';
import { FileTree } from './FileTree';
import { ViewPane } from './panes/ViewPane';
import { isAtOrUnder, remapPath } from './treeOps';
import { fileOpErrorMessage } from './useFileOps';
import { useReportSelectedNode } from '../lib/selectedNodeContext';
import { confirmDialog } from '../../../lib/dialogs';

/** File path a ?model= deep-link points at (unit tests aren't graph nodes — use their YAML file). */
function resolveDeepLinkPath(graph: GraphDto, uid: string | null): string | null {
  if (!uid) return null;
  return graph.nodes.find((n) => n.unique_id === uid)?.original_file_path
    || graph.unit_tests?.find((u) => u.unique_id === uid)?.original_file_path
    || null;
}

function readSessionPath(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

export default function FileExplorerPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = Number(projectId);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // ?path= is the open file (so opening files lands in back/forward history);
  // ?model= is the inbound deep-link (DAG/Docs/⌘K), resolved to a path on arrival
  const pathParam = searchParams.get('path');
  const modelParam = searchParams.get('model');

  const [openFile, setOpenFile] = useState<FileContentDto | null>(null);
  const [edited, setEdited] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  /** Why the last file couldn't be opened (binary, deleted), shown instead of the editor */
  const [openError, setOpenError] = useState<string | null>(null);
  /** Bumped when the page itself changes files (delete from the editor), so the tree re-reads */
  const [treeVersion, setTreeVersion] = useState(0);
  /** model node corresponding to the open file, if any */
  const [selectedModel, setSelectedModel] = useState<ModelNode | null>(null);
  /** unique_id of the model corresponding to the open file, for ViewPane compiled SQL */
  const [modelUid, setModelUid] = useState<string | null>(null);
  /** for YAML schema files: the test node currently active in the editor / SidePane */
  const [selectedTestNode, setSelectedTestNode] = useState<ModelNode | null>(null);
  /** test node to scroll the editor to on open (from deep-link) */
  const [targetTestNode, setTargetTestNode] = useState<ModelNode | null>(null);
  const PREVIEW_CACHE_KEY = `preview-cache-${id}`;
  const FAILED_ROWS_KEY = `failed-rows-cache-${id}`;

  /** dbt show results keyed by modelUid — persisted to sessionStorage so it survives route navigation */
  const [previewCache, setPreviewCache] = useState<Map<string, { columns: string[]; rows: unknown[][] }>>(() => {
    try {
      const raw = sessionStorage.getItem(`preview-cache-${id}`);
      return raw ? new Map(JSON.parse(raw) as [string, { columns: string[]; rows: unknown[][] }][]) : new Map();
    } catch {
      return new Map();
    }
  });

  /** failing test rows keyed by test uid — same session key as DAG page */
  const [failedRowsCache, setFailedRowsCache] = useState<FailedRowsCache>(() => {
    try {
      const raw = sessionStorage.getItem(`failed-rows-cache-${id}`);
      return raw ? new Map(JSON.parse(raw) as [string, { columns: string[]; rows: unknown[][] }][]) : new Map();
    } catch {
      return new Map();
    }
  });

  const [failedTestUid, setFailedTestUid] = useState<string | null>(null);

  /** `${path}\n${model}` last loaded from the URL — stops graph refetches reloading (and discarding edits) */
  const loadedKeyRef = useRef<string | null>(null);
  /** bumped per load so a slow earlier load can't overwrite a later one (fast back/forward) */
  const loadSeqRef = useRef(0);

  // Resizable panels
  const [treeWidth, setTreeWidth] = useState(256);
  const treeResizing = useRef(false);

  // Fetch graph so we can resolve model uid from file path
  const { data: graph } = useQuery({
    queryKey: ['models', id],
    queryFn: () => api.models.graph(id),
    refetchInterval: false,
  });

  const { data: project } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.projects.get(id),
  });

  useReportSelectedNode((selectedTestNode ?? selectedModel)?.unique_id ?? null);

  // When graph re-fetches (e.g. after statuses_changed), refresh stale node references
  // so selectedTestNode always has the current status (needed for SidePane tab bar condition)
  useEffect(() => {
    if (!graph) return;
    setSelectedTestNode((prev) => {
      if (!prev) return prev;
      return graph.nodes.find((n) => n.unique_id === prev.unique_id) ?? prev;
    });
    setSelectedModel((prev) => {
      if (!prev) return prev;
      return graph.nodes.find((n) => n.unique_id === prev.unique_id) ?? prev;
    });
  }, [graph]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (treeResizing.current) {
        setTreeWidth((w) => Math.max(150, Math.min(500, w + e.movementX)));
      }
    };
    const onMouseUp = () => {
      treeResizing.current = false;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const SESSION_KEY = `file-explorer-open-${id}`;
  useProjectEvents(id, useCallback((event) => {
    if (event.type === 'test_failed') {
      const d = event.data as { test_uid: string };
      setFailedTestUid(d.test_uid);
    }
  }, []));

  const loadFile = useCallback(async (path: string, testNode: ModelNode | null) => {
    const seq = ++loadSeqRef.current;
    setLoadingPath(path);
    setEdited(undefined);
    setSaveStatus('idle');
    setTargetTestNode(testNode);
    try {
      const file = await api.files.getContent(id, path);
      if (seq !== loadSeqRef.current) return;
      setOpenFile(file);
      setOpenError(null);
      // Resolve model for this file
      if (graph) {
        const node = graph.nodes.find((n) => n.original_file_path && path.endsWith(n.original_file_path));
        if (node) {
          setModelUid(node.unique_id);
          setSelectedModel(node);
        } else {
          setModelUid(null);
          setSelectedModel(null);
        }

        // For YAML files: auto-select a test node in the SidePane
        if (path.endsWith('.yml') || path.endsWith('.yaml')) {
          if (testNode) {
            // Specific test requested (e.g. from DAG deep-link)
            setSelectedTestNode(testNode);
          } else {
            // Auto-select first test defined in this file
            const firstTest = graph.nodes.find(
              (n) => n.resource_type === 'test' && n.original_file_path && path.endsWith(n.original_file_path)
            );
            setSelectedTestNode(firstTest ?? null);
          }
        } else {
          setSelectedTestNode(null);
        }
      }
    } catch (e) {
      // e.g. going back to a file that has since been deleted or renamed
      console.error(e);
      if (seq === loadSeqRef.current) {
        setOpenFile(null);
        const binary = e instanceof ApiError && e.body === 'binary file';
        setOpenError(binary
          ? `${path} is a binary file — it can't be opened here.`
          : `Couldn't open ${path}: ${fileOpErrorMessage(e)}`);
      }
    } finally {
      if (seq === loadSeqRef.current) setLoadingPath(null);
    }
  }, [id, graph]);

  /** Opens a file as a new history entry; the URL effect below does the actual load. */
  const openFileNode = useCallback((path: string) => {
    if (path === pathParam) return;
    setSearchParams({ path });
  }, [pathParam, setSearchParams]);

  /** Clears the open file (after delete/rename) without leaving a stale ?path= or session restore behind. */
  const closeFile = useCallback(() => {
    setOpenFile(null);
    setOpenError(null);
    setEdited(undefined);
    setModelUid(null);
    setSelectedModel(null);
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ }
    loadedKeyRef.current = null;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('path');
      next.delete('model');
      return next;
    }, { replace: true });
  }, [SESSION_KEY, setSearchParams]);

  // Persist open file path to sessionStorage whenever it changes
  useEffect(() => {
    if (openFile) {
      sessionStorage.setItem(SESSION_KEY, openFile.path);
    }
  }, [openFile, SESSION_KEY]);

  // The URL's ?path= is the open file: load it whenever it changes (click, back/forward).
  // Arriving without one, resolve the ?model= deep-link or the last-open file and write
  // it back with replace, so every history entry names its file.
  useEffect(() => {
    if (!graph) return;

    if (!pathParam) {
      const target = resolveDeepLinkPath(graph, modelParam) ?? readSessionPath(SESSION_KEY);
      if (target) {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set('path', target);
          return next;
        }, { replace: true });
      }
      return;
    }

    const key = `${pathParam}\n${modelParam ?? ''}`;
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    // For test deep-links, scroll the editor to that test
    const testNode = graph.nodes.find((n) => n.unique_id === modelParam && n.resource_type === 'test') ?? null;
    loadFile(pathParam, testNode);
  }, [graph, pathParam, modelParam, SESSION_KEY, setSearchParams, loadFile]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (openFile && edited !== undefined) handleSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFile, edited]);

  const handleSave = async () => {
    if (!openFile) return;
    setSaving(true);
    setSaveStatus('idle');
    try {
      const content = edited ?? openFile.content;
      const updated = await api.files.putContent(id, openFile.path, content);
      setOpenFile(updated);
      setEdited(undefined);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (e) {
      setSaveError(String(e));
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteFile = async () => {
    if (!openFile) return;
    if (!await confirmDialog(`Delete '${openFile.path}'? This cannot be undone.`, { confirmLabel: 'Delete', danger: true })) return;
    try {
      await api.files.delete(id, openFile.path);
      closeFile();
      setTreeVersion((v) => v + 1);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteModel = async () => {
    if (!selectedModel) return;
    if (!await confirmDialog(`Delete model '${selectedModel.name}'? This removes the file from disk.`, { confirmLabel: 'Delete', danger: true })) return;
    try {
      await api.models.delete(id, selectedModel.unique_id);
      closeFile();
      setTreeVersion((v) => v + 1);
    } catch (e) {
      console.error(e);
    }
  };

  /** Moved or renamed on the tree: keep the open file (and any unsaved edits) under its new path. */
  const handlePathsMoved = useCallback((moves: MovedPathDto[]) => {
    if (!openFile) return;
    const next = remapPath(openFile.path, moves);
    if (!next) return;
    setOpenFile({ ...openFile, path: next });
    loadedKeyRef.current = `${next}\n`;
    try { sessionStorage.setItem(SESSION_KEY, next); } catch { /* storage unavailable */ }
    setSearchParams({ path: next }, { replace: true });
  }, [openFile, SESSION_KEY, setSearchParams]);

  const handlePathsDeleted = useCallback((paths: string[]) => {
    if (openFile && paths.some((p) => isAtOrUnder(openFile.path, p))) closeFile();
  }, [openFile, closeFile]);

  const isDirty = edited !== undefined && edited !== openFile?.content;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Side rail */}
      <NavRail projectId={id} current="files" />

      {/* File tree */}
      <div style={{ width: treeWidth }} className="shrink-0 bg-surface-app border-r border-gray-800 flex flex-col overflow-hidden relative">
        <FileTree
          projectId={id}
          projectPath={project?.path ?? null}
          activePath={openFile?.path ?? null}
          revealPath={pathParam}
          loadingPath={loadingPath}
          refreshSignal={treeVersion}
          onOpen={openFileNode}
          onMoved={handlePathsMoved}
          onDeleted={handlePathsDeleted}
        />
        <div
          onMouseDown={(e) => { e.preventDefault(); treeResizing.current = true; }}
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/40 transition-colors"
        />
      </div>

      {/* Main editor area */}
      <div className="flex-1 overflow-hidden">
        {openFile ? (
          <ViewPane
            projectId={id}
            openFile={openFile}
            edited={edited}
            onEdit={setEdited}
            onSave={handleSave}
            onDelete={handleDeleteFile}
            saving={saving}
            saveStatus={saveStatus}
            saveError={saveError}
            isDirty={isDirty}
            modelUid={modelUid}
            graph={graph ?? null}
            onNavigateToFile={openFileNode}
            targetTestNode={targetTestNode}
            onTestSelected={(testNode) => setSelectedTestNode(testNode)}
          />
        ) : (
          <div className="flex items-center justify-center text-gray-600 text-sm select-none h-full">
            {openError ?? 'Select a file to view or edit'}
          </div>
        )}
      </div>

      {/* Side panel */}
      <SidePane
        projectId={id}
        model={selectedTestNode ?? selectedModel}
        graph={graph ?? null}
        page="files"
        onNavigateToDag={() => {
          const nav = selectedTestNode ?? selectedModel;
          if (nav) navigate(`/projects/${id}/models?model=${encodeURIComponent(nav.unique_id)}`);
        }}
        onViewDocs={() => {
          const nav = selectedTestNode ?? selectedModel;
          if (nav) navigate(`/projects/${id}/docs?node=${encodeURIComponent(nav.unique_id)}`);
        }}
        onDelete={handleDeleteModel}
        onNavigateToFile={openFileNode}
        previewCache={previewCache}
        onPreviewCached={(uid, data) => setPreviewCache((prev) => {
          const next = new Map(prev).set(uid, data);
          try { sessionStorage.setItem(PREVIEW_CACHE_KEY, JSON.stringify([...next])); } catch { /* quota */ }
          return next;
        })}
        failedTestUid={failedTestUid}
        onFailedTestConsumed={() => setFailedTestUid(null)}
        failedRowsCache={failedRowsCache}
        onFailedRowsCached={(uid, data) => setFailedRowsCache((prev) => {
          const next = new Map(prev).set(uid, data);
          try { sessionStorage.setItem(FAILED_ROWS_KEY, JSON.stringify([...next])); } catch { /* quota */ }
          return next;
        })}
      />

    </div>
  );
}
