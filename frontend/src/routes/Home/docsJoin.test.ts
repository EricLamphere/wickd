import { describe, expect, it } from 'vitest';
import type { DocsDataDto, DocsMacroDto, DocsNodeDto } from '../../lib/api';
import {
  buildCombinedTrees, buildProjectDocs, docStats, lookupMaps, nodeKey, nodeRefUrl, parseNodeKey, parseNodeRef,
  resolveNodeKey, wickyScopeLabel,
} from './docsJoin';
import { collectMatching, findPathToUid } from '../Project/DocsBrowser/docsTree';

function node(uid: string, over: Partial<DocsNodeDto> = {}): DocsNodeDto {
  const parts = uid.split('.');
  const resource_type = parts[0];
  const name = parts[parts.length - 1];
  return {
    unique_id: uid, name, resource_type, path: `models/${name}.sql`, description: '', database: 'db', schema: 'main',
    ...over,
  } as DocsNodeDto;
}

function macro(uid: string): DocsMacroDto {
  return { unique_id: uid, name: uid.split('.').pop()!, resource_type: 'macro', package_name: uid.split('.')[1], path: 'macros/m.sql' } as DocsMacroDto;
}

function data(project_name: string, nodes: DocsNodeDto[], macros: DocsMacroDto[] = []): DocsDataDto {
  return { project_name, nodes, macros, adapter_type: 'duckdb', project_description: '' };
}

const shop = () => buildProjectDocs(1, 'shop', data('shop', [
  node('model.shop.orders', { description: 'All orders' }),
  node('model.shop.customers'),
  node('source.shop.raw.orders'),
], [macro('macro.shop.cents')]));

const finance = () => buildProjectDocs(2, 'finance', data('finance', [
  // same unique_id as in shop: an installed package, or two projects sharing a name
  node('model.shop.orders'),
  node('model.finance.revenue', { depends_on_nodes: ['model.shop.only_in_shop'] }),
]));

describe('node keys', () => {
  it('round trips, including unique_ids with dots', () => {
    const key = nodeKey(12, 'source.shop.raw.orders');
    expect(parseNodeKey(key)).toEqual({ projectId: 12, uid: 'source.shop.raw.orders' });
  });

  it('accepts a shared docs folder\'s negative id', () => {
    expect(parseNodeKey('-1::page:guide.md')).toEqual({ projectId: -1, uid: 'page:guide.md' });
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'model.shop.orders', 'x::model.a.b', '::model.a.b', '1::', '-::page:a.md', '--1::page:a.md']) {
      expect(parseNodeKey(bad)).toBeNull();
    }
  });
});

describe('buildProjectDocs', () => {
  it('keys tree leaves by project but keeps raw unique_ids in the lookups', () => {
    const docs = shop();
    const models = docs.sections.find((s) => s.resourceType === 'model')!;
    expect(collectMatching(models.tree, 'orders')).toEqual(new Set(['1::model.shop.orders']));
    expect(docs.nodes.get('model.shop.orders')?.unique_id).toBe('model.shop.orders');
    expect(docs.macros.has('macro.shop.cents')).toBe(true);
  });

  it('does not mutate the fetched data', () => {
    const raw = data('shop', [node('model.shop.orders')]);
    buildProjectDocs(1, 'shop', raw);
    expect(raw.nodes[0].unique_id).toBe('model.shop.orders');
  });
});

describe('buildCombinedTrees', () => {
  it('joins projects by database and keeps same-id nodes apart', () => {
    const { databaseTree } = buildCombinedTrees([shop(), finance()]);
    const leaves = collectMatching(databaseTree, 'orders');
    expect(leaves).toEqual(new Set(['1::model.shop.orders', '1::source.shop.raw.orders', '2::model.shop.orders']));
    expect(findPathToUid(databaseTree, '2::model.shop.orders', '')).toEqual(['', '/db', '/db/main']);
  });

  it('labels leaves with their project only when there are several', () => {
    const one = buildCombinedTrees([shop()]).databaseTree;
    const two = buildCombinedTrees([shop(), finance()]).databaseTree;
    expect(collectMatching(one, 'customers · shop').size).toBe(0);
    expect(collectMatching(two, 'customers · shop')).toEqual(new Set(['1::model.shop.customers']));
  });

  it('groups by dbt group across projects', () => {
    const a = buildProjectDocs(1, 'a', data('a', [node('model.a.x', { group: 'sales' } as Partial<DocsNodeDto>)]));
    const b = buildProjectDocs(2, 'b', data('b', [node('model.b.y', { group: 'sales' } as Partial<DocsNodeDto>)]));
    const { groupTree } = buildCombinedTrees([a, b]);
    expect(groupTree.children.map((c) => c.name)).toEqual(['sales']);
    expect(collectMatching(groupTree, 'x').size + collectMatching(groupTree, 'y').size).toBe(2);
  });
});

describe('cross-project references', () => {
  const projects = [shop(), finance()];

  it('prefers the node in the same project when the id exists in both', () => {
    expect(resolveNodeKey(projects, 2, 'model.shop.orders')).toBe('2::model.shop.orders');
  });

  it('follows a ref into another selected project', () => {
    expect(resolveNodeKey(projects, 2, 'model.shop.customers')).toBe('1::model.shop.customers');
  });

  it('stays in the project when no selected project has the node', () => {
    expect(resolveNodeKey(projects, 2, 'model.shop.only_in_shop')).toBe('2::model.shop.only_in_shop');
  });

  it('lookups fill in other projects without overriding the own node', () => {
    const own = node('model.shop.orders', { description: 'finance copy' });
    const copy = buildProjectDocs(2, 'finance', data('finance', [own]));
    const { nodes } = lookupMaps([shop(), copy], 2);
    expect(nodes.get('model.shop.orders')?.description).toBe('finance copy');
    expect(nodes.has('model.shop.customers')).toBe(true);
  });
});

describe('docStats', () => {
  it('counts documented models and sources, ignoring tests and installed packages', () => {
    const stats = docStats(data('shop', [
      node('model.shop.orders', { description: 'yes', package_name: 'shop' }),
      node('model.shop.customers', { package_name: 'shop' }),
      node('source.shop.raw.orders', { description: 'yes', package_name: 'shop' }),
      node('test.shop.not_null', { package_name: 'shop' }),
      node('model.dbt_utils.helper', { package_name: 'dbt_utils' }),
    ]));
    expect(stats).toEqual({ models: 2, sources: 1, tests: 1, described: 2, documentable: 3 });
  });
});

describe('parseNodeRef', () => {
  const names = ['shop', 'my-finance'];

  it('reads project/node, including source names with a dot', () => {
    expect(parseNodeRef('shop/orders', names)).toEqual({ project: 'shop', node: 'orders' });
    expect(parseNodeRef('my-finance/raw.orders', names)).toEqual({ project: 'my-finance', node: 'raw.orders' });
  });

  it('ignores unknown projects and other code', () => {
    for (const text of ['other/orders', 'orders', 'models/orders.sql/x', 'select 1', 'shop/']) {
      expect(parseNodeRef(text, names)).toBeNull();
    }
  });
});

describe('nodeRefUrl', () => {
  const hit = { project_id: 3, unique_id: 'model.shop.orders' };

  it('opens combined docs when the project is selected', () => {
    expect(nodeRefUrl(hit, [3])).toBe('/?tab=docs&node=3%3A%3Amodel.shop.orders');
  });

  it("opens the project's own docs otherwise", () => {
    expect(nodeRefUrl(hit, [1])).toBe('/projects/3/docs?node=model.shop.orders');
  });
});

describe('wickyScopeLabel', () => {
  it('names what Wicky can see', () => {
    expect(wickyScopeLabel(0)).toBe('All projects');
    expect(wickyScopeLabel(1)).toBe('1 project');
    expect(wickyScopeLabel(4)).toBe('4 projects');
  });
});
