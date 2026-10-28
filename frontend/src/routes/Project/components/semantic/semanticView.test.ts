import { describe, expect, it } from 'vitest';
import type { SemanticIssue, SemanticStatusDto } from '../../../../lib/semanticApi';
import { groupIssues, statusLine } from './semanticView';

const issue = (over: Partial<SemanticIssue>): SemanticIssue => ({
  level: 'error', message: 'm', object_type: 'metric', object_name: 'revenue', element_type: null, element_name: null, ...over,
});

describe('statusLine', () => {
  it('summarises the environment and counts', () => {
    const status = {
      dbt_core: '1.10.13', adapter_type: 'duckdb', spec: 'legacy',
      counts: { semantic_models: 2, metrics: 1, saved_queries: 0 },
    } as SemanticStatusDto;
    expect(statusLine(status)).toBe('dbt-core 1.10.13 · duckdb · legacy YAML spec · 2 semantic models · 1 metric · 0 saved queries');
    expect(statusLine({ ...status, dbt_core: null, adapter_type: null, spec: 'none' }))
      .toBe('dbt-core not installed · 2 semantic models · 1 metric · 0 saved queries');
  });
});

describe('groupIssues', () => {
  it('groups by object, worst first', () => {
    const groups = groupIssues({
      warnings: [issue({ object_name: 'aaa', message: 'w' })],
      errors: [
        issue({ message: 'e1' }),
        issue({ object_type: 'semantic_model', object_name: 'orders', element_type: 'dimension', element_name: 'Bad X' }),
      ],
      future_errors: [issue({ message: 'f' })],
    });
    expect(groups.map((g) => g.key)).toEqual(['semantic_model:orders', 'metric:revenue', 'metric:aaa']);
    expect(groups[0].issues[0].element).toBe('dimension Bad X');
    expect(groups[1].issues.map((i) => i.severity)).toEqual(['error', 'future_error']);
    expect(groups[2].worst).toBe('warning');
  });

  it('puts issues without an object under the project', () => {
    expect(groupIssues({ errors: [issue({ object_type: null, object_name: null })] })[0].key).toBe('project:');
    expect(groupIssues({})).toEqual([]);
  });
});
