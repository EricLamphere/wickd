import { describe, expect, it } from 'vitest';
import type { TagFlowDto } from '../../../lib/propagationApi';
import { dagSelection, pathText, tagFlowCounts, tagFlowRows } from './tagFlow';

const FLOW: TagFlowDto = {
  tag: 'pii',
  tags: ['pii'],
  exposures: [],
  columns: [
    { unique_id: 'model.p.mart', name: 'mart', resource_type: 'model', column: 'email_hash', declared: false,
      via_kind: 'derived', path: [
        { node: 'source.p.raw.users', column: 'email' },
        { node: 'model.p.stg', column: 'mail', kind: 'rename' },
        { node: 'model.p.mart', column: 'email_hash', kind: 'derived' },
      ] },
    { unique_id: 'source.p.raw.users', name: 'users', resource_type: 'source', column: 'email', declared: true,
      via_kind: null, path: [{ node: 'source.p.raw.users', column: 'email' }] },
    { unique_id: 'model.p.stg', name: 'stg', resource_type: 'model', column: 'mail', declared: false,
      via_kind: 'rename', path: [
        { node: 'source.p.raw.users', column: 'email' },
        { node: 'model.p.stg', column: 'mail', kind: 'rename' },
      ] },
  ],
};

describe('tag flow view', () => {
  it('orders rows declared → inherited → derived', () => {
    expect(tagFlowRows(FLOW)).toEqual([
      ['users', 'email', 'source', 'Declared', ''],
      ['stg', 'mail', 'model', 'Inherited', 'users.email → stg.mail (renamed)'],
      ['mart', 'email_hash', 'model', 'Derived', 'users.email → stg.mail (renamed) → mart.email_hash (derived)'],
    ]);
  });

  it('counts by status', () => {
    expect(tagFlowCounts(FLOW)).toEqual({ Declared: 1, Inherited: 1, Derived: 1 });
  });

  it('identity hops are unlabelled', () => {
    expect(pathText([{ node: 'a.b', column: 'x' }, { node: 'a.c', column: 'x', kind: 'identity' }])).toBe('b.x → c.x');
  });

  it('selects every reached column in the DAG', () => {
    expect(dagSelection(FLOW)).toEqual({
      columnKeys: ['model.p.mart::email_hash', 'source.p.raw.users::email', 'model.p.stg::mail'],
      expanded: ['model.p.mart', 'source.p.raw.users', 'model.p.stg'],
    });
  });
});
