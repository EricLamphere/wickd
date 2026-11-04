import type { DocsMacroDto, DocsNodeDto } from '../../../lib/api';

// ---- tree types ----

export interface TreeLeaf {
  kind: 'leaf';
  uid: string;
  name: string;
  resourceType: string;
}

export interface TreeDir {
  kind: 'dir';
  name: string;
  children: TreeNode[];
}

export type TreeNode = TreeDir | TreeLeaf;

// ---- tree builders ----

/** Strip the leading resource-type directory from a path, e.g. "models/example/foo.sql" → ["example","foo.sql"] */
export function pathSegments(rawPath: string | null, stripFirst = true): string[] {
  if (!rawPath) return [];
  const parts = rawPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return stripFirst && parts.length > 1 ? parts.slice(1) : parts;
}

export function insertLeaf(root: TreeDir, segments: string[], leaf: TreeLeaf) {
  if (segments.length === 1) {
    root.children.push(leaf);
    return;
  }
  const dirName = segments[0];
  let dir = root.children.find((c): c is TreeDir => c.kind === 'dir' && c.name === dirName);
  if (!dir) {
    dir = { kind: 'dir', name: dirName, children: [] };
    root.children.push(dir);
  }
  insertLeaf(dir, segments.slice(1), leaf);
}

export function sortTree(node: TreeDir) {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (child.kind === 'dir') sortTree(child);
  }
}

/** Build a path-based folder tree from a flat list of nodes */
export function buildNodeTree(items: DocsNodeDto[]): TreeDir {
  const root: TreeDir = { kind: 'dir', name: '', children: [] };
  for (const n of items) {
    const segs = pathSegments(n.path, true);
    const leaf: TreeLeaf = { kind: 'leaf', uid: n.unique_id, name: n.name, resourceType: n.resource_type };
    insertLeaf(root, segs.length > 0 ? segs : [n.name], leaf);
  }
  sortTree(root);
  return root;
}

/** Build database → schema → node tree */
export function buildDatabaseTree(nodes: DocsNodeDto[]): TreeDir {
  const root: TreeDir = { kind: 'dir', name: '', children: [] };
  // Only include nodes that have database/schema info (models, seeds, snapshots, sources)
  const relevant = nodes.filter((n) =>
    ['model', 'seed', 'snapshot', 'source'].includes(n.resource_type)
  );
  for (const n of relevant) {
    const db = n.database || '(no database)';
    const schema = n.schema || '(no schema)';
    const leaf: TreeLeaf = { kind: 'leaf', uid: n.unique_id, name: n.name, resourceType: n.resource_type };
    insertLeaf(root, [db, schema, n.name], leaf);
  }
  sortTree(root);
  return root;
}

/** Build group → node tree. Nodes without a group go into "No Group". */
export function buildGroupTree(nodes: DocsNodeDto[]): TreeDir {
  const root: TreeDir = { kind: 'dir', name: '', children: [] };
  const relevant = nodes.filter((n) =>
    ['model', 'seed', 'snapshot', 'source', 'analysis'].includes(n.resource_type)
  );
  for (const n of relevant) {
    const group = n.group || 'No Group';
    const leaf: TreeLeaf = { kind: 'leaf', uid: n.unique_id, name: n.name, resourceType: n.resource_type };
    insertLeaf(root, [group, n.name], leaf);
  }
  sortTree(root);
  return root;
}

/** For macros: project macros use their path tree; others are bucketed by package_name.
 *  "dbt" package → "Built-in" label. */
export function buildMacroTopLevel(macros: DocsMacroDto[], projectName: string): TreeDir {
  const root: TreeDir = { kind: 'dir', name: '', children: [] };

  const byPkg = new Map<string, DocsMacroDto[]>();
  for (const m of macros) {
    const pkg = m.package_name ?? '';
    const list = byPkg.get(pkg) ?? [];
    list.push(m);
    byPkg.set(pkg, list);
  }

  // Project macros first — inline tree from path
  if (byPkg.has(projectName)) {
    const projectMacros = byPkg.get(projectName)!;
    const projectDir: TreeDir = { kind: 'dir', name: projectName, children: [] };
    for (const m of projectMacros) {
      const segs = pathSegments(m.path, true);
      const leaf: TreeLeaf = { kind: 'leaf', uid: m.unique_id, name: m.name, resourceType: 'macro' };
      insertLeaf(projectDir, segs.length > 0 ? segs : [m.name], leaf);
    }
    sortTree(projectDir);
    root.children.push(projectDir);
    byPkg.delete(projectName);
  }

  const BUILTIN_PKGS = new Set(['dbt']);
  const builtinMacros: DocsMacroDto[] = [];
  const otherPkgs = new Map<string, DocsMacroDto[]>();
  for (const [pkg, list] of byPkg) {
    if (BUILTIN_PKGS.has(pkg)) builtinMacros.push(...list);
    else otherPkgs.set(pkg, list);
  }

  if (builtinMacros.length > 0) {
    const builtinDir: TreeDir = { kind: 'dir', name: 'Built-in', children: [] };
    for (const m of builtinMacros) {
      const segs = pathSegments(m.path, true);
      const leaf: TreeLeaf = { kind: 'leaf', uid: m.unique_id, name: m.name, resourceType: 'macro' };
      insertLeaf(builtinDir, segs.length > 0 ? segs : [m.name], leaf);
    }
    sortTree(builtinDir);
    root.children.push(builtinDir);
  }

  for (const [pkg, list] of [...otherPkgs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const pkgDir: TreeDir = { kind: 'dir', name: pkg, children: [] };
    for (const m of list) {
      const segs = pathSegments(m.path, true);
      const leaf: TreeLeaf = { kind: 'leaf', uid: m.unique_id, name: m.name, resourceType: 'macro' };
      insertLeaf(pkgDir, segs.length > 0 ? segs : [m.name], leaf);
    }
    sortTree(pkgDir);
    root.children.push(pkgDir);
  }

  return root;
}

/** Collect all leaf UIDs in a tree matching a filter string */
export function collectMatching(node: TreeNode, q: string): Set<string> {
  const result = new Set<string>();
  function walk(n: TreeNode) {
    if (n.kind === 'leaf') {
      if (n.name.toLowerCase().includes(q)) result.add(n.uid);
    } else {
      for (const c of n.children) walk(c);
    }
  }
  walk(node);
  return result;
}

/** Collect all dir paths that contain at least one matching leaf */
export function expandedDirsForFilter(node: TreeDir, q: string): Set<string> {
  const expanded = new Set<string>();
  function walk(n: TreeDir, path: string): boolean {
    let hasMatch = false;
    for (const child of n.children) {
      if (child.kind === 'leaf') {
        if (child.name.toLowerCase().includes(q)) hasMatch = true;
      } else {
        if (walk(child, path + '/' + child.name)) hasMatch = true;
      }
    }
    if (hasMatch) expanded.add(path);
    return hasMatch;
  }
  walk(node, node.name);
  return expanded;
}

// ---- icons / colors ----

export const TYPE_ORDER: Record<string, number> = {
  model: 0, seed: 1, snapshot: 2, source: 3, analysis: 4, test: 5,
  semantic_model: 6, metric: 7, saved_query: 8, macro: 9,
};

export const TYPE_LABELS: Record<string, string> = {
  model: 'Models', seed: 'Seeds', snapshot: 'Snapshots',
  source: 'Sources', analysis: 'Analyses', test: 'Tests', macro: 'Macros',
  semantic_model: 'Semantic models', metric: 'Metrics', saved_query: 'Saved queries',
};

/** Find the path keys that must be open to reveal a leaf uid in the tree */
export function findPathToUid(node: TreeDir, targetUid: string, prefix: string): string[] | null {
  for (const child of node.children) {
    if (child.kind === 'leaf') {
      if (child.uid === targetUid) return [prefix];
    } else {
      const childPath = prefix + '/' + child.name;
      const found = findPathToUid(child, targetUid, childPath);
      if (found) return [prefix, ...found];
    }
  }
  return null;
}

export interface DocsSection {
  id: string;
  label: string;
  resourceType: string;
  tree: TreeDir;
}

/** Project tab: one section per resource type (in display order), macros last. */
export function buildProjectSections(nodes: DocsNodeDto[], macros: DocsMacroDto[], projectName: string): DocsSection[] {
  const byType = new Map<string, DocsNodeDto[]>();
  for (const n of nodes) {
    const list = byType.get(n.resource_type) ?? [];
    list.push(n);
    byType.set(n.resource_type, list);
  }
  const nodeSections = [...byType.entries()]
    .sort(([a], [b]) => (TYPE_ORDER[a] ?? 9) - (TYPE_ORDER[b] ?? 9))
    .map(([type, items]) => ({
      id: `type:${type}`,
      label: TYPE_LABELS[type] ?? type,
      resourceType: type,
      tree: buildNodeTree(items),
    }));
  const macroSection = macros.length > 0
    ? [{ id: 'type:macro', label: 'Macros', resourceType: 'macro', tree: buildMacroTopLevel(macros, projectName) }]
    : [];
  return [...nodeSections, ...macroSection];
}
