// Compact page header: one 40px bar with the page's icon + title, optional tabs on
// the same row, and a right-aligned slot for page actions. Pages that already have
// a toolbar put <PageTitle> at its left instead, so the title costs no height.
import type { ReactNode } from 'react';
import { PageTabs, type PageTabItem } from '../../../components/PageTabs';
import { PAGE_META, PageIcon, type CurrentPage } from './pageMeta';

/** Icon + page name, for the left end of a page's header or existing toolbar. */
export function PageTitle({ page, meta, className = 'shrink-0' }: { page: CurrentPage; meta?: ReactNode; className?: string }) {
  const { label, accent } = PAGE_META[page];
  return (
    <div className={`flex items-center gap-2 min-w-0 ${className}`}>
      <span className={accent}><PageIcon page={page} /></span>
      <h1 className="text-sm font-semibold text-gray-100 truncate">{label}</h1>
      {meta && <span className="text-xs text-gray-500 whitespace-nowrap">{meta}</span>}
    </div>
  );
}

interface PageHeaderProps<T extends string> {
  page: CurrentPage;
  /** Small muted text after the title (e.g. "120 total"). */
  meta?: ReactNode;
  tabs?: {
    items: readonly PageTabItem<T>[];
    active: T;
    onChange: (id: T) => void;
  };
  /** Right-aligned page actions. */
  children?: ReactNode;
}

export function PageHeader<T extends string>({ page, meta, tabs, children }: PageHeaderProps<T>) {
  return (
    <div className="shrink-0 flex items-stretch gap-4 h-10 px-4 border-b border-gray-800 bg-surface-app">
      <div className="flex items-center">
        <PageTitle page={page} meta={meta} />
      </div>
      {tabs && (
        <>
          <span className="self-center w-px h-4 bg-gray-700" aria-hidden="true" />
          {/* no overflow clipping here: the active tab's underline overlaps the bar's border by 1px */}
          <div className="flex items-end min-w-0">
            <PageTabs tabs={tabs.items} active={tabs.active} onChange={tabs.onChange} />
          </div>
        </>
      )}
      {children && <div className="ml-auto flex items-center gap-2 min-w-0">{children}</div>}
    </div>
  );
}
