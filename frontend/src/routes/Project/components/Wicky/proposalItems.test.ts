import { describe, expect, it } from 'vitest';
import type { AiProposalDto } from '../../../../lib/aiApi';
import { findItemLine, itemsInFile, proposalItems } from './proposalItems';

const YAML = `version: 2
models:
  - name: orders
    description: One row per order.
    columns:
      - name: id
        description: Key.
        data_tests:
          - unique
          - not_null
      - name: status
        data_tests:
          - accepted_values:
              values: ["a"]
  - name: id
`;

function proposal(kind: string, result: Partial<AiProposalDto['result']>): AiProposalDto {
  return {
    id: 1, kind, unique_id: 'model.p.orders', title: '', status: 'ready', error_message: null, created_at: '',
    result: { description: null, columns: {}, tests: [], selected: null, accepted: [], ...result }, files: [],
  };
}

describe('findItemLine', () => {
  it('finds tests under their column', () => {
    const p = proposal('tests', { tests: [
      { key: 't0', column: 'id', test: 'not_null', reason: '' },
      { key: 't1', column: 'status', test: 'accepted_values', reason: '' },
      { key: 't2', column: 'status', test: 'unique', reason: '' },
    ] });
    const [notNull, accepted, missing] = proposalItems(p);
    expect(findItemLine(YAML, p, notNull)).toBe(10);
    expect(findItemLine(YAML, p, accepted)).toBe(13);
    expect(findItemLine(YAML, p, missing)).toBeNull();
  });

  it('finds the model description, not a column one', () => {
    const p = proposal('document', { description: 'One row per order.', columns: { id: 'Key.' } });
    const [model, id] = proposalItems(p);
    expect(findItemLine(YAML, p, model)).toBe(4);
    expect(findItemLine(YAML, p, id)).toBe(7);
  });
});

describe('propagate proposals', () => {
  const MULTI = `version: 2
models:
  - name: stg
    columns:
      - name: id
        description: Stg key.
  - name: mart
    columns:
      - name: id
        description: Mart key.
      - name: email
        tags: [pii]
`;
  const p = proposal('propagate', {
    items: [
      { key: 'description:model.p.mart:id', field: 'description', unique_id: 'model.p.mart', column: 'id',
        file: 'models/schema.yml', name: 'mart', value: 'Mart key.', source: { node: 'model.p.stg', column: 'id' },
        kind: 'rename' },
      { key: 'tags:model.p.mart:email', field: 'tags', unique_id: 'model.p.mart', column: 'email',
        file: 'models/schema.yml', name: 'mart', tags: ['pii'], via_kind: { pii: 'derived' } },
      { key: 'description:model.p.other:id', field: 'description', unique_id: 'model.p.other', column: 'id',
        file: 'models/other.yml', name: 'other', value: 'x' },
    ],
  });

  it('lists items per file with where they came from', () => {
    const items = proposalItems(p);
    expect(items[0]).toMatchObject({ title: 'mart.id', detail: 'Mart key. ← stg.id (renamed)', file: 'models/schema.yml' });
    expect(items[1].detail).toBe('+pii (derived)');
    expect(itemsInFile(items, 'models/schema.yml').map((i) => i.key)).toEqual([items[0].key, items[1].key]);
  });

  it('finds the column inside its own node, not a same-named column elsewhere', () => {
    const [description, tags, missing] = proposalItems(p);
    expect(findItemLine(MULTI, p, description)).toBe(10);
    expect(findItemLine(MULTI, p, tags)).toBe(12);
    expect(findItemLine(MULTI, p, missing)).toBeNull();
  });
});
