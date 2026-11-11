// One place for each project page's name, icon and accent color: the nav rail
// (ProjectNav) and page headers (PageHeader / PageTitle) both read from here, so a
// page's icon and title match everywhere.
import type { ReactNode } from 'react';

export type CurrentPage =
  | 'home' | 'dag' | 'init' | 'files' | 'environment' | 'docs' | 'git'
  | 'workspace' | 'health' | 'runs' | 'metrics' | 'charts';

interface PageMeta {
  label: string;
  /** Text color for the icon in a page header (the nav rail keeps its own colors). */
  accent: string;
  /** The <svg>'s children (24×24 outline icon). */
  glyph: ReactNode;
}

const p = (d: string, extra?: { strokeWidth?: number }) => (
  <path strokeLinecap="round" strokeLinejoin="round" d={d} {...extra} />
);

export const PAGE_META: Record<CurrentPage, PageMeta> = {
  home: {
    label: 'Project home',
    accent: 'text-gray-400',
    glyph: p('M10.5 19.5H6.75A2.25 2.25 0 014.5 17.25V9.457a2.25 2.25 0 01.659-1.591l5.25-5.25a2.25 2.25 0 013.182 0l5.25 5.25c.43.43.659 1.003.659 1.591v7.793A2.25 2.25 0 0117.25 19.5H13.5m-3 0v-6a.75.75 0 01.75-.75h1.5a.75.75 0 01.75.75v6m-3 0h3'),
  },
  environment: {
    label: 'Environment',
    accent: 'text-cyan-400',
    glyph: p('M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418'),
  },
  init: {
    label: 'Initialization',
    accent: 'text-cyan-300',
    glyph: p('M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z'),
  },
  files: {
    label: 'Files',
    accent: 'text-yellow-400',
    glyph: p('M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776'),
  },
  dag: {
    label: 'DAG',
    accent: 'text-violet-400',
    glyph: p('M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zm0 9.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zm9.75-9.75A2.25 2.25 0 0115.75 3.75H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zm0 9.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z'),
  },
  docs: {
    label: 'Docs',
    accent: 'text-sky-400',
    glyph: p('M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25'),
  },
  metrics: {
    label: 'Metrics',
    accent: 'text-emerald-400',
    glyph: p('M3 3v18h18M7.5 15l3.75-4.5 3 3L19.5 7.5'),
  },
  charts: {
    label: 'Charts',
    accent: 'text-teal-400',
    glyph: p('M3.75 3.75h16.5v16.5H3.75zM3.75 9h16.5M9 9v11.25M12 17.25v-3M15 17.25v-5.25M18 17.25V15'),
  },
  workspace: {
    label: 'SQL Workspace',
    accent: 'text-indigo-400',
    glyph: (
      <>
        <ellipse cx="12" cy="5" rx="9" ry="3" strokeLinecap="round" strokeLinejoin="round" />
        {p('M3 5v4c0 1.657 4.03 3 9 3s9-1.343 9-3V5')}
        {p('M3 9v4c0 1.657 4.03 3 9 3s9-1.343 9-3V9')}
        {p('M3 13v4c0 1.657 4.03 3 9 3s9-1.343 9-3v-4')}
      </>
    ),
  },
  runs: {
    label: 'Runs',
    accent: 'text-blue-400',
    glyph: p('M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z'),
  },
  health: {
    label: 'Health',
    accent: 'text-rose-400',
    glyph: (
      <>
        {p('M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z')}
        {p('M3.5 12h3l2-4 3 8 2-4 1 2h3.5')}
      </>
    ),
  },
  git: {
    label: 'Source Control',
    accent: 'text-orange-400',
    glyph: p('M12 5v7m0 0l-3-3m3 3l3-3M6 19a2 2 0 100-4 2 2 0 000 4zm12 0a2 2 0 100-4 2 2 0 000 4zM6 7a2 2 0 100-4 2 2 0 000 4z'),
  },
};

export function PageIcon({ page, className = 'w-4 h-4' }: { page: CurrentPage; className?: string }) {
  return (
    <svg className={`${className} shrink-0`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      {PAGE_META[page].glyph}
    </svg>
  );
}
