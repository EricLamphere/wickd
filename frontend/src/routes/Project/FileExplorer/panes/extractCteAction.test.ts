import { describe, expect, it } from 'vitest';
import { cteNameAt } from './extractCteAction';

describe('cteNameAt', () => {
  it('prefers a selected identifier, else the word under the cursor', () => {
    expect(cteNameAt(' renamed ', 'other')).toBe('renamed');
    expect(cteNameAt('', 'source')).toBe('source');
  });

  it('rejects anything that is not one identifier', () => {
    expect(cteNameAt('select *', null)).toBeNull();
    expect(cteNameAt('', null)).toBeNull();
  });
});
