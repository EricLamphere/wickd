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

export const docsPagesApi = {
  list: (projectId: number) => get<DocsPagesListDto>(`/projects/${projectId}/docs-pages`),
  content: (projectId: number, path: string) =>
    get<DocsPageContentDto>(`/projects/${projectId}/docs-pages/content?path=${encodeURIComponent(path)}`),
  /** URL for an <img src>; images are loaded by the browser, not through fetch. */
  assetUrl: (projectId: number, path: string, root: AssetRoot) =>
    `/api/projects/${projectId}/docs-pages/asset?path=${encodeURIComponent(path)}&root=${root}`,
};
