import { describe, expect, it } from 'vitest';
import {
  canDropInto,
  dropDirFor,
  flattenVisible,
  isAtOrUnder,
  parentDir,
  rangeBetween,
  remapPath,
  topLevelPaths,
  updateAtPath,
} from './treeOps';
import type { TreeNode } from './types';

const file = (path: string): TreeNode => ({ name: path.split('/').pop()!, path, is_dir: false });
const dir = (path: string, children?: TreeNode[], expanded = false): TreeNode => ({
  name: path.split('/').pop()!, path, is_dir: true, children, expanded,
});

const tree: TreeNode[] = [
  dir('models', [
    dir('models/marts', [file('models/marts/orders.sql')], false),
    dir('models/staging', [file('models/staging/stg_a.sql'), file('models/staging/stg_b.sql')], true),
  ], true),
  file('dbt_project.yml'),
];

describe('parentDir / dropDirFor', () => {
  it('returns the parent folder, root as empty string', () => {
    expect(parentDir('models/marts/orders.sql')).toBe('models/marts');
    expect(parentDir('dbt_project.yml')).toBe('');
  });

  it('drops into a folder, or next to a file', () => {
    expect(dropDirFor(dir('models/marts'))).toBe('models/marts');
    expect(dropDirFor(file('models/marts/orders.sql'))).toBe('models/marts');
    expect(dropDirFor(null)).toBe('');
  });
});

describe('isAtOrUnder', () => {
  it('matches the path and its descendants only', () => {
    expect(isAtOrUnder('models/marts', 'models/marts')).toBe(true);
    expect(isAtOrUnder('models/marts/x.sql', 'models/marts')).toBe(true);
    expect(isAtOrUnder('models/marts_v2', 'models/marts')).toBe(false);
    expect(isAtOrUnder('anything', '')).toBe(true);
  });
});

describe('canDropInto', () => {
  it('allows moving into another folder', () => {
    expect(canDropInto(['models/staging/stg_a.sql'], 'models/marts')).toBe(true);
  });

  it('refuses a folder into itself or its subtree', () => {
    expect(canDropInto(['models'], 'models/marts')).toBe(false);
    expect(canDropInto(['models/marts'], 'models/marts')).toBe(false);
  });

  it('refuses a drop where nothing would move', () => {
    expect(canDropInto(['models/marts/orders.sql'], 'models/marts')).toBe(false);
    expect(canDropInto([], 'models')).toBe(false);
  });
});

describe('remapPath', () => {
  const moves = [{ src: 'models/staging', dst: 'models/marts/staging' }];

  it('remaps the moved path and anything under it', () => {
    expect(remapPath('models/staging', moves)).toBe('models/marts/staging');
    expect(remapPath('models/staging/stg_a.sql', moves)).toBe('models/marts/staging/stg_a.sql');
  });

  it('returns null for unaffected paths', () => {
    expect(remapPath('models/staging_old/x.sql', moves)).toBeNull();
  });
});

describe('topLevelPaths', () => {
  it('drops paths inside another selected folder', () => {
    expect(topLevelPaths(['models', 'models/marts/orders.sql', 'dbt_project.yml'])).toEqual(['models', 'dbt_project.yml']);
  });
});

describe('flattenVisible / rangeBetween', () => {
  it('lists rows in display order, skipping collapsed folders', () => {
    expect(flattenVisible(tree).map((r) => [r.node.path, r.depth])).toEqual([
      ['models', 0],
      ['models/marts', 1],
      ['models/staging', 1],
      ['models/staging/stg_a.sql', 2],
      ['models/staging/stg_b.sql', 2],
      ['dbt_project.yml', 0],
    ]);
  });

  it('selects a contiguous range either direction', () => {
    const rows = flattenVisible(tree);
    expect(rangeBetween(rows, 'models/staging/stg_b.sql', 'models/marts')).toEqual([
      'models/marts', 'models/staging', 'models/staging/stg_a.sql', 'models/staging/stg_b.sql',
    ]);
  });

  it('falls back to the target alone when the anchor is gone', () => {
    expect(rangeBetween(flattenVisible(tree), 'gone', 'models')).toEqual(['models']);
  });
});

describe('updateAtPath', () => {
  it('updates a nested node by path without touching others', () => {
    const next = updateAtPath(tree, 'models/marts', (n) => ({ ...n, expanded: true }));
    expect(next[0].children![0].expanded).toBe(true);
    expect(next[0].children![1]).toBe(tree[0].children![1]);
    expect(next[1]).toBe(tree[1]);
    expect(tree[0].children![0].expanded).toBe(false);
  });
});
