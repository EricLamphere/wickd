import { describe, expect, it } from 'vitest';
import {
  buildNodeResolver, extractHeadings, normalizePath, parseInlineRef, resolveImage, resolveLink, type LinkContext,
} from './docsPageLinks';

const resolveNode = buildNodeResolver([
  { unique_id: 'model.shop.orders', name: 'orders', resource_type: 'model' },
  { unique_id: 'source.shop.raw.orders', name: 'orders', resource_type: 'source' },
  { unique_id: 'test.shop.not_null', name: 'not_null', resource_type: 'test' },
]);

const page: LinkContext = { base: 'docs', dir: 'guides', docsDir: 'docs', docsInProject: true, resolveNode };
const readme: LinkContext = { base: 'project', dir: '', docsDir: 'docs', docsInProject: true, resolveNode };

describe('normalizePath', () => {
  it('resolves dots and refuses climbing above the root', () => {
    expect(normalizePath('a/b', '../c.md')).toBe('a/c.md');
    expect(normalizePath('', './x/./y')).toBe('x/y');
    expect(normalizePath('a', '../../x')).toBeNull();
  });
});

describe('resolveLink', () => {
  it('routes relative pages with anchors', () => {
    expect(resolveLink('../setup.md#install-dbt', page)).toEqual({ kind: 'page', path: 'setup.md', anchor: 'install-dbt' });
    expect(resolveLink('deep/x.markdown', page)).toEqual({ kind: 'page', path: 'guides/deep/x.markdown', anchor: null });
    expect(resolveLink('/index.md', page)).toEqual({ kind: 'page', path: 'index.md', anchor: null });
  });

  it('handles anchors, externals and empty links', () => {
    expect(resolveLink('#on-this-page', page)).toEqual({ kind: 'anchor', id: 'on-this-page' });
    expect(resolveLink('https://docs.getdbt.com', page)).toEqual({ kind: 'external', href: 'https://docs.getdbt.com' });
    expect(resolveLink('mailto:a@b.co', page)).toEqual({ kind: 'external', href: 'mailto:a@b.co' });
    expect(resolveLink('', page)).toEqual({ kind: 'none' });
    expect(resolveLink('../../escape.md', page)).toEqual({ kind: 'none' });
  });

  it('links refs and sources to node docs', () => {
    expect(resolveLink('ref:orders', page)).toEqual({ kind: 'node', uid: 'model.shop.orders' });
    expect(resolveLink('ref:shop.orders', page)).toEqual({ kind: 'node', uid: 'model.shop.orders' });
    expect(resolveLink('source:raw.orders', page)).toEqual({ kind: 'node', uid: 'source.shop.raw.orders' });
    expect(resolveLink('ref:missing', page)).toEqual({ kind: 'unresolved_node', label: 'ref:missing' });
    expect(resolveLink('ref:not_null', page)).toEqual({ kind: 'unresolved_node', label: 'ref:not_null' });
  });

  it('opens non-page docs files in Files only when the folder is in the project', () => {
    expect(resolveLink('../data/a.csv', page)).toEqual({ kind: 'file', path: 'docs/data/a.csv' });
    expect(resolveLink('a.csv', { ...page, docsInProject: false, docsDir: '../docs' })).toEqual({ kind: 'none' });
  });

  it('maps README links into the docs folder, other files to Files', () => {
    expect(resolveLink('docs/guides/setup.md#a', readme)).toEqual({ kind: 'page', path: 'guides/setup.md', anchor: 'a' });
    expect(resolveLink('CONTRIBUTING.md', readme)).toEqual({ kind: 'file', path: 'CONTRIBUTING.md' });
    expect(resolveLink('models/orders.sql', readme)).toEqual({ kind: 'file', path: 'models/orders.sql' });
    expect(resolveLink('../docs/a.md', { ...readme, docsDir: '../docs' })).toEqual({ kind: 'none' });
  });
});

describe('resolveImage', () => {
  it('resolves local images relative to the document', () => {
    expect(resolveImage('../img/a b.png', page)).toEqual({ src: '', local: { root: 'docs', path: 'img/a b.png' } });
    expect(resolveImage('img/logo.svg?raw=1', readme)).toEqual({ src: '', local: { root: 'project', path: 'img/logo.svg' } });
    expect(resolveImage('../../x.png', page)).toBeNull();
  });

  it('passes web images through and drops other schemes', () => {
    expect(resolveImage('https://img.shields.io/x.svg', readme)).toEqual({ src: 'https://img.shields.io/x.svg', local: null });
    expect(resolveImage('javascript:alert(1)', readme)).toBeNull();
  });
});

describe('parseInlineRef', () => {
  it('reads ref and source calls', () => {
    expect(parseInlineRef("ref('orders')")).toEqual({ kind: 'ref', name: 'orders' });
    expect(parseInlineRef('ref("shop", "orders")')).toEqual({ kind: 'ref', name: 'orders' });
    expect(parseInlineRef("source('raw', 'orders')")).toEqual({ kind: 'source', name: 'raw.orders' });
    expect(parseInlineRef("source('raw')")).toBeNull();
    expect(parseInlineRef('select 1')).toBeNull();
  });
});

describe('extractHeadings', () => {
  it('slugs like rehype-slug, skipping code fences', () => {
    const md = '# Title\n\n## Setup `dbt`\n```\n## not a heading\n```\n## Setup dbt\n### [Link](x.md) **bold**\n';
    expect(extractHeadings(md)).toEqual([
      { depth: 1, text: 'Title', id: 'title' },
      { depth: 2, text: 'Setup dbt', id: 'setup-dbt' },
      { depth: 2, text: 'Setup dbt', id: 'setup-dbt-1' },
      { depth: 3, text: 'Link bold', id: 'link-bold' },
    ]);
  });
});
