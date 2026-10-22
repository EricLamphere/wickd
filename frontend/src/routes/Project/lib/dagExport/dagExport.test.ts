import { describe, expect, it } from 'vitest';
import type { GraphDto, ModelNode } from '../../../../lib/api';
import { applyFilter, defaultFilter, emptyFilter, getAvailableFilters, type FilterState } from '../dagFilter';
import { NODE_HEIGHT, NODE_WIDTH } from '../layout';
import { buildExportHeader, defaultExportFilename, describeFilter, withExtension, type HtmlIncludes } from './config';
import { buildExportData, jsonForScript, pruneLineage, renderDagHtml, toFilterData, type FilterData, type LineageResults } from './html';
import filterScript from './htmlFilter.js?raw';
import { MAX_CANVAS_AREA, MAX_CANVAS_SIDE, pngScale } from './png';
import { SCENE_PADDING, buildScene, projectSceneNodes } from './scene';
import { escapeXml, renderDagSvg, truncate } from './svg';

function model(uid: string, overrides: Partial<ModelNode> = {}): ModelNode {
  return {
    unique_id: uid,
    name: uid.split('.').pop() ?? uid,
    resource_type: 'model',
    schema_: 'analytics',
    database: 'db',
    materialized: 'view',
    tags: [],
    description: '',
    original_file_path: null,
    source_name: null,
    status: 'idle',
    message: null,
    columns: [],
    test_metadata_name: null,
    column_name: null,
    attached_node: null,
    patch_path: null,
    ...overrides,
  };
}

function layoutNode(m: ModelNode, x: number, y: number) {
  return { id: m.unique_id, position: { x, y }, data: { model: m } };
}

const a = model('model.p.a', { columns: [{ name: 'id', data_type: 'int', description: '' } as unknown as ModelNode['columns'][number]] });
const b = model('model.p.b', { status: 'error' });
const c = model('model.p.c');

const scene = buildScene(
  [layoutNode(a, 100, 50), layoutNode(b, 400, 50), layoutNode(c, 400, 200)],
  [{ source: a.unique_id, target: b.unique_id }, { source: a.unique_id, target: 'model.p.gone' }],
  new Map(),
  new Set(),
);

const header = buildExportHeader({
  projectName: 'Jaffle Shop',
  filter: { ...emptyFilter(), selector: 'a+', resourceTypes: new Set(['seed', 'model']) },
  nodeCount: 3,
  edgeCount: 1,
  exportedAt: new Date(2026, 9, 21, 9, 5),
});

describe('describeFilter', () => {
  it('lists every filter, "All" for empty categories', () => {
    expect(describeFilter(defaultFilter())).toEqual([
      { label: 'Selector', value: 'None' },
      { label: 'Types', value: 'exposure, model, seed' },
      { label: 'Materializations', value: 'All' },
      { label: 'Tags', value: 'All' },
      { label: 'Statuses', value: 'All' },
    ]);
  });
});

describe('buildExportHeader', () => {
  it('includes the selector, counts and timestamp', () => {
    expect(header.title).toBe('Jaffle Shop DAG');
    expect(header.subtitle).toBe('Exported from wickd on 2026-10-21 09:05');
    expect(header.rows).toContainEqual({ label: 'Selector', value: 'a+' });
    expect(header.rows).toContainEqual({ label: 'Types', value: 'model, seed' });
    expect(header.rows).toContainEqual({ label: 'Nodes', value: '3 nodes, 1 edges' });
    expect(header.rows.find((r) => r.label === 'Includes')).toBeUndefined();
  });

  it('describes what an HTML export includes', () => {
    const h = buildExportHeader({
      projectName: 'p', filter: emptyFilter(), nodeCount: 0, edgeCount: 0, exportedAt: new Date(),
      includes: { modelLineage: true, columnLineage: false, wholeProject: true },
    });
    expect(h.rows.at(-1)).toEqual({ label: 'Includes', value: 'whole project, model lineage' });
  });
});

describe('filenames', () => {
  it('slugs the project and stamps the date', () => {
    expect(defaultExportFilename('Jaffle Shop!', 'svg', new Date(2026, 0, 2, 3, 4))).toBe('jaffle-shop-dag-20260102-0304.svg');
    expect(defaultExportFilename('***', 'png', new Date(2026, 0, 2, 3, 4))).toBe('project-dag-20260102-0304.png');
  });

  it('swaps the extension to match the format', () => {
    expect(withExtension('dag.svg', 'png')).toBe('dag.png');
    expect(withExtension('my.dag', 'html')).toBe('my.dag.html');
    expect(withExtension('  ', 'svg')).toBe('dag.svg');
  });
});

describe('buildScene', () => {
  it('shifts nodes to the padding and drops edges to missing nodes', () => {
    expect(scene.nodes[0]).toMatchObject({ x: SCENE_PADDING, y: SCENE_PADDING });
    expect(scene.edges).toHaveLength(1);
    expect(scene.width).toBe(300 + NODE_WIDTH + SCENE_PADDING * 2);
    expect(scene.height).toBe(150 + NODE_HEIGHT + SCENE_PADDING * 2);
  });

  it('shows as many columns of expanded nodes as fit, then "+N more"', () => {
    const cols = Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, data_type: null, description: '' }) as unknown as ModelNode['columns'][number]);
    const wide = model('model.p.wide', { columns: cols });
    const s = buildScene([layoutNode(wide, 0, 0)], [], new Map([[wide.unique_id, NODE_HEIGHT + 20 + 150]]), new Set([wide.unique_id]));
    const n = s.nodes[0];
    expect(n.visibleColumns.length + n.hiddenColumnCount).toBe(10);
    expect(n.hiddenColumnCount).toBeGreaterThan(0);
  });

  it('hides columns of collapsed nodes', () => {
    expect(scene.nodes[0].visibleColumns).toEqual([]);
    expect(scene.nodes[0].hiddenColumnCount).toBe(0);
  });

  it('handles an empty graph', () => {
    expect(buildScene([], [], new Map(), new Set()).nodes).toEqual([]);
  });
});

describe('svg', () => {
  it('escapes markup and truncates', () => {
    expect(escapeXml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });

  it('renders a standalone document with the header on top', () => {
    const out = renderDagSvg(scene, header, 'dark');
    expect(out.svg.startsWith('<?xml')).toBe(true);
    expect(out.svg).toContain('Jaffle Shop DAG');
    expect(out.svg).toContain('a+');
    expect(out.svg.match(/class="node"/g)).toHaveLength(3);
    expect(out.svg).toContain('#dc2626'); // error ring on b
    expect(out.height).toBeGreaterThan(scene.height);
    expect(out.width).toBeGreaterThanOrEqual(640);
  });

  it('never emits raw names', () => {
    const evil = model('model.p.x', { name: '<script>alert(1)</script>' });
    const s = buildScene([layoutNode(evil, 0, 0)], [], new Map(), new Set());
    expect(renderDagSvg(s, header, 'light').svg).not.toContain('<script>');
  });
});

describe('pngScale', () => {
  it('is 2x for small graphs', () => {
    expect(pngScale(1000, 800)).toBe(2);
  });

  it('keeps big canvases inside the side and area limits', () => {
    for (const [w, h] of [[30000, 500], [9000, 9000], [500, 40000]]) {
      const k = pngScale(w, h);
      expect(w * k).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
      expect(h * k).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
      expect(w * k * h * k).toBeLessThanOrEqual(MAX_CANVAS_AREA + 1);
    }
  });
});

describe('html export', () => {
  const lineage: LineageResults = {
    [b.unique_id]: { id: [{ node: a.unique_id, column: 'id' }, { node: 'model.p.hidden', column: 'x' }] },
    'model.p.hidden': { y: [{ node: a.unique_id, column: 'id' }] },
  };
  const onScreen = { ...emptyFilter(), selector: 'a+' };
  const subset = (inc: Partial<HtmlIncludes> = {}): HtmlIncludes => ({
    modelLineage: true, columnLineage: true, wholeProject: false, ...inc,
  });

  // The whole project: the scene's 3 nodes plus one that was filtered out on screen
  const hidden = model('model.p.hidden', { columns: [{ name: 'y', data_type: null, description: '' }] as unknown as ModelNode['columns'] });
  const project = {
    nodes: projectSceneNodes([a, b, c, hidden], scene, new Map(), new Set()),
    edges: [{ source: a.unique_id, target: b.unique_id }, { source: a.unique_id, target: hidden.unique_id }],
  };

  it('prunes lineage to the exported nodes on both ends', () => {
    const keep = new Set([a.unique_id, b.unique_id]);
    expect(pruneLineage(lineage, keep)).toEqual({ [b.unique_id]: { id: [[a.unique_id, 'id']] } });
  });

  it('omits lineage unless column lineage is included', () => {
    const base = { scene, lineage, filter: onScreen, project: null };
    expect(buildExportData({ ...base, includes: subset({ columnLineage: false }) }).lineage).toBeNull();
    const data = buildExportData({ ...base, includes: subset() });
    expect(data.lineage).not.toBeNull();
    // b had no catalog columns; lineage contributes them
    expect(data.nodes[b.unique_id].columns).toEqual(['id']);
  });

  it('a subset export holds only the shown nodes and opens unfiltered', () => {
    const data = buildExportData({ scene, lineage, filter: onScreen, project, includes: subset() });
    expect(data.order).toEqual([a.unique_id, b.unique_id, c.unique_id]);
    expect(data.options.wholeProject).toBe(false);
    expect(data.initialFilter.selector).toBe('');
    expect(data.nodes[a.unique_id]).toMatchObject({ x: SCENE_PADDING, y: SCENE_PADDING });
  });

  it('a whole-project export holds every node, opening with the on-screen filter', () => {
    const data = buildExportData({ scene, lineage, filter: onScreen, project, includes: subset({ wholeProject: true }) });
    expect(data.order).toHaveLength(4);
    expect(data.initialFilter).toEqual({ selector: 'a+', resourceTypes: [], materializations: [], tags: [], statuses: [] });
    // filtered-out nodes have no on-screen position; the page lays them out when shown
    expect(data.nodes[hidden.unique_id].x).toBeUndefined();
    expect(data.edges).toContainEqual([a.unique_id, hidden.unique_id]);
    // lineage through the filtered-out node is kept
    expect(data.lineage?.['model.p.hidden']).toEqual({ y: [[a.unique_id, 'id']] });
  });

  it('falls back to a subset when the project graph is missing', () => {
    const data = buildExportData({ scene, lineage, filter: onScreen, project: null, includes: subset({ wholeProject: true }) });
    expect(data.options.wholeProject).toBe(false);
    expect(data.order).toHaveLength(3);
  });

  it('escapes script-closing sequences in inline JSON', () => {
    expect(jsonForScript({ s: '</script><b>' })).not.toContain('</script>');
    expect(JSON.parse(jsonForScript({ s: '</script>\u2028' }))).toEqual({ s: '</script>\u2028' });
  });

  it('renders a self-contained page with the header, filter bar, data and scripts', () => {
    const html = renderDagHtml({
      scene, header, theme: 'light', includes: subset({ wholeProject: true }), lineage, filter: onScreen, project,
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<dt>Selector</dt><dd>a+</dd>');
    expect(html).toContain('id="selector"');
    expect(html).toContain('id="dag-data"');
    expect(html).toContain('traceColumn');
    expect(html).toContain('wickdFilter');
    expect(html).toContain('g.dagre=');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html.match(/class="node"/g)).toHaveLength(4);
  });
});

/** htmlFilter.js runs in the exported page; it must agree with the app's applyFilter. */
describe('html filter parity', () => {
  type RuntimeFilter = {
    apply: (nodes: unknown[], edges: Array<[string, string]>, f: FilterData) => Record<string, true>;
    available: (nodes: unknown[]) => Record<string, string[]>;
  };
  const runtimeFilter = new Function(`${filterScript}\nreturn wickdFilter;`)() as RuntimeFilter;

  const m = (uid: string, o: Partial<ModelNode> = {}) => model(uid, o);
  const graph: GraphDto = {
    nodes: [
      m('seed.p.raw', { resource_type: 'seed', materialized: null, name: 'raw_orders' }),
      m('source.p.app.users', { resource_type: 'source', materialized: null, name: 'users' }),
      m('model.p.stg', { name: 'stg_orders', tags: ['Nightly'], status: 'success' }),
      m('model.p.fct', { name: 'fct_orders', materialized: 'incremental', tags: ['finance'], status: 'error' }),
      m('model.p.dim', { name: 'dim_users', materialized: 'table' }),
      m('exposure.p.dash', { resource_type: 'exposure', materialized: null, name: 'dash' }),
    ],
    edges: [
      { source: 'seed.p.raw', target: 'model.p.stg' },
      { source: 'model.p.stg', target: 'model.p.fct' },
      { source: 'source.p.app.users', target: 'model.p.dim' },
      { source: 'model.p.dim', target: 'model.p.fct' },
      { source: 'model.p.fct', target: 'exposure.p.dash' },
    ],
  };
  const runtimeNodes = graph.nodes.map((n) => ({
    id: n.unique_id, name: n.name, type: n.resource_type, materialized: n.materialized, tags: n.tags, status: n.status,
  }));
  const runtimeEdges = graph.edges.map((e): [string, string] => [e.source, e.target]);

  const cases: Array<[string, FilterState]> = [
    ['nothing', emptyFilter()],
    ['default types', defaultFilter()],
    ['name +upstream', { ...emptyFilter(), selector: '+fct' }],
    ['name downstream+', { ...emptyFilter(), selector: 'stg+' }],
    ['both ways', { ...emptyFilter(), selector: '+dim_users+' }],
    ['tag (case-insensitive, substring)', { ...emptyFilter(), selector: 'tag:night' }],
    ['source', { ...emptyFilter(), selector: 'source:use+' }],
    ['bare type', { ...emptyFilter(), selector: 'seed+' }],
    ['resource_type:', { ...emptyFilter(), selector: 'resource_type:exposure' }],
    ['several tokens', { ...emptyFilter(), selector: 'raw  dash' }],
    ['selector + dropdowns', { ...emptyFilter(), selector: '+fct', resourceTypes: new Set(['model']) }],
    ['materialization', { ...emptyFilter(), materializations: new Set(['incremental', 'table']) }],
    ['tag dropdown (exact)', { ...emptyFilter(), tags: new Set(['finance']) }],
    ['status', { ...emptyFilter(), statuses: new Set(['error', 'success']) }],
    ['no match', { ...emptyFilter(), selector: 'nope' }],
  ];

  it.each(cases)('%s', (_label, filter) => {
    const expected = applyFilter(graph, filter).nodes.map((n) => n.unique_id).sort();
    const actual = Object.keys(runtimeFilter.apply(runtimeNodes, runtimeEdges, toFilterData(filter))).sort();
    expect(actual).toEqual(expected);
  });

  it('offers the same dropdown options', () => {
    expect(runtimeFilter.available(runtimeNodes)).toEqual(getAvailableFilters(graph));
  });
});
