import { describe, expect, it } from 'vitest';
import { detectExports, normalizeVarName } from './capturedVars';

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

describe('detectExports', () => {
  it('finds exported names in order, once each', () => {
    const script = 'export TOKEN=abc\necho hi\n  export USER_NAME="a b"\nexport TOKEN=again\n';
    expect(detectExports(script)).toEqual(['TOKEN', 'USER_NAME']);
  });

  it('handles bare exports and several per line', () => {
    expect(detectExports('FOO=1\nexport FOO\nexport A=1 B=2')).toEqual(['FOO', 'A', 'B']);
  });

  it('ignores comments, flags and non-export lines', () => {
    const script = '# export HIDDEN=1\nexport -p\necho export NOT_THIS=1\nexport KEEP=1 # export NOPE=2';
    expect(detectExports(script)).toEqual(['KEEP']);
  });

  it('stops after a quoted value that may contain spaces', () => {
    expect(detectExports('export MSG="hello WORLD=1"')).toEqual(['MSG']);
  });
});
