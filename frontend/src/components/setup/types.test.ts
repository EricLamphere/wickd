import { describe, expect, it } from 'vitest';
import { defaultRequirementsPath, primaryProjectsFolder } from './types';

describe('projects path helpers', () => {
  it('picks the first listed folder', () => {
    expect(primaryProjectsFolder(' , ~/a/ , ~/b')).toBe('~/a/');
    expect(primaryProjectsFolder('')).toBe('');
  });

  it('suggests requirements.txt in the first folder', () => {
    expect(defaultRequirementsPath('~/a/, ~/b')).toBe('~/a/requirements.txt');
    expect(defaultRequirementsPath('~/one')).toBe('~/one/requirements.txt');
    expect(defaultRequirementsPath('  ')).toBe('');
  });
});
