import { describe, expect, it } from 'vitest';
import { rehypeListMarkers, type HastNode } from './listMarkers';

const li = (...children: HastNode[]): HastNode => ({ type: 'element', tagName: 'li', properties: {}, children });
const text = (value: string): HastNode => ({ type: 'text', children: [], properties: { value } });
const markers = (list: HastNode) => (list.children ?? []).map((c) => c.properties?.dataMarker);

describe('rehypeListMarkers', () => {
  it('numbers ordered lists from their start', () => {
    const ol: HastNode = { type: 'element', tagName: 'ol', properties: { start: 3 }, children: [li(text('a')), li(text('b'))] };
    rehypeListMarkers()({ type: 'root', children: [ol] });
    expect(markers(ol)).toEqual(['3.', '4.']);
  });

  it('changes the bullet with nesting depth', () => {
    const inner: HastNode = { type: 'element', tagName: 'ul', children: [li(text('b'))] };
    const outer: HastNode = { type: 'element', tagName: 'ul', children: [li(text('a'), inner)] };
    rehypeListMarkers()({ type: 'root', children: [outer] });
    expect(markers(outer)).toEqual(['•']);
    expect(markers(inner)).toEqual(['◦']);
  });

  it('leaves task items without a marker (the checkbox is the marker)', () => {
    const box: HastNode = { type: 'element', tagName: 'input', properties: { type: 'checkbox' } };
    const ul: HastNode = { type: 'element', tagName: 'ul', children: [li(box, text('do'))] };
    rehypeListMarkers()({ type: 'root', children: [ul] });
    expect(markers(ul)).toEqual(['']);
  });
});
