// Typed helpers for Markdown docs pages (Base; plan 28): the project's docs folder
// (DOCS_PATH, default docs/ or the repo root's docs/) shown on the Docs page's Pages tab.
// Mirrors backend/app/api/docs_pages.py.
import { get } from './api';

export interface DocsPageDto {
  path: string; // relative to the docs folder
  title: string;
  folder: string;
}

export interface DocsPagesListDto {
  dir: string | null; // relative to the project root; null = no docs folder
  in_project: boolean;
  setting: string;
  pages: DocsPageDto[];
}

export interface DocsPageSegmentDto {
  kind: 'markdown' | 'docs_block';
  text: string;
  name: string | null;
  used_by: string[];
}

export interface DocsPageContentDto {
  path: string;
  title: string;
  text: string;
  segments: DocsPageSegmentDto[];
  mtime: string;
  project_path: string | null;
}

/** Where an image path is resolved from: the docs folder, or the project root (README). */
export type AssetRoot = 'docs' | 'project';

/** A WICKD_SHARED_DOCS_PATHS folder: Markdown outside any project, for combined docs. */
export interface SharedDocsFolderDto {
  id: number; // position in the setting
  name: string; // "<parent>/<folder>"
  path: string;
  pages: DocsPageDto[];
}

/**
 * Combined docs address a shared folder's pages like a project's, with a negative id in the
 * project's place (folder 0 → -1), so page keys, selection and PageDetail work unchanged.
 * These helpers send those ids to the workspace routes.
 */
export function sharedSourceId(folderId: number): number {
  return -(folderId + 1);
}

export function sharedFolderOf(sourceId: number): number | null {
  return sourceId < 0 ? -sourceId - 1 : null;
}

const enc = encodeURIComponent;

export const docsPagesApi = {
  list: (projectId: number) => get<DocsPagesListDto>(`/projects/${projectId}/docs-pages`),
  /** A project's page, or (negative id) a shared folder's. */
  content: (sourceId: number, path: string) => {
    const folder = sharedFolderOf(sourceId);
    return get<DocsPageContentDto>(folder === null
      ? `/projects/${sourceId}/docs-pages/content?path=${enc(path)}`
      : `/workspace/docs-pages/${folder}/content?path=${enc(path)}`);
  },
  /** URL for an <img src>; images are loaded by the browser, not through fetch. */
  assetUrl: (sourceId: number, path: string, root: AssetRoot) => {
    const folder = sharedFolderOf(sourceId);
    return folder === null
      ? `/api/projects/${sourceId}/docs-pages/asset?path=${enc(path)}&root=${root}`
      : `/api/workspace/docs-pages/${folder}/asset?path=${enc(path)}`;
  },
  shared: () => get<{ folders: SharedDocsFolderDto[] }>('/workspace/docs-pages'),
};
