// Link, image and heading handling for rendered Markdown (docs pages and READMEs, plan 28).
// Pure: no React, no fetching. Unit-tested in docsPageLinks.test.ts.
import GithubSlugger from 'github-slugger';

export type NodeRefKind = 'ref' | 'source';

export type LinkTarget =
  | { kind: 'external'; href: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'page'; path: string; anchor: string | null } // relative to the docs folder
  | { kind: 'file'; path: string } // relative to the project root (opens in Files)
  | { kind: 'node'; uid: string }
  | { kind: 'unresolved_node'; label: string }
  | { kind: 'none' };

export interface LinkContext {
  /** Where the rendered document lives: a page in the docs folder, or the project root (README). */
  base: 'docs' | 'project';
  /** The document's folder, relative to its base ('' at the top). */
  dir: string;
  /** The docs folder relative to the project root ('docs', '../docs'), or null when there is none. */
  docsDir: string | null;
  /** Whether Files can open docs-folder files (the folder is inside the project). */
  docsInProject: boolean;
  resolveNode: (kind: NodeRefKind, name: string) => string | null;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const PAGE_SUFFIX = /\.(md|markdown)$/i;

/** Join and normalize posix path parts; null when `..` climbs above the root. */
export function normalizePath(...parts: string[]): string | null {
  const out: string[] = [];
  for (const segment of parts.join('/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join('/');
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function splitHash(href: string): [string, string | null] {
  const i = href.indexOf('#');
  return i === -1 ? [href, null] : [href.slice(0, i), safeDecode(href.slice(i + 1)) || null];
}

function nodeLink(kind: NodeRefKind, name: string, ctx: LinkContext): LinkTarget {
  const uid = ctx.resolveNode(kind, name);
  return uid ? { kind: 'node', uid } : { kind: 'unresolved_node', label: `${kind}:${name}` };
}

/** Strip a `docs/`-style prefix: the project-relative path inside the docs folder, else null. */
function insideDocs(projectPath: string, docsDir: string | null): string | null {
  if (docsDir === null) return null;
  const root = normalizePath(docsDir);
  if (root === null || root === '') return projectPath;
  return projectPath.startsWith(`${root}/`) ? projectPath.slice(root.length + 1) : null;
}

/** Where a Markdown link goes. */
export function resolveLink(href: string | undefined, ctx: LinkContext): LinkTarget {
  const raw = (href ?? '').trim();
  if (!raw) return { kind: 'none' };
  if (raw.startsWith('#')) return { kind: 'anchor', id: safeDecode(raw.slice(1)) };
  const ref = /^(ref|source):(.+)$/i.exec(raw);
  if (ref) return nodeLink(ref[1].toLowerCase() as NodeRefKind, ref[2].trim(), ctx);
  if (SCHEME.test(raw) || raw.startsWith('//')) return { kind: 'external', href: raw };

  const [pathPart, anchor] = splitHash(raw);
  const decoded = safeDecode(pathPart);
  const path = decoded.startsWith('/') ? normalizePath(decoded) : normalizePath(ctx.dir, decoded);
  if (path === null || path === '') return anchor ? { kind: 'anchor', id: anchor } : { kind: 'none' };
  const isPage = PAGE_SUFFIX.test(path);

  if (ctx.base === 'docs') {
    if (isPage) return { kind: 'page', path, anchor };
    if (!ctx.docsInProject || ctx.docsDir === null) return { kind: 'none' };
    const projectPath = normalizePath(ctx.docsDir, path);
    return projectPath ? { kind: 'file', path: projectPath } : { kind: 'none' };
  }
  const pagePath = isPage ? insideDocs(path, ctx.docsDir) : null;
  return pagePath ? { kind: 'page', path: pagePath, anchor } : { kind: 'file', path };
}

export interface ImageTarget {
  src: string;
  /** Set when the image is a local file served by the asset route. */
  local: { root: 'docs' | 'project'; path: string } | null;
}

/** Where an image is loaded from: external URLs pass through; local paths go through the asset route. */
export function resolveImage(src: string | undefined, ctx: Pick<LinkContext, 'base' | 'dir'>): ImageTarget | null {
  const raw = (src ?? '').trim();
  if (!raw) return null;
  if (SCHEME.test(raw) || raw.startsWith('//')) {
    return /^(https?|data):/i.test(raw) || raw.startsWith('//') ? { src: raw, local: null } : null;
  }
  const decoded = safeDecode(splitHash(raw)[0].split('?')[0]);
  const path = decoded.startsWith('/') ? normalizePath(decoded) : normalizePath(ctx.dir, decoded);
  return path ? { src: '', local: { root: ctx.base, path } } : null;
}

/** `ref('orders')`, `ref('pkg', 'orders')` or `source('raw', 'orders')` in inline code. */
export function parseInlineRef(code: string): { kind: NodeRefKind; name: string } | null {
  const m = /^\s*(ref|source)\(\s*(['"])([^'"]+)\2\s*(?:,\s*(['"])([^'"]+)\4\s*)?\)\s*$/.exec(code);
  if (!m) return null;
  if (m[1] === 'ref') return { kind: 'ref', name: m[5] ?? m[3] };
  return m[5] ? { kind: 'source', name: `${m[3]}.${m[5]}` } : null;
}

export interface ResolvableNode {
  unique_id: string;
  name: string;
  resource_type: string;
}

const REF_TYPES = new Set(['model', 'seed', 'snapshot', 'semantic_model', 'metric', 'saved_query', 'exposure']);

/** A `resolveNode` over the docs nodes: refs by name (or `pkg.name`), sources by `source.table`. */
export function buildNodeResolver(nodes: readonly ResolvableNode[]): (kind: NodeRefKind, name: string) => string | null {
  const refs = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const n of nodes) {
    if (n.resource_type === 'source') {
      const parts = n.unique_id.split('.');
      if (parts.length >= 4) sources.set(parts.slice(-2).join('.').toLowerCase(), n.unique_id);
    } else if (REF_TYPES.has(n.resource_type)) {
      const parts = n.unique_id.split('.');
      const key = n.name.toLowerCase();
      if (!refs.has(key)) refs.set(key, n.unique_id);
      if (parts.length >= 3) refs.set(`${parts[1]}.${n.name}`.toLowerCase(), n.unique_id);
    }
  }
  return (kind, name) => (kind === 'source' ? sources : refs).get(name.trim().toLowerCase()) ?? null;
}

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

/** Plain text of a heading line's inline Markdown (code spans, emphasis, links). */
function headingText(source: string): string {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/\s+#+\s*$/, '')
    .trim();
}

/** ATX headings outside code fences, with the ids rehype-slug gives them (same slugger, same order). */
export function extractHeadings(markdown: string): Heading[] {
  const slugger = new GithubSlugger();
  const headings: Heading[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    if (!m) continue;
    const text = headingText(m[2]);
    headings.push({ depth: m[1].length, text, id: slugger.slug(text) });
  }
  return headings;
}
