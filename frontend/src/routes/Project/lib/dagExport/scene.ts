import type { ModelNode } from '../../../../lib/api';
import { NODE_HEIGHT, NODE_WIDTH } from '../layout';

/** Pixel gap kept around the graph in every export. */
export const SCENE_PADDING = 40;
export const COLUMN_ROW_HEIGHT = 22;
/** Top of the column list inside an expanded node, matching ModelNode's header block. */
export const COLUMNS_TOP = NODE_HEIGHT + 4;

export interface SceneColumn {
  name: string;
  dataType: string | null;
}

export interface SceneNode {
  model: ModelNode;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Columns drawn inside the box (expanded nodes only, as many as fit). */
  visibleColumns: SceneColumn[];
  hiddenColumnCount: number;
}

export interface SceneEdge {
  source: string;
  target: string;
  path: string;
}

/** The DAG as drawn on screen, shifted so the top-left node sits at the padding. */
export interface DagScene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  width: number;
  height: number;
}

export interface LayoutNodeInput {
  id: string;
  position: { x: number; y: number };
  data: { model?: unknown };
}

export interface LayoutEdgeInput {
  source: string;
  target: string;
}

function visibleColumnsFor(model: ModelNode, height: number, expanded: boolean) {
  if (!expanded || model.columns.length === 0) return { visible: [], hidden: 0 };
  const fit = Math.max(1, Math.floor((height - COLUMNS_TOP - 4) / COLUMN_ROW_HEIGHT));
  // Leave the last row for the "+N more" line when the list doesn't fit
  const shown = model.columns.length > fit ? fit - 1 : fit;
  const visible = model.columns.slice(0, Math.max(shown, 0)).map((c) => ({
    name: c.name,
    dataType: c.data_type ?? null,
  }));
  return { visible, hidden: model.columns.length - visible.length };
}

export function sceneNodeFor(
  model: ModelNode,
  x: number,
  y: number,
  nodeHeights: Map<string, number>,
  expanded: Set<string>,
): SceneNode {
  const height = nodeHeights.get(model.unique_id) ?? NODE_HEIGHT;
  const { visible, hidden } = visibleColumnsFor(model, height, expanded.has(model.unique_id));
  return { model, x, y, width: NODE_WIDTH, height, visibleColumns: visible, hiddenColumnCount: hidden };
}

/**
 * Every project node for a whole-project HTML export: the scene's nodes keep their on-screen
 * position; the rest are unplaced (0,0) until the viewer's filters show them and the page lays
 * them out.
 */
export function projectSceneNodes(
  models: ModelNode[],
  scene: DagScene,
  nodeHeights: Map<string, number>,
  expanded: Set<string>,
): SceneNode[] {
  const placed = new Map(scene.nodes.map((n) => [n.model.unique_id, n]));
  return models.map((m) => placed.get(m.unique_id) ?? sceneNodeFor(m, 0, 0, nodeHeights, expanded));
}

export function edgePath(sx: number, sy: number, tx: number, ty: number): string {
  const dx = Math.max(40, Math.abs(tx - sx) / 2);
  return `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
}

export function buildScene(
  layoutNodes: LayoutNodeInput[],
  layoutEdges: LayoutEdgeInput[],
  nodeHeights: Map<string, number>,
  expanded: Set<string>,
): DagScene {
  const placed = layoutNodes.filter((n) => n.data.model);
  if (placed.length === 0) return { nodes: [], edges: [], width: SCENE_PADDING * 2, height: SCENE_PADDING * 2 };

  // reduce, not Math.min(...spread): a spread of thousands of nodes can overflow the call stack
  const minX = placed.reduce((m, n) => Math.min(m, n.position.x), Infinity);
  const minY = placed.reduce((m, n) => Math.min(m, n.position.y), Infinity);

  const nodes = placed.map((n) => sceneNodeFor(
    n.data.model as ModelNode,
    n.position.x - minX + SCENE_PADDING,
    n.position.y - minY + SCENE_PADDING,
    nodeHeights,
    expanded,
  ));

  const byId = new Map(nodes.map((n) => [n.model.unique_id, n]));
  const edges: SceneEdge[] = [];
  for (const e of layoutEdges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    edges.push({
      source: e.source,
      target: e.target,
      path: edgePath(s.x + s.width, s.y + s.height / 2, t.x, t.y + t.height / 2),
    });
  }

  return {
    nodes,
    edges,
    width: nodes.reduce((m, n) => Math.max(m, n.x + n.width), 0) + SCENE_PADDING,
    height: nodes.reduce((m, n) => Math.max(m, n.y + n.height), 0) + SCENE_PADDING,
  };
}
