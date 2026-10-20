import { describe, expect, it } from 'vitest';
import type { AiProposalDto } from '../../../../lib/aiApi';
import { findItemLine, proposalItems } from './proposalItems';

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
