import dagreBundle from 'dagre/dist/dagre.min.js?raw';
import type { ColumnLineageEntry } from '../../../../lib/api';
import type { FilterState } from '../dagFilter';
import { NODE_WIDTH } from '../layout';
import type { ExportHeader, ExportTheme, HtmlIncludes } from './config';
import filterScript from './htmlFilter.js?raw';
import { htmlStyles } from './htmlStyles';
import runtime from './htmlRuntime.js?raw';
import type { DagScene, SceneNode } from './scene';
import { PALETTES, arrowDefs, escapeXml, renderNode } from './svg';

export type LineageResults = Record<string, Record<string, ColumnLineageEntry[]>>;

interface ExportNodeData {
  name: string;
  type: string;
  materialized: string | null;
  status: string;
  schema: string | null;
  database: string | null;
  tags: string[];
  description: string;
  columns: string[];
  /** Box height, for re-layout. */
  h: number;
  /** On-screen position; only for nodes shown when exported. */
  x?: number;
  y?: number;
}

export interface FilterData {
  selector: string;
  resourceTypes: string[];
  materializations: string[];
  tags: string[];
  statuses: string[];
}

/** Payload the runtime reads: edges and lineage refs are `[node, column]`-style pairs to keep the file small. */
export interface ExportData {
  options: HtmlIncludes;
  nodeWidth: number;
  /** Node ids in a stable order (dagre's layout depends on insertion order). */
  order: string[];
  nodes: Record<string, ExportNodeData>;
  edges: Array<[string, string]>;
  lineage: Record<string, Record<string, Array<[string, string]>>> | null;
  /** The filter the page opens with; it lays out from the on-screen positions while this is active. */
  initialFilter: FilterData;
  /** Stroke for the edges the runtime draws (the theme's edge color). */
  edgeColor?: string;
}

/** Column lineage restricted to the exported nodes, on both ends of every ref. */
export function pruneLineage(results: LineageResults, keep: Set<string>): Record<string, Record<string, Array<[string, string]>>> {
  const out: Record<string, Record<string, Array<[string, string]>>> = {};
  for (const [node, cols] of Object.entries(results)) {
    if (!keep.has(node)) continue;
    const kept: Record<string, Array<[string, string]>> = {};
    for (const [col, refs] of Object.entries(cols)) {
      const pairs = refs.filter((r) => keep.has(r.node)).map((r): [string, string] => [r.node, r.column]);
      if (pairs.length > 0) kept[col] = pairs;
    }
    if (Object.keys(kept).length > 0) out[node] = kept;
  }
  return out;
}

export function toFilterData(filter: FilterState): FilterData {
  return {
    selector: filter.selector,
    resourceTypes: [...filter.resourceTypes].sort(),
    materializations: [...filter.materializations].sort(),
    tags: [...filter.tags].sort(),
    statuses: [...filter.statuses].sort(),
  };
}

const NO_FILTER: FilterData = { selector: '', resourceTypes: [], materializations: [], tags: [], statuses: [] };

/** The whole project for a whole-project export: every node (placed or not) and every edge. */
export interface ProjectGraph {
  nodes: SceneNode[];
  edges: Array<{ source: string; target: string }>;
}

export interface ExportDataInput {
  scene: DagScene;
  includes: HtmlIncludes;
  lineage: LineageResults | null;
  /** The on-screen filter. */
  filter: FilterState;
  /** Required when includes.wholeProject; ignored otherwise. */
  project: ProjectGraph | null;
}

export function buildExportData({ scene, includes, lineage, filter, project }: ExportDataInput): ExportData {
  const whole = includes.wholeProject && project !== null;
  const sceneNodes = whole ? project.nodes : scene.nodes;
  const edgeList = whole
    ? project.edges.map((e): [string, string] => [e.source, e.target])
    : scene.edges.map((e): [string, string] => [e.source, e.target]);
  const shown = new Set(scene.nodes.map((n) => n.model.unique_id));
  const keep = new Set(sceneNodes.map((n) => n.model.unique_id));
  const pruned = includes.columnLineage && lineage ? pruneLineage(lineage, keep) : null;

  const nodes: Record<string, ExportNodeData> = {};
  for (const n of sceneNodes) {
    const m = n.model;
    // Lineage can know columns the catalog doesn't (never-documented models)
    const columns = m.columns.map((c) => c.name);
    for (const col of Object.keys(pruned?.[m.unique_id] ?? {})) {
      if (!columns.includes(col)) columns.push(col);
    }
    nodes[m.unique_id] = {
      name: m.name,
      type: m.resource_type,
      materialized: m.materialized,
      status: m.status,
      schema: m.schema_,
      database: m.database,
      tags: m.tags,
      description: m.description,
      columns,
      h: n.height,
      ...(shown.has(m.unique_id) ? { x: n.x, y: n.y } : {}),
    };
  }
  return {
    options: { ...includes, wholeProject: whole },
    nodeWidth: NODE_WIDTH,
    order: sceneNodes.map((n) => n.model.unique_id),
    nodes,
    edges: edgeList.filter(([s, t]) => keep.has(s) && keep.has(t)),
    lineage: pruned,
    // A subset export opens with nothing filtered: every node in it is what was on screen
    initialFilter: whole ? toFilterData(filter) : NO_FILTER,
  };
}

/** JSON safe to inline in a <script> element: no `</script>`, no line separators. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function hintFor(includes: HtmlIncludes): string {
  const parts = ['Scroll to zoom, drag to pan'];
  if (includes.modelLineage) parts.push('click a node for its lineage');
  if (includes.columnLineage) parts.push('click a column to trace it');
  return parts.join(' · ');
}

export interface HtmlExportInput extends ExportDataInput {
  header: ExportHeader;
  theme: ExportTheme;
}

/** A self-contained, offline HTML page: header, filter bar, pannable/zoomable DAG and the runtime. */
export function renderDagHtml(input: HtmlExportInput): string {
  const { header, theme } = input;
  const palette = PALETTES[theme];
  const data = { ...buildExportData(input), edgeColor: palette.edge };
  const nodeSource = data.options.wholeProject && input.project ? input.project.nodes : input.scene.nodes;
  const rows = header.rows
    .map((r) => `<dt>${escapeXml(r.label)}</dt><dd>${escapeXml(r.value)}</dd>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="wickd">
<title>${escapeXml(header.title)}</title>
<style>${htmlStyles(palette)}</style>
</head>
<body>
<header>
<h1>${escapeXml(header.title)}</h1>
<p class="subtitle">${escapeXml(header.subtitle)}</p>
<details${data.options.wholeProject ? '' : ' open'}><summary>Exported with</summary><dl>${rows}</dl></details>
</header>
<nav id="filters" aria-label="Filters">
<input id="selector" type="search" placeholder="Filter: +model, tag:nightly, source:…" aria-label="Selector" spellcheck="false">
<span id="dropdowns"></span>
<button id="clear" type="button" hidden>✕ Clear</button>
<button id="reset" type="button" hidden title="Back to the filters this was exported with">Reset</button>
<span id="count"></span>
</nav>
<main>
<svg id="graph" xmlns="http://www.w3.org/2000/svg">${arrowDefs(palette)}<g id="viewport"><g id="edges"></g><g class="nodes">${nodeSource.map((n) => renderNode(n, palette)).join('')}</g></g></svg>
<div id="toolbar">
<input id="search" type="search" placeholder="Find a node…" aria-label="Find a node">
<button id="zoom-out" title="Zoom out">−</button><button id="zoom-in" title="Zoom in">+</button><button id="fit">Fit</button>
<span class="hint">${escapeXml(hintFor(data.options))}</span>
</div>
<p id="empty" hidden>No nodes match these filters.</p>
<aside id="panel" hidden></aside>
<div id="tooltip" hidden></div>
</main>
<script type="application/json" id="dag-data">${jsonForScript(data)}</script>
<script>${dagreBundle}</script>
<script>${filterScript}</script>
<script>${runtime}</script>
</body>
</html>
`;
}
