import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyDraggedPositions,
  clearDraggedPositions,
  draggedPositionsFor,
  recordDraggedPositions,
} from './draggedPositions';

const node = (id: string, x: number, y: number) => ({ id, position: { x, y }, data: {} });

describe('draggedPositions', () => {
  beforeEach(() => {
    clearDraggedPositions(1);
    clearDraggedPositions(2);
  });

  it('starts empty', () => {
    expect(draggedPositionsFor(1).size).toBe(0);
  });

  it('records positions per project', () => {
    recordDraggedPositions(1, [node('a', 10, 20)]);
    expect(draggedPositionsFor(1).get('a')).toEqual({ x: 10, y: 20 });
    expect(draggedPositionsFor(2).size).toBe(0);
  });

  it('keeps the latest position for a node dragged twice', () => {
    recordDraggedPositions(1, [node('a', 10, 20)]);
    recordDraggedPositions(1, [node('a', 30, 40)]);
    expect(draggedPositionsFor(1).get('a')).toEqual({ x: 30, y: 40 });
  });

  it('overrides layout positions only for dragged nodes', () => {
    recordDraggedPositions(1, [node('a', 99, 99)]);
    const out = applyDraggedPositions([node('a', 0, 0), node('b', 5, 5)], draggedPositionsFor(1));
    expect(out.map((n) => n.position)).toEqual([{ x: 99, y: 99 }, { x: 5, y: 5 }]);
  });

  it('returns the same node objects when nothing was dragged', () => {
    const nodes = [node('a', 0, 0)];
    expect(applyDraggedPositions(nodes, draggedPositionsFor(1))[0]).toBe(nodes[0]);
  });

  it('clears a project', () => {
    recordDraggedPositions(1, [node('a', 1, 1)]);
    clearDraggedPositions(1);
    expect(draggedPositionsFor(1).size).toBe(0);
  });
});
