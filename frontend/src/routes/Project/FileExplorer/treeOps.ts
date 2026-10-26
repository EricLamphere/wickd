import type { TreeNode } from './types';

export interface FlatRow {
  node: TreeNode;
  depth: number;
}

export function parentDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** True when `path` is `ancestor` or inside it ('' is the project root, which holds everything). */
export function isAtOrUnder(path: string, ancestor: string): boolean {
  return ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`);
}

/** The folder a drop or paste onto `node` lands in: the folder itself, or a file's folder. */
export function dropDirFor(node: TreeNode | null): string {
  if (!node) return '';
  return node.is_dir ? node.path : parentDir(node.path);
}

/** Whether moving `paths` into `destDir` would do anything (and not put a folder inside itself). */
export function canDropInto(paths: readonly string[], destDir: string): boolean {
  if (paths.length === 0) return false;
  if (paths.some((p) => destDir !== '' && isAtOrUnder(destDir, p))) return false;
  return paths.some((p) => parentDir(p) !== destDir);
}

/** Where `path` ended up after `moves`, or null if no move touched it. */
export function remapPath(path: string, moves: readonly { src: string; dst: string }[]): string | null {
  for (const m of moves) {
    if (path === m.src) return m.dst;
    if (path.startsWith(`${m.src}/`)) return m.dst + path.slice(m.src.length);
  }
  return null;
}

/** Selected paths minus any inside another selected folder (moving the folder moves them). */
export function topLevelPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => !paths.some((other) => other !== p && p.startsWith(`${other}/`)));
}

/** The rows on screen, in order: collapsed folders' children are skipped. */
export function flattenVisible(nodes: readonly TreeNode[], depth = 0): FlatRow[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.is_dir && node.expanded && node.children ? flattenVisible(node.children, depth + 1) : []),
  ]);
}

/** Shift+click: every visible row between the anchor and the target, inclusive. */
export function rangeBetween(rows: readonly FlatRow[], anchor: string, target: string): string[] {
  const a = rows.findIndex((r) => r.node.path === anchor);
  const b = rows.findIndex((r) => r.node.path === target);
  if (a === -1 || b === -1) return [target];
  const [from, to] = a < b ? [a, b] : [b, a];
  return rows.slice(from, to + 1).map((r) => r.node.path);
}

/** Copy of the tree with the node at `path` replaced by `fn(node)`. */
export function updateAtPath(nodes: readonly TreeNode[], path: string, fn: (n: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((n) => {
    if (n.path === path) return fn(n);
    if (n.is_dir && n.children && path.startsWith(`${n.path}/`)) {
      return { ...n, children: updateAtPath(n.children, path, fn) };
    }
    return n;
  });
}
