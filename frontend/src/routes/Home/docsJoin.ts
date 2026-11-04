import type { DocsDataDto, DocsMacroDto, DocsNodeDto } from '../../lib/api';
import {
  buildDatabaseTree, buildGroupTree, buildProjectSections, type DocsSection, type TreeDir,
} from '../Project/DocsBrowser/docsTree';

/**
 * Combined docs join projects without merging ids. A unique_id is only unique within a
 * project (an installed package's nodes appear in each project using it), so the tree and
 * the URL address a node as `<projectId>::<uniqueId>`, while each project keeps its own
 * lookups, which the detail components read with plain unique_ids.
 */
const KEY_SEPARATOR = '::';

/** The tree's own key for a project's root row (ProjectRootTree) and overview page. */
export const PROJECT_OVERVIEW = '__project__';

export function nodeKey(projectId: number, uid: string): string {
  return `${projectId}${KEY_SEPARATOR}${uid}`;
}

export function parseNodeKey(key: string): { projectId: number; uid: string } | null {
  const at = key.indexOf(KEY_SEPARATOR);
  if (at <= 0) return null;
  const head = key.slice(0, at);
  const uid = key.slice(at + KEY_SEPARATOR.length);
  if (!/^\d+$/.test(head) || !uid) return null;
  return { projectId: Number(head), uid };
}

export interface ProjectDocs {
  projectId: number;
  name: string;
  data: DocsDataDto;
  nodes: Map<string, DocsNodeDto>;
  macros: Map<string, DocsMacroDto>;
  /** Tree sections with leaves keyed by nodeKey(). */
  sections: DocsSection[];
  keyedNodes: DocsNodeDto[];
}

export function buildProjectDocs(projectId: number, name: string, data: DocsDataDto): ProjectDocs {
  const keyedNodes = data.nodes.map((n) => ({ ...n, unique_id: nodeKey(projectId, n.unique_id) }));
  const keyedMacros = data.macros.map((m) => ({ ...m, unique_id: nodeKey(projectId, m.unique_id) }));
  return {
    projectId,
    name,
    data,
    nodes: new Map(data.nodes.map((n) => [n.unique_id, n])),
    macros: new Map(data.macros.map((m) => [m.unique_id, m])),
    sections: buildProjectSections(keyedNodes, keyedMacros, data.project_name),
    keyedNodes,
  };
}

/** Database and Group views, across projects. Leaves name their project when there are several. */
export function buildCombinedTrees(projects: ProjectDocs[]): { databaseTree: TreeDir; groupTree: TreeDir } {
  const labelled = projects.flatMap((p) => (projects.length > 1
    ? p.keyedNodes.map((n) => ({ ...n, name: `${n.name} · ${p.name}` }))
    : p.keyedNodes));
  return { databaseTree: buildDatabaseTree(labelled), groupTree: buildGroupTree(labelled) };
}

/**
 * The key a reference opens. Its own project first; otherwise another selected project
 * that has the node, so a cross-project ref (dbt Mesh) can be followed.
 */
export function resolveNodeKey(projects: ProjectDocs[], fromProjectId: number, uid: string): string {
  const has = (p: ProjectDocs) => p.nodes.has(uid) || p.macros.has(uid);
  const own = projects.find((p) => p.projectId === fromProjectId);
  if (own && has(own)) return nodeKey(fromProjectId, uid);
  const other = projects.find(has);
  return nodeKey(other?.projectId ?? fromProjectId, uid);
}

/** A project's lookups, with other projects' nodes filling in names for cross-project refs. */
export function lookupMaps(projects: ProjectDocs[], projectId: number): {
  nodes: Map<string, DocsNodeDto>;
  macros: Map<string, DocsMacroDto>;
} {
  const ordered = [
    ...projects.filter((p) => p.projectId !== projectId),
    ...projects.filter((p) => p.projectId === projectId),
  ];
  return {
    nodes: new Map(ordered.flatMap((p) => [...p.nodes])),
    macros: new Map(ordered.flatMap((p) => [...p.macros])),
  };
}

export interface DocStats {
  models: number;
  sources: number;
  tests: number;
  described: number;
  /** Models + sources: what `described` is out of. */
  documentable: number;
}

/** The project's own nodes only: installed packages would skew its documentation coverage. */
export function docStats(data: DocsDataDto): DocStats {
  const own = data.nodes.filter((n) => n.package_name === data.project_name);
  const count = (type: string) => own.filter((n) => n.resource_type === type).length;
  const documentable = own.filter((n) => n.resource_type === 'model' || n.resource_type === 'source');
  return {
    models: count('model'),
    sources: count('source'),
    tests: count('test'),
    described: documentable.filter((n) => n.description.trim()).length,
    documentable: documentable.length,
  };
}

export interface NodeRef {
  project: string;
  node: string;
}

/** Wicky refers to nodes as `project/node`; anything else in inline code stays code. */
export function parseNodeRef(text: string, projectNames: string[]): NodeRef | null {
  const match = /^([\w-]+)\/([\w.-]+)$/.exec(text.trim());
  if (!match || !projectNames.includes(match[1])) return null;
  return { project: match[1], node: match[2] };
}

export function nodeRefUrl(hit: { project_id: number; unique_id: string }, selection: number[]): string {
  if (selection.includes(hit.project_id)) {
    return `/?tab=docs&node=${encodeURIComponent(nodeKey(hit.project_id, hit.unique_id))}`;
  }
  return `/projects/${hit.project_id}/docs?node=${encodeURIComponent(hit.unique_id)}`;
}

/** Wicky answers about the saved selection, or every project without one. */
export function wickyScopeLabel(selected: number): string {
  if (selected === 0) return 'All projects';
  return selected === 1 ? '1 project' : `${selected} projects`;
}
