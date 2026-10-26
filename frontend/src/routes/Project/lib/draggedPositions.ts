/**
 * Where the user dragged DAG nodes, per project. Module state on purpose: it
 * survives leaving the DAG page and coming back, and resets on reload — the
 * layout is the user's for the session, not saved anywhere.
 */
interface XY { x: number; y: number }
interface Positioned { id: string; position: XY }

const byProject = new Map<number, ReadonlyMap<string, XY>>();
const EMPTY: ReadonlyMap<string, XY> = new Map();

export function draggedPositionsFor(projectId: number): ReadonlyMap<string, XY> {
  return byProject.get(projectId) ?? EMPTY;
}

export function recordDraggedPositions(projectId: number, nodes: readonly Positioned[]): void {
  const next = new Map(draggedPositionsFor(projectId));
  for (const n of nodes) next.set(n.id, { x: n.position.x, y: n.position.y });
  byProject.set(projectId, next);
}

export function clearDraggedPositions(projectId: number): void {
  byProject.delete(projectId);
}

/** Layout nodes with any dragged node moved to where the user left it. */
export function applyDraggedPositions<T extends Positioned>(nodes: readonly T[], dragged: ReadonlyMap<string, XY>): T[] {
  if (dragged.size === 0) return [...nodes];
  return nodes.map((n) => {
    const pos = dragged.get(n.id);
    return pos ? { ...n, position: pos } : n;
  });
}
