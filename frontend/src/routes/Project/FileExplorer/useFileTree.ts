import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { TreeNode } from './types';
import { isAtOrUnder, updateAtPath } from './treeOps';

/** Ancestor folders of a path, outermost first: `a/b/c.sql` → `a`, `a/b`. */
function ancestorDirs(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * The Files page tree: one level loaded per folder on expand, expanded folders
 * remembered for the session, and reload() re-reading every open folder (after
 * a move, a paste, or a change on disk) without collapsing anything.
 */
export function useFileTree(projectId: number) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const expandedKey = `file-explorer-expanded-${projectId}`;

  const readExpanded = useCallback((): Set<string> => {
    try {
      const raw = sessionStorage.getItem(expandedKey);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  }, [expandedKey]);

  const writeExpanded = useCallback((paths: Set<string>) => {
    try { sessionStorage.setItem(expandedKey, JSON.stringify([...paths])); } catch { /* storage unavailable */ }
  }, [expandedKey]);

  const listDir = useCallback(
    async (path: string): Promise<TreeNode[] | null> => {
      try {
        return (await api.files.list(projectId, path)) as TreeNode[];
      } catch {
        return null; // folder gone (moved/deleted on disk)
      }
    },
    [projectId],
  );

  /** Re-read the root and every remembered open folder; forgets folders that no longer exist. */
  const reload = useCallback(async () => {
    const expanded = readExpanded();
    const load = async (path: string): Promise<TreeNode[]> => {
      const children = (await listDir(path)) ?? [];
      return Promise.all(children.map(async (n) => {
        if (!n.is_dir || !expanded.has(n.path)) return n;
        return { ...n, expanded: true, children: await load(n.path) };
      }));
    };
    const root = await load('');
    const present = new Set<string>();
    const collect = (nodes: TreeNode[]) => nodes.forEach((n) => {
      if (n.expanded) { present.add(n.path); collect(n.children ?? []); }
    });
    collect(root);
    writeExpanded(present);
    setTree(root);
  }, [listDir, readExpanded, writeExpanded]);

  useEffect(() => { reload(); }, [reload]);

  const setExpanded = useCallback(async (path: string, expand: boolean) => {
    const expanded = readExpanded();
    if (expand) {
      expanded.add(path);
      writeExpanded(expanded);
      const children = (await listDir(path)) ?? [];
      setTree((prev) => updateAtPath(prev, path, (n) => ({ ...n, expanded: true, children })));
    } else {
      // Collapse this folder and forget its open descendants too
      writeExpanded(new Set([...expanded].filter((p) => !isAtOrUnder(p, path))));
      setTree((prev) => updateAtPath(prev, path, (n) => ({ ...n, expanded: false })));
    }
  }, [listDir, readExpanded, writeExpanded]);

  const toggle = useCallback((node: TreeNode) => {
    if (node.is_dir) setExpanded(node.path, !node.expanded);
  }, [setExpanded]);

  /** Expand every ancestor of `path` (and `path` itself when `includeSelf`), loading as needed. */
  const expandTo = useCallback(async (path: string, includeSelf = false) => {
    const dirs = includeSelf && path ? [...ancestorDirs(path), path] : ancestorDirs(path);
    if (dirs.length === 0) return;
    const loaded = await Promise.all(dirs.map((d) => listDir(d)));
    const expanded = readExpanded();
    dirs.forEach((d) => expanded.add(d));
    writeExpanded(expanded);
    setTree((prev) => dirs.reduce(
      (acc, d, i) => updateAtPath(acc, d, (n) => ({
        ...n,
        expanded: true,
        // Keep an already-loaded subtree so its open folders stay open
        children: n.children?.length ? n.children : (loaded[i] ?? []),
      })),
      prev,
    ));
  }, [listDir, readExpanded, writeExpanded]);

  const collapseAll = useCallback(() => {
    writeExpanded(new Set());
    const collapse = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((n) => (n.is_dir ? { ...n, expanded: false, children: n.children && collapse(n.children) } : n));
    setTree((prev) => collapse(prev));
  }, [writeExpanded]);

  return { tree, reload, toggle, setExpanded, expandTo, collapseAll };
}
