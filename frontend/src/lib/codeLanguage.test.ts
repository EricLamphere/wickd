import { describe, expect, it } from 'vitest';
import { fenceLanguage, resolveMonacoLanguage } from './codeLanguage';

const languages = [
  { id: 'sql', aliases: ['SQL'], extensions: ['.sql'] },
  { id: 'yaml', aliases: ['YAML', 'yml'], extensions: ['.yaml', '.yml'] },
  { id: 'shell', aliases: ['Shell', 'sh'], extensions: ['.sh', '.bash'] },
  { id: 'python', aliases: ['Python', 'py'], extensions: ['.py'] },
  { id: 'graphql', aliases: ['GraphQL'], extensions: ['.graphql', '.gql'] },
  { id: 'ini', aliases: ['Ini'], extensions: ['.ini', '.properties', '.gitconfig'] },
];

describe('resolveMonacoLanguage', () => {
  it('matches ids, aliases and extensions case-insensitively', () => {
    expect(resolveMonacoLanguage('sql', languages)).toBe('sql');
    expect(resolveMonacoLanguage('YAML', languages)).toBe('yaml');
    expect(resolveMonacoLanguage('graphql', languages)).toBe('graphql');
    expect(resolveMonacoLanguage('properties', languages)).toBe('ini');
  });

  it('maps common fence names Monaco lacks', () => {
    expect(resolveMonacoLanguage('bash', languages)).toBe('shell');
    expect(resolveMonacoLanguage('yml', languages)).toBe('yaml');
    expect(resolveMonacoLanguage('jinja', languages)).toBe('sql');
    expect(resolveMonacoLanguage('py', languages)).toBe('python');
    expect(resolveMonacoLanguage('gql', languages)).toBe('graphql');
  });

  it('leaves plain and unknown fences unhighlighted', () => {
    expect(resolveMonacoLanguage('text', languages)).toBeNull();
    expect(resolveMonacoLanguage(null, languages)).toBeNull();
    expect(resolveMonacoLanguage('', languages)).toBeNull();
    expect(resolveMonacoLanguage('brainfuck', languages)).toBeNull();
  });
});

describe('fenceLanguage', () => {
  it('reads the language-xxx class', () => {
    expect(fenceLanguage('language-sql')).toBe('sql');
    expect(fenceLanguage('hljs language-c++')).toBe('c++');
    expect(fenceLanguage(undefined)).toBeNull();
    expect(fenceLanguage('foo')).toBeNull();
  });
});
