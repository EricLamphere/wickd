import { describe, expect, it } from 'vitest';
import type { BreakingChange, ContractCheckDto, ContractConsumers, ContractResult } from '../../../lib/contractsApi';
import {
  breakingBadges, checkMatchesBase, consumerChips, consumerGroups, findingDetail, describeChange, describeFinding, phaseLabel, summarizeCheck, summaryLine,
} from './contractChecks';

const none: ContractConsumers = {
  models: [], row_uses: [], possibly: [], tests: [], exposures: [], semantic_models: [], metrics: [], saved_queries: [],
  dashboards: [], monitors: [],
};

function change(over: Partial<BreakingChange> = {}): BreakingChange {
  return { change: 'removed', column: 'email', severity: 'warning', consumers: none, ...over };
}

function result(over: Partial<ContractResult> = {}): ContractResult {
  return {
    unique_id: 'model.p.dim', name: 'dim', contracted: false, versioned: false, access: null, new_model: false,
    columns_known: true, base_known: true, head_columns: [], base_columns: [], contract_findings: [],
    column_diff: null, breaking_changes: [], severity: 'none', suggestion: null, dbt_state_contract: null, ...over,
  };
}

const used: ContractConsumers = {
  ...none,
  models: [{ unique_id: 'model.p.fct', name: 'fct', columns: ['email'] }],
  tests: [{ unique_id: 'test.p.t', name: 'not_null_dim_email' }],
  semantic_models: [{ unique_id: 'semantic_model.p.c', name: 'customers', fields: [{ kind: 'dimension', name: 'email', uncertain: true }] }],
  metrics: ['customers'],
  dashboards: [{ slug: 'growth', title: 'Growth' }],
  monitors: [{ id: 3, metric: 'customers' }],
};

describe('contractChecks', () => {
  it('describes changes and findings', () => {
    expect(describeChange(change())).toBe('email removed');
    expect(describeChange(change({ change: 'renamed', to: 'email_address' }))).toBe('email → email_address (renamed)');
    expect(describeChange(change({ change: 'retyped', from_type: 'int', to_type: 'text' }))).toBe('email: int → text');
    expect(describeFinding({ kind: 'extra', column: 'x' })).toContain('not in the contract');
    expect(describeFinding({ kind: 'type_mismatch', column: 'id', declared_type: 'int', actual_type: 'text' }))
      .toBe('id is text, the contract says int');
    expect(phaseLabel('compiling_base')).toBe('Compiling the base…');
    expect(phaseLabel(null)).toBe('Checking contracts…');
  });

  it('turns consumers into chips that open the right place', () => {
    const chips = consumerChips(used);
    expect(chips.map((c) => c.kind)).toEqual(['node', 'node', 'node', 'metric', 'dashboard', 'monitor']);
    const semantic = chips[2];
    expect(semantic.kind === 'node' && semantic.uncertain).toBe(true);
    expect(chips[5]).toEqual({ kind: 'monitor', label: 'customers monitor', metric: 'customers', monitorId: 3 });
  });

  it('badges only warning and error models', () => {
    const badges = breakingBadges([
      result({ unique_id: 'a', severity: 'error', breaking_changes: [change({ severity: 'error' }), change({ severity: 'info' })] }),
      result({ unique_id: 'b', severity: 'error', contract_findings: [{ kind: 'missing', column: 'x' }] }),
      result({ unique_id: 'c', severity: 'info', breaking_changes: [change({ severity: 'info' })] }),
    ]);
    expect(badges.get('a')).toEqual({ severity: 'error', text: '1 breaking', title: '1 breaking change' });
    expect(badges.get('b')?.text).toBe('contract');
    expect(badges.has('c')).toBe(false);
  });

  it('summarises breaking changes with distinct consumers', () => {
    const summary = summarizeCheck([
      result({ severity: 'error', breaking_changes: [change({ consumers: used, severity: 'error' }), change({ column: 'name', consumers: used })] }),
      result({ unique_id: 'x', severity: 'error', contract_findings: [{ kind: 'extra', column: 'y' }, { kind: 'unknown_columns' }] }),
    ]);
    expect(summary).toEqual({ breaking: 2, consumers: 6, dashboards: 1, contractProblems: 1, severity: 'error' });
    expect(summaryLine(summary)).toBe('2 breaking changes for 6 consumers, incl. 1 dashboard · 1 contract problem');
    expect(summaryLine(summarizeCheck([result()]))).toBeNull();
  });

  it('matches a stored branch check to the base shown', () => {
    const check = { scope: 'branch', base: 'main' } as ContractCheckDto;
    expect(checkMatchesBase(check, null, 'main')).toBe(true);
    expect(checkMatchesBase(check, 'develop', 'main')).toBe(false);
    expect(checkMatchesBase({ ...check, scope: 'working' }, 'develop', null)).toBe(true);
  });

  it('groups consumers into labelled rows, each node once', () => {
    const groups = consumerGroups({
      ...used,
      row_uses: [{ unique_id: 'model.p.fct', name: 'fct' }],
      possibly: [{ unique_id: 'model.p.py', name: 'py' }],
    });
    expect(groups.map((g) => g.label)).toEqual(['Models', 'Possibly', 'Tests', 'Semantic models', 'Metrics', 'Dashboards', 'Monitors']);
    expect(groups[0].chips.map((c) => c.label)).toEqual(['fct']);
    expect(findingDetail({ kind: 'type_mismatch', column: 'id', declared_type: 'int', actual_type: 'text' }))
      .toBe('is text, the contract says int');
  });
});
