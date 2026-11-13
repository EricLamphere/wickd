import { describe, expect, it } from 'vitest';
import { docsPagesApi, sharedFolderOf, sharedSourceId } from '../../lib/docsPagesApi';
import { isKnownPageKey, sharedFolderPages, type ProjectPages } from './CombinedPages';

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

describe('shared docs folders', () => {
  const folder = { id: 0, name: 'dbt/docs', path: '/work/dbt/docs', pages: [{ path: 'handbook.md', title: 'Handbook', folder: '' }] };

  it('become a Pages entry under a negative id', () => {
    const entry = sharedFolderPages(folder);
    expect(entry).toEqual({
      projectId: -1,
      name: 'dbt/docs',
      list: { dir: '/work/dbt/docs', in_project: false, setting: '', pages: folder.pages },
      shared: true,
    });
    expect(isKnownPageKey([...pages, entry], '-1::page:handbook.md')).toBe(true);
    expect(isKnownPageKey([...pages, entry], '-2::page:handbook.md')).toBe(false);
  });
});

describe('docsPagesApi source ids', () => {
  it('maps shared folders to negative ids and back', () => {
    expect(sharedSourceId(0)).toBe(-1);
    expect(sharedSourceId(3)).toBe(-4);
    expect(sharedFolderOf(-4)).toBe(3);
    expect(sharedFolderOf(7)).toBeNull();
  });

  it('sends shared folder assets to the workspace route', () => {
    expect(docsPagesApi.assetUrl(-2, 'img/a b.png', 'docs')).toBe('/api/workspace/docs-pages/1/asset?path=img%2Fa%20b.png');
    expect(docsPagesApi.assetUrl(5, 'img/a.png', 'docs')).toBe('/api/projects/5/docs-pages/asset?path=img%2Fa.png&root=docs');
  });
});
