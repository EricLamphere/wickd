import { describe, expect, it } from 'vitest';
import type { BoardBuild, ChartBoard, ChartsDiagnostic } from '../../../lib/chartsApi';
import { boardIssues, buildLabel, groupByFolder, issueCounts, liveBoardUrl, pickBoard } from './chartsView';

const board = (id: string, error: string | null = null): ChartBoard => ({
  id, path: `charts/${id}.yml`, url_path: id, title: id, chart_count: 1, error, build: null, building: false,
});

const diag = (code: string, level: string, message = code): ChartsDiagnostic => ({
  code, level, message, hint: null, chart: null, query: null, line: null,
});

const build = (over: Partial<BoardBuild> = {}): BoardBuild => ({
  ok: true, built_at: '2026-11-03T12:00:00Z', target: 'dev', elapsed_ms: 2900, diagnostics: [], error: null, has_output: true, ...over,
});

describe('pickBoard', () => {
  const boards = [board('broken', 'bad yaml'), board('sales'), board('team/ops')];
  it('prefers the requested, then the remembered, then the first valid board', () => {
    expect(pickBoard(boards, 'team/ops', 'sales')).toBe('team/ops');
    expect(pickBoard(boards, 'gone', 'sales')).toBe('sales');
    expect(pickBoard(boards, null, 'gone')).toBe('sales');
  });
  it('falls back to an invalid board, or nothing', () => {
    expect(pickBoard([board('broken', 'x')], null, null)).toBe('broken');
    expect(pickBoard([], 'a', 'b')).toBeNull();
  });
});

describe('liveBoardUrl', () => {
  it('serves boards as folders', () => {
    expect(liveBoardUrl('http://127.0.0.1:5000', 'team/ops')).toBe('http://127.0.0.1:5000/team/ops/');
    expect(liveBoardUrl('http://127.0.0.1:5000/', '/sales/')).toBe('http://127.0.0.1:5000/sales/');
    expect(liveBoardUrl('http://127.0.0.1:5000', '')).toBe('http://127.0.0.1:5000/');
  });
});

describe('boardIssues', () => {
  it('orders errors first and drops duplicates', () => {
    const issues = boardIssues(
      { ok: false, errors: [diag('ERR-A', 'error')], warnings: [diag('WARN-B', 'warning')] },
      build({ diagnostics: [diag('WARN-B', 'warning'), diag('ERR-C', 'error')] }),
    );
    expect(issues.map((d) => d.code)).toEqual(['ERR-A', 'ERR-C', 'WARN-B']);
    expect(issueCounts(issues)).toEqual({ errors: 2, warnings: 1 });
  });
  it('handles nothing known yet', () => {
    expect(boardIssues(undefined, null)).toEqual([]);
  });
});

describe('buildLabel', () => {
  it('says when, where and how long', () => {
    expect(buildLabel(build(), new Date('2026-11-03T12:00:20Z'))).toBe('Built just now on dev in 2.9 s');
    expect(buildLabel(build({ ok: false, target: null, elapsed_ms: 300 }), new Date('2026-11-03T12:05:00Z')))
      .toBe('Build failed 5 min ago in 300 ms');
  });
});

describe('groupByFolder', () => {
  it('puts root boards first, then folders by name', () => {
    const groups = groupByFolder([board('z/one'), board('sales'), board('a/two'), board('a/three')]);
    expect(groups.map((g) => [g.folder, g.boards.map((b) => b.id)])).toEqual([
      ['', ['sales']], ['a', ['a/two', 'a/three']], ['z', ['z/one']],
    ]);
  });
});
