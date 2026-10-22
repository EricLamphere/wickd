import { describe, expect, it } from 'vitest';
import type { NodeSearchHit } from './api';
import { isNodeQuery, nodeSearchSubtitle, nodeSearchUrl, unindexedNotice } from './nodeSearch';

const hit: NodeSearchHit = {
  project_id: 7,
  project_name: 'shop',
  unique_id: 'source.shop.raw.orders',
  name: 'raw.orders',
  resource_type: 'source',
  original_file_path: 'models/sources.yml',
  description: '',
  matched_column: null,
};

describe('isNodeQuery', () => {
  it('needs two non-space characters', () => {
    expect(isNodeQuery('')).toBe(false);
    expect(isNodeQuery(' a ')).toBe(false);
    expect(isNodeQuery('ab')).toBe(true);
  });
});

describe('nodeSearchUrl', () => {
  it('opens the DAG by default and Files on request, encoding the unique id', () => {
    expect(nodeSearchUrl(hit)).toBe('/projects/7/models?model=source.shop.raw.orders');
    expect(nodeSearchUrl({ ...hit, unique_id: 'model.a b' }, 'files')).toBe('/projects/7/files?model=model.a%20b');
  });
});

describe('nodeSearchSubtitle', () => {
  it('joins project, column and path, skipping what is missing', () => {
    expect(nodeSearchSubtitle(hit)).toBe('shop · models/sources.yml');
    expect(nodeSearchSubtitle({ ...hit, matched_column: 'id', original_file_path: null })).toBe('shop · column id');
  });
});

describe('unindexedNotice', () => {
  const projects = [
    { id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }, { id: 4, name: 'd' }, { id: 5, name: 'e' },
  ];

  it('is null when everything is indexed or ids are unknown', () => {
    expect(unindexedNotice([], projects)).toBeNull();
    expect(unindexedNotice([99], projects)).toBeNull();
  });

  it('names one project in the singular', () => {
    expect(unindexedNotice([2], projects)).toBe("b hasn't been compiled yet, so it isn't searched.");
  });

  it('caps the list at three names', () => {
    expect(unindexedNotice([1, 2, 3, 4, 5], projects)).toBe(
      "a, b, c and 2 more haven't been compiled yet, so they aren't searched.",
    );
  });
});
