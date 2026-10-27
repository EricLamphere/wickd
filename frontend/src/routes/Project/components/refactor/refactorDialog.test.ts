import { describe, expect, it } from 'vitest';
import { nameProblem, refactorPrompt } from './refactorDialog';

describe('refactor dialog', () => {
  it('starts from the current name, or model_cte for an extract', () => {
    expect(refactorPrompt({ op: 'rename_model', uniqueId: 'm', model: 'stg' }).initial).toBe('stg');
    expect(refactorPrompt({ op: 'rename_column', uniqueId: 'm', model: 'stg', column: 'id' }).initial).toBe('id');
    expect(refactorPrompt({ op: 'extract_cte', uniqueId: 'm', model: 'stg', cte: 'base' }).initial).toBe('stg_base');
  });

  it('checks new names', () => {
    expect(nameProblem('  ', 'a')).toBe('Enter a name.');
    expect(nameProblem('1x', 'a')).toMatch(/letters/);
    expect(nameProblem('a', 'a')).toMatch(/current name/);
    expect(nameProblem(' b_1 ', 'a')).toBeNull();
  });
});
