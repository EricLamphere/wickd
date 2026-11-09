import { describe, expect, it } from 'vitest';
import type { GraphDto, ModelNode, UnitTestDiffDto } from '../../../lib/api';
import type { UnitTestFocusOption } from '../../../lib/aiApi';
import {
  diffCounts, diffDisplay, enclosingCte, fileChoices, focusFromSelection, resolveFileInput, unitTestBadges, unitTestSelector, unitTestsOf,
} from './unitTests';

const model = { unique_id: 'model.p.orders', name: 'orders' } as ModelNode;

describe('unitTestsOf', () => {
  it('matches by model unique_id, else by name', () => {
    const graph = {
      nodes: [], edges: [],
      unit_tests: [
        { unique_id: 'u1', name: 'a', model: 'orders', original_file_path: null, model_unique_id: 'model.p.orders' },
        { unique_id: 'u2', name: 'b', model: 'orders', original_file_path: null, model_unique_id: 'model.other.orders' },
        { unique_id: 'u3', name: 'c', model: 'orders', original_file_path: null },
        { unique_id: 'u4', name: 'd', model: 'customers', original_file_path: null },
      ],
    } as GraphDto;
    expect(unitTestsOf(graph, model).map((u) => u.unique_id)).toEqual(['u1', 'u3']);
    expect(unitTestsOf(null, model)).toEqual([]);
  });

  it('selects unit tests only', () => {
    expect(unitTestSelector('orders')).toBe('orders,test_type:unit');
  });
});

describe('diffDisplay', () => {
  const diff: UnitTestDiffDto = {
    columns: ['id', 'state'],
    schema_changed: false,
    rows: [
      { status: 'same', expected: ['1', 'done'], actual: ['1', 'done'] },
      { status: 'changed', expected: ['2', 'open'], actual: ['2', null] },
      { status: 'added', expected: null, actual: ['3', 'done'] },
      { status: 'removed', expected: ['4', 'x'], actual: null },
    ],
  };

  it('marks rows and shows changed cells as expected → actual', () => {
    const display = diffDisplay(diff);
    expect(display.columns).toEqual(['', 'id', 'state']);
    expect(display.rows).toEqual([
      ['', '1', 'done'],
      ['≠', '2', 'open → NULL'],
      ['+ actual', '3', 'done'],
      ['− expected', '4', 'x'],
    ]);
    expect(display.classes[1][1]).toBe('');
    expect(display.classes[1][2]).toContain('amber');
    expect(display.classes[2][0]).toContain('emerald');
    expect(display.classes[3][2]).toContain('red');
  });

  it('counts', () => {
    expect(diffCounts(diff)).toEqual({ changed: 1, added: 1, removed: 1 });
  });
});

describe('focusFromSelection', () => {
  const options: UnitTestFocusOption[] = [
    { id: 'cte:joined', label: 'CTE joined', kind: 'cte' },
    { id: 'case:state', label: 'CASE → state', kind: 'case' },
    { id: 'cte:orders_base', label: 'CTE orders_base', kind: 'cte' },
  ];

  it('picks the CASE column a selection aliases', () => {
    expect(focusFromSelection(options, "case when status = 'x' then 1 end as state")).toBe('case:state');
  });

  it('picks the CTE a selection defines', () => {
    expect(focusFromSelection(options, 'orders_base as (\n select * from joined\n)')).toBe('cte:orders_base');
  });

  it('falls back to any name mentioned, else null', () => {
    expect(focusFromSelection(options, 'select * from joined')).toBe('cte:joined');
    expect(focusFromSelection(options, 'select 1')).toBeNull();
    expect(focusFromSelection(options, '   ')).toBeNull();
  });
});

describe('unitTestBadges', () => {
  it('counts per model, failures included, resolving names', () => {
    const graph = {
      nodes: [{ unique_id: 'model.p.orders', name: 'orders', resource_type: 'model' }],
      edges: [],
      unit_tests: [
        { unique_id: 'u1', name: 'a', model: 'orders', original_file_path: null, status: 'error' },
        { unique_id: 'u2', name: 'b', model: 'orders', original_file_path: null, model_unique_id: 'model.p.orders', status: 'success' },
        { unique_id: 'u3', name: 'c', model: 'gone', original_file_path: null },
      ],
    } as unknown as GraphDto;
    expect([...unitTestBadges(graph)]).toEqual([['model.p.orders', { count: 2, failed: 1 }]]);
  });
});

describe('unit test file choice', () => {
  it('resolves what was typed like the backend', () => {
    expect(resolveFileInput('checks', 'models/gold')).toBe('models/gold/checks.yml');
    expect(resolveFileInput(' models/x.yaml ', 'models/gold')).toBe('models/x.yaml');
    expect(resolveFileInput('', 'models')).toBe('');
  });

  it('lists the default, existing files and the remembered one once', () => {
    const options = { default: 'models/a.yml', existing: ['models/a.yml', 'models/b.yml'], files: ['models/a.yml', 'models/b.yml'], model_dir: 'models' };
    expect(fileChoices(options, 'models/new.yml')).toEqual([
      { value: '', label: 'Default · models/a.yml' },
      { value: 'models/b.yml', label: 'models/b.yml · has unit tests' },
      { value: 'models/new.yml', label: 'models/new.yml · last used, new file' },
    ]);
    expect(fileChoices(options, 'models/b.yml')).toHaveLength(2);
    expect(fileChoices(options, null)).toHaveLength(2);
  });
});

describe('focus from the selection\'s position', () => {
  const sql = `with
    customers as (select * from {{ ref('x') }}),
    -- aggregates (per customer)
    ga_per_customer as (
        select customer_id,
            mode () within group (`;

  it('finds the CTE the selection sits in', () => {
    expect(enclosingCte(sql)).toBe('ga_per_customer');
    expect(enclosingCte('with a as (select 1) select ')).toBeNull();
  });

  it('uses it when the selection names nothing', () => {
    const options: UnitTestFocusOption[] = [
      { id: 'cte:customers', label: 'CTE customers', kind: 'cte' },
      { id: 'cte:ga_per_customer', label: 'CTE ga_per_customer', kind: 'cte' },
      { id: 'case:segment', label: 'CASE → segment', kind: 'case' },
    ];
    expect(focusFromSelection(options, 'order by traffic_category) as top_traffic_category', sql)).toBe('cte:ga_per_customer');
    expect(focusFromSelection(options, '', sql)).toBe('cte:ga_per_customer');
    expect(focusFromSelection(options, "case when x then 'a' end as segment", sql)).toBe('case:segment');
  });
});
