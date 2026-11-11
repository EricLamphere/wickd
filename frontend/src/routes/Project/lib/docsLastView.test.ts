import { describe, expect, it } from 'vitest';
import { pageNodeId, pagePathOf, restorableDocsView } from './docsLastView';

const exists = (uid: string) => uid === 'model.p.orders';

describe('restorableDocsView', () => {
  it('restores a remembered node with its tabs', () => {
    const view = restorableDocsView('node=model.p.orders&browse=database&view=code', exists);
    expect(view?.toString()).toBe('node=model.p.orders&browse=database&view=code');
  });

  it('restores the project overview', () => {
    expect(restorableDocsView('node=__project__&browse=project', exists)?.get('node')).toBe('__project__');
  });

  it('ignores a node that no longer exists', () => {
    expect(restorableDocsView('node=model.p.gone&view=code', exists)).toBeNull();
  });

  it('ignores nothing remembered, or nothing usable remembered', () => {
    expect(restorableDocsView(null, exists)).toBeNull();
    expect(restorableDocsView('browse=database', exists)).toBeNull();
  });

  it('keeps only the docs params', () => {
    expect(restorableDocsView('node=model.p.orders&other=1', exists)?.toString()).toBe('node=model.p.orders');
  });
});

describe('page node ids', () => {
  it('round-trips a page path', () => {
    expect(pageNodeId('guides/setup.md')).toBe('page:guides/setup.md');
    expect(pagePathOf('page:guides/setup.md')).toBe('guides/setup.md');
    expect(pagePathOf('page:')).toBeNull();
    expect(pagePathOf('model.p.orders')).toBeNull();
    expect(pagePathOf(null)).toBeNull();
  });

  it('restores a page while it still exists', () => {
    const pages = new Set(['page:index.md']);
    expect(restorableDocsView('node=page:index.md&browse=pages', (n) => pages.has(n))?.toString()).toBe('node=page%3Aindex.md&browse=pages');
    expect(restorableDocsView('node=page:gone.md&browse=pages', (n) => pages.has(n))).toBeNull();
  });
});
