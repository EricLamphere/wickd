import { describe, expect, it } from 'vitest';
import { normalizeVarName } from './CapturedVarsEditor';

describe('normalizeVarName', () => {
  it('upper-cases and trims', () => {
    expect(normalizeVarName('  snowflake_user ')).toBe('SNOWFLAKE_USER');
  });

  it('replaces characters that are not valid in an env var name', () => {
    expect(normalizeVarName('my-token.v2')).toBe('MY_TOKEN_V2');
  });

  it('returns empty for blank input', () => {
    expect(normalizeVarName('   ')).toBe('');
  });
});
