import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ChevronsDownUp, FilePlus, FolderPlus, RefreshCw } from 'lucide-react';
import type { MovedPathDto } from '../../../lib/api';
import { useProjectEvents } from '../../../lib/sse';
import { ContextMenu, type TreeAction } from './ContextMenu';
import { NewEntryRow, TreeRow } from './TreeRow';
import { dropDirFor, flattenVisible, isAtOrUnder, parentDir, rangeBetween } from './treeOps';
import { filterTree, type TreeNode } from './types';
import { useFileOps } from './useFileOps';
import { useFileTree } from './useFileTree';
import { useTreeDnd } from './useTreeDnd';

interface FileTreeProps {
  projectId: number;
  /** Absolute project folder, for Copy Path. */
  projectPath: string | null;
  /** The file open in the editor. */
  activePath: string | null;
  /** A path to scroll into view, expanding its folders (deep links, back/forward). */
  revealPath: string | null;
  loadingPath: string | null;
  /** Changes when the page edited files outside the tree, to re-read it. */
  refreshSignal: number;
  onOpen: (path: string) => void;
  onMoved: (moves: MovedPathDto[]) => void;
  onDeleted: (paths: string[]) => void;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const ERROR_TOAST_MS = 6000;

interface MenuState { x: number; y: number; node: TreeNode | null }
interface CreatingState { dir: string; isDir: boolean }

export function FileTree(props: FileTreeProps) {
  const { projectId, projectPath, activePath, revealPath, loadingPath, onOpen } = props;
  const { tree, reload, toggle, setExpanded, expandTo, collapseAll } = useFileTree(projectId);
  const [filterText, setFilterText] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const ops = useFileOps(projectId, {
    reload,
    onMoved: props.onMoved,
    onDeleted: props.onDeleted,
    onCreatedFile: onOpen,
  });
  const { error, clearError, clipboard, setClipboard } = ops;

  const visible = useMemo(() => (filterText.trim() ? filterTree(tree, filterText) : tree), [tree, filterText]);
  const rows = useMemo(() => flattenVisible(visible), [visible]);
  const nodeAt = useCallback((path: string | null) => rows.find((r) => r.node.path === path)?.node ?? null, [rows]);

  const selectOnly = useCallback((path: string) => {
    setSelection([path]);
    setAnchor(path);
    setFocus(path);
  }, []);

  const dnd = useTreeDnd({
    selection,
    setSelection,
    expand: (path) => setExpanded(path, true),
    move: ops.move,
    copy: ops.copy,
    upload: ops.upload,
    onError: ops.setError,
  });

  // Follow the open file: select it and open its folders
  useEffect(() => {
    if (activePath) selectOnly(activePath);
  }, [activePath, selectOnly]);
  useEffect(() => {
    if (revealPath) expandTo(revealPath);
  }, [revealPath, expandTo]);

  useEffect(() => {
    if (props.refreshSignal > 0) reload();
  }, [props.refreshSignal, reload]);

  // Keep the tree in sync with the disk (dbt, git, the editor, another app)
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'files_changed' || event.type === 'git_status_changed') reload();
  }, [reload]));
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(clearError, ERROR_TOAST_MS);
    return () => window.clearTimeout(t);
  }, [error, clearError]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [menu]);

  useEffect(() => {
    if (!focus) return;
    containerRef.current
      ?.querySelector(`[data-path="${CSS.escape(focus)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  const startCreate = useCallback(async (dir: string, isDir: boolean) => {
    if (dir) await expandTo(dir, true);
    setCreating({ dir, isDir });
  }, [expandTo]);

  /** What an action applies to: the selection if the target is in it, else the target alone. */
  const targetsFor = useCallback((node: TreeNode | null): string[] => {
    if (!node) return [];
    return selection.includes(node.path) ? selection : [node.path];
  }, [selection]);

  const runAction = useCallback((action: TreeAction, node: TreeNode | null) => {
    setMenu(null);
    const targets = targetsFor(node);
    const dir = dropDirFor(node);
    const rel = node?.path ?? '';
    const copyText = (text: string) => { navigator.clipboard.writeText(text).catch(console.error); };
    switch (action) {
      case 'new-file': startCreate(dir, false); break;
      case 'new-folder': startCreate(dir, true); break;
      case 'reveal': ops.reveal(rel); break;
      case 'cut': setClipboard({ mode: 'cut', paths: targets }); break;
      case 'copy': setClipboard({ mode: 'copy', paths: targets }); break;
      case 'paste': ops.paste(dir); break;
      case 'duplicate': if (node) ops.duplicate(node.path); break;
      case 'copy-path': copyText(projectPath ? [projectPath, rel].filter(Boolean).join('/') : rel); break;
      case 'copy-relative-path': copyText(rel || '.'); break;
      case 'rename': if (node) setRenaming(node.path); break;
      case 'delete': ops.remove(targets); break;
    }
  }, [targetsFor, startCreate, ops, setClipboard, projectPath]);

  const onRowClick = useCallback((e: MouseEvent, node: TreeNode) => {
    if (renaming === node.path) return;
    if (e.metaKey || e.ctrlKey) {
      setSelection((prev) => (prev.includes(node.path) ? prev.filter((p) => p !== node.path) : [...prev, node.path]));
      setAnchor(node.path);
      setFocus(node.path);
      return;
    }
    if (e.shiftKey && anchor) {
      setSelection(rangeBetween(rows, anchor, node.path));
      setFocus(node.path);
      return;
    }
    selectOnly(node.path);
    if (node.is_dir) toggle(node);
    else onOpen(node.path);
  }, [renaming, anchor, rows, selectOnly, toggle, onOpen]);

  const onRowContextMenu = useCallback((e: MouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (node && !selection.includes(node.path)) selectOnly(node.path);
    setMenu({ x: e.clientX, y: e.clientY, node });
  }, [selection, selectOnly]);

  const moveFocus = (delta: number, extend: boolean) => {
    if (rows.length === 0) return;
    const i = rows.findIndex((r) => r.node.path === focus);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i === -1 ? 0 : i + delta))].node.path;
    if (extend && anchor) {
      setSelection(rangeBetween(rows, anchor, next));
      setFocus(next);
    } else {
      selectOnly(next);
    }
  };

  const openOrToggle = (node: TreeNode) => {
    if (node.is_dir) toggle(node);
    else onOpen(node.path);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (renaming || creating) return;
    const mod = e.metaKey || e.ctrlKey;
    const node = nodeAt(focus);
    const key = e.key.toLowerCase();
    const handled = () => { e.preventDefault(); e.stopPropagation(); };

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      handled();
      moveFocus(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
    } else if (e.key === 'ArrowRight' && node?.is_dir) {
      handled();
      if (!node.expanded) toggle(node);
      else if (node.children?.length) selectOnly(node.children[0].path);
    } else if (e.key === 'ArrowLeft' && node) {
      handled();
      if (node.is_dir && node.expanded) toggle(node);
      else if (parentDir(node.path)) selectOnly(parentDir(node.path));
    } else if (node && (e.key === 'F2' || (e.key === 'Enter' && IS_MAC && !mod))) {
      handled();
      setRenaming(node.path);
    } else if (node && (e.key === ' ' || e.key === 'Enter' || (mod && e.key === 'ArrowDown'))) {
      handled();
      openOrToggle(node);
    } else if (node && (e.key === 'Delete' || (mod && e.key === 'Backspace'))) {
      handled();
      runAction('delete', node);
    } else if (mod && e.altKey && key === 'c') {
      handled();
      runAction(e.shiftKey ? 'copy-relative-path' : 'copy-path', node);
    } else if (mod && (key === 'c' || key === 'x') && node) {
      handled();
      runAction(key === 'c' ? 'copy' : 'cut', node);
    } else if (mod && key === 'v') {
      handled();
      runAction('paste', node);
    } else if (mod && key === 'a') {
      handled();
      setSelection(rows.map((r) => r.node.path));
    } else if (e.key === 'Escape') {
      handled();
      setClipboard(null);
      if (focus) selectOnly(focus);
    }
  };

  const cutPaths = clipboard?.mode === 'cut' ? clipboard.paths : [];
  const isCut = (path: string) => cutPaths.some((p) => isAtOrUnder(path, p));
  const inDrop = (path: string) => dnd.dropDir !== null && dnd.dropDir !== '' && isAtOrUnder(path, dnd.dropDir);
  const newEntryRow = (depth: number) => creating && (
    <NewEntryRow
      key="__new__"
      depth={depth}
      isDir={creating.isDir}
      onSubmit={(name) => { const c = creating; setCreating(null); ops.create(c.dir, name, c.isDir); }}
      onCancel={() => setCreating(null)}
    />
  );

  const headerButton = 'shrink-0 p-1 text-gray-600 transition-colors hover:text-gray-300';

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex items-center gap-1 px-2 py-2 border-b border-gray-800 shrink-0">
        <input
          type="search"
          placeholder="Filter files…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          className="flex-1 min-w-0 bg-surface-elevated border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <button onClick={() => runAction('new-file', nodeAt(focus))} title="New File…" className={headerButton}>
          <FilePlus className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => runAction('new-folder', nodeAt(focus))} title="New Folder…" className={headerButton}>
          <FolderPlus className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => reload()} title="Refresh" className={headerButton}>
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button onClick={collapseAll} title="Collapse all folders" className={headerButton}>
          <ChevronsDownUp className="w-3.5 h-3.5" />
        </button>
      </div>

      <div
        ref={containerRef}
        role="tree"
        aria-multiselectable
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => onRowContextMenu(e, null)}
        onDragOver={(e) => dnd.onDragOver(e, null)}
        onDrop={(e) => dnd.onDrop(e, null)}
        onDragLeave={dnd.onDragLeaveTree}
        className={`overflow-auto flex-1 py-1 outline-none ${dnd.dropDir === '' ? 'bg-brand-900/20 ring-1 ring-inset ring-brand-500/50' : ''}`}
      >
        {creating?.dir === '' && newEntryRow(0)}
        {rows.map(({ node, depth }) => (
          <div key={node.path}>
            <TreeRow
              node={node}
              depth={depth}
              active={node.path === activePath}
              selected={selection.includes(node.path)}
              focused={node.path === focus}
              cut={isCut(node.path)}
              inDropTarget={inDrop(node.path)}
              loading={node.path === loadingPath}
              renaming={node.path === renaming}
              onClick={onRowClick}
              onContextMenu={onRowContextMenu}
              onRename={(n, name) => { setRenaming(null); ops.rename(n.path, name); }}
              onRenameCancel={() => { setRenaming(null); containerRef.current?.focus(); }}
              onDragStart={dnd.onDragStart}
              onDragOver={dnd.onDragOver}
              onDrop={dnd.onDrop}
              onDragEnd={dnd.onDragEnd}
            />
            {creating && node.is_dir && creating.dir === node.path && node.expanded && newEntryRow(depth + 1)}
          </div>
        ))}
        {/* Room below the last row to drop onto the project root or right-click for root actions */}
        <div className="h-16" />
      </div>

      {error && (
        <div className="flex items-start gap-2 m-2 px-2 py-1.5 rounded border border-red-900/60 bg-red-950/40 text-xs text-red-300">
          <span className="flex-1 break-words">{error}</span>
          <button onClick={clearError} className="text-red-400 hover:text-red-200" title="Dismiss">×</button>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          node={menu.node}
          count={menu.node ? targetsFor(menu.node).length : 0}
          canPaste={!!clipboard}
          onAction={(a) => runAction(a, menu.node)}
        />
      )}
    </div>
  );
}
