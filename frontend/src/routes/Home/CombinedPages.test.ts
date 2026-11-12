import { describe, expect, it } from 'vitest';
import { isKnownPageKey, type ProjectPages } from './CombinedPages';

const pages: ProjectPages[] = [{
  projectId: 3,
  name: 'jaffle',
  list: { dir: 'docs', in_project: true, setting: '', pages: [{ path: 'guide/intro.md', title: 'Intro', folder: 'guide' }] },
}];

describe('isKnownPageKey', () => {
  it('accepts a page in its own project', () => {
    expect(isKnownPageKey(pages, '3::page:guide/intro.md')).toBe(true);
  });

  it('rejects other projects, missing pages and node keys', () => {
    expect(isKnownPageKey(pages, '4::page:guide/intro.md')).toBe(false);
    expect(isKnownPageKey(pages, '3::page:missing.md')).toBe(false);
    expect(isKnownPageKey(pages, '3::model.jaffle.orders')).toBe(false);
    expect(isKnownPageKey(pages, 'page:guide/intro.md')).toBe(false);
  });
});
