import { describe, expect, it } from 'vitest';
import { buildPagesTree, filterPages, foldersOf } from './pageFolders';

const page = (path: string, title: string) => {
  const slash = path.lastIndexOf('/');
  return { path, title, folder: slash === -1 ? '' : path.slice(0, slash) };
};

const pages = [
  page('runbooks/oncall.md', 'On call'),
  page('guides/setup.md', 'Setup'),
  page('guides/README.md', 'Guides'),
  page('guides/deep/joins.md', 'Joins'),
  page('conventions.md', 'Conventions'),
];

describe('buildPagesTree', () => {
  it('nests folders, sorted, with README / index first', () => {
    const tree = buildPagesTree(pages);
    expect(tree.pages.map((p) => p.title)).toEqual(['Conventions']);
    expect(tree.dirs.map((d) => d.key)).toEqual(['guides', 'runbooks']);
    const guides = tree.dirs[0];
    expect(guides.pages.map((p) => p.title)).toEqual(['Guides', 'Setup']);
    expect(guides.dirs.map((d) => [d.key, d.name])).toEqual([['guides/deep', 'deep']]);
  });
});

describe('filterPages', () => {
  it('matches title or path, case-insensitively', () => {
    expect(filterPages(pages, 'ON CALL').map((p) => p.path)).toEqual(['runbooks/oncall.md']);
    expect(filterPages(pages, 'deep/').map((p) => p.path)).toEqual(['guides/deep/joins.md']);
    expect(filterPages(pages, '  ')).toHaveLength(5);
  });
});

describe('foldersOf', () => {
  it('lists the folders containing a page', () => {
    expect(foldersOf('a/b/c.md')).toEqual(['a', 'a/b']);
    expect(foldersOf('c.md')).toEqual([]);
  });
});
