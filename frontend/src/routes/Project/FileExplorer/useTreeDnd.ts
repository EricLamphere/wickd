import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { UploadEntry } from '../../../lib/api';
import { collectDroppedFiles, isOsFileDrag } from './osDrop';
import { canDropInto, dropDirFor, topLevelPaths } from './treeOps';
import type { TreeNode } from './types';

const DRAG_MIME = 'application/x-wickd-paths';
/** Hovering a collapsed folder this long while dragging opens it, like VS Code. */
const HOVER_EXPAND_MS = 600;

interface TreeDndOptions {
  selection: readonly string[];
  setSelection: (paths: string[]) => void;
  expand: (path: string) => void;
  move: (paths: string[], destDir: string) => unknown;
  copy: (paths: string[], destDir: string) => unknown;
  upload: (entries: UploadEntry[], destDir: string) => unknown;
  onError: (message: string) => void;
}

/**
 * Drag and drop in the Files tree: drag rows onto a folder (or a file, meaning
 * its folder, or empty space, meaning the project root) to move them — hold
 * Alt/Option to copy — and drop files or folders from the OS to add them.
 * `dropDir` is the folder currently under the pointer, for highlighting.
 */
export function useTreeDnd(opts: TreeDndOptions) {
  const [dropDir, setDropDir] = useState<string | null>(null);
  const dragPaths = useRef<string[] | null>(null);
  const hoverTimer = useRef<{ path: string; id: number } | null>(null);
  const optsRef = useRef(opts);
  useEffect(() => { optsRef.current = opts; });

  const clearHover = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current.id);
    hoverTimer.current = null;
  };

  const reset = useCallback(() => {
    dragPaths.current = null;
    clearHover();
    setDropDir(null);
  }, []);

  const onDragStart = useCallback((e: DragEvent, node: TreeNode) => {
    const { selection, setSelection } = optsRef.current;
    const paths = selection.includes(node.path) ? topLevelPaths(selection) : [node.path];
    if (!selection.includes(node.path)) setSelection([node.path]);
    dragPaths.current = paths;
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
    e.dataTransfer.setData('text/plain', paths.join('\n'));
    e.dataTransfer.effectAllowed = 'copyMove';
  }, []);

  /** `node` null = empty space below the rows (the project root). */
  const onDragOver = useCallback((e: DragEvent, node: TreeNode | null) => {
    e.stopPropagation();
    const internal = dragPaths.current;
    const external = !internal && isOsFileDrag(e.dataTransfer);
    const dest = dropDirFor(node);
    const copying = e.altKey;
    if (!(external || (internal && (copying || canDropInto(internal, dest))))) {
      e.dataTransfer.dropEffect = 'none';
      setDropDir(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = external || copying ? 'copy' : 'move';
    setDropDir(dest);
    if (node?.is_dir && !node.expanded) {
      if (hoverTimer.current?.path !== node.path) {
        clearHover();
        const path = node.path;
        hoverTimer.current = { path, id: window.setTimeout(() => optsRef.current.expand(path), HOVER_EXPAND_MS) };
      }
    } else {
      clearHover();
    }
  }, []);

  const onDrop = useCallback((e: DragEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    const dest = dropDirFor(node);
    const internal = dragPaths.current;
    const { move, copy, upload, onError } = optsRef.current;
    if (internal) {
      if (e.altKey) copy(internal, dest);
      else if (canDropInto(internal, dest)) move(internal, dest);
    } else if (isOsFileDrag(e.dataTransfer)) {
      // Must run before any await: the DataTransfer empties once this handler returns
      collectDroppedFiles(e.dataTransfer)
        .then((entries) => upload(entries, dest))
        .catch((err) => onError(`Couldn't read the dropped files: ${err instanceof Error ? err.message : String(err)}`));
    }
    reset();
  }, [reset]);

  /** Leaving the tree entirely (relatedTarget outside it) clears the highlight. */
  const onDragLeaveTree = useCallback((e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      clearHover();
      setDropDir(null);
    }
  }, []);

  useEffect(() => clearHover, []);

  return { dropDir, onDragStart, onDragOver, onDrop, onDragEnd: reset, onDragLeaveTree };
}
