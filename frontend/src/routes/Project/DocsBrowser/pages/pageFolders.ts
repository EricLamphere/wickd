// Folder tree of docs pages for the Pages tab. Pure; tested in pageFolders.test.ts.
import type { DocsPageDto } from '../../../../lib/docsPagesApi';

export interface PageDir {
  key: string; // folder path ('' for the root), used as the expanded-set key
  name: string;
  dirs: PageDir[];
  pages: DocsPageDto[];
}

export function filterPages(pages: readonly DocsPageDto[], query: string): DocsPageDto[] {
  const q = query.toLowerCase().trim();
  if (!q) return [...pages];
  return pages.filter((p) => p.title.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
}

function sortDir(dir: PageDir): PageDir {
  return {
    ...dir,
    dirs: dir.dirs.map(sortDir).sort((a, b) => a.name.localeCompare(b.name)),
    pages: [...dir.pages].sort((a, b) => pageRank(a) - pageRank(b) || a.title.localeCompare(b.title)),
  };
}

/** README / index pages lead their folder. */
function pageRank(page: DocsPageDto): number {
  const file = page.path.split('/').pop()?.toLowerCase() ?? '';
  return /^(readme|index)\.(md|markdown)$/.test(file) ? 0 : 1;
}

export function buildPagesTree(pages: readonly DocsPageDto[]): PageDir {
  const root: PageDir = { key: '', name: '', dirs: [], pages: [] };
  const byKey = new Map<string, PageDir>([['', root]]);
  const dirFor = (folder: string): PageDir => {
    const existing = byKey.get(folder);
    if (existing) return existing;
    const slash = folder.lastIndexOf('/');
    const parent = dirFor(slash === -1 ? '' : folder.slice(0, slash));
    const dir: PageDir = { key: folder, name: folder.slice(slash + 1), dirs: [], pages: [] };
    parent.dirs.push(dir);
    byKey.set(folder, dir);
    return dir;
  };
  for (const page of pages) dirFor(page.folder).pages.push(page);
  return sortDir(root);
}

/** Folder keys to open so a page is visible ('a/b/c.md' → ['a', 'a/b']). */
export function foldersOf(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}
