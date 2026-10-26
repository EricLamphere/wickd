import { describe, expect, it } from 'vitest';
import { restorableDocsView } from './docsLastView';

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
