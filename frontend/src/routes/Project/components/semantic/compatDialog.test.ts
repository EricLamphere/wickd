import { describe, expect, it } from 'vitest';
import {
  compareVersions, defaultChoice, describeChange, dialogTitle, groupChanges, labelFor, otherVersionError, versionOptions,
} from './compatDialog';

const CANDIDATES = ['1.7.20', '1.8.10', '1.9.11', '1.10.23', '1.11.16', '1.12.6'];

describe('labels and options', () => {
  it('orders versions numerically', () => {
    expect(compareVersions('1.10.2', '1.9.11')).toBeGreaterThan(0);
    expect(compareVersions('1.12.6', '1.12.6')).toBe(0);
  });

  it('labels closest, latest and older', () => {
    expect(labelFor('1.10.23', '1.10.2', CANDIDATES, '1.10.23')).toBe('1.10.23 — closest, same minor');
    expect(labelFor('1.12.6', '1.10.2', CANDIDATES, '1.10.23')).toBe('1.12.6 — latest');
    expect(labelFor('1.9.11', '1.10.2', CANDIDATES, '1.10.23')).toBe('1.9.11 — older');
    expect(labelFor('1.11.16', '1.10.2', CANDIDATES, '1.10.23')).toBe('1.11.16');
    expect(labelFor('1.12.6', '1.11.16', ['1.12.6'], '1.12.6')).toBe('1.12.6 — closest, latest');
  });

  it('lists candidates newest first with the recommendation preselected', () => {
    const options = versionOptions({
      dbt_core: '1.10.2', compatible_dbt_versions: CANDIDATES, recommended_version: '1.10.23', reason_code: 'no_cli_release',
    });
    expect(options.map((o) => o.version)).toEqual(['1.12.6', '1.11.16', '1.10.23', '1.9.11', '1.8.10', '1.7.20']);
    expect(defaultChoice(options)).toBe('1.10.23');
  });

  it('puts the installed version first when it already works (adding the CLI)', () => {
    const options = versionOptions({
      dbt_core: '1.10.13', compatible_dbt_versions: ['1.10.23', '1.12.6'], recommended_version: '1.10.23', reason_code: null,
    });
    expect(options.map((o) => o.label)).toEqual(['1.12.6 — latest', '1.10.23', '1.10.13 — installed, closest, same minor']);
    expect(defaultChoice(options)).toBe('1.10.13');
  });

  it('falls back to the first option', () => {
    expect(defaultChoice([])).toBeNull();
  });
});

describe('other version', () => {
  it('validates the format and the known releases', () => {
    expect(otherVersionError('', undefined)).toMatch(/Enter/);
    expect(otherVersionError('1.10', undefined)).toMatch(/full release/);
    expect(otherVersionError('1.10.99', ['1.10.23'])).toMatch(/isn't a published/);
    expect(otherVersionError(' 1.10.23 ', ['1.10.23'])).toBeNull();
    expect(otherVersionError('1.10.23', undefined)).toBeNull();
  });
});

describe('changes and pins', () => {
  it('groups package changes', () => {
    const grouped = groupChanges([
      { name: 'dbt-core', before: '1.10.2', after: '1.10.23', change: 'upgrade' },
      { name: 'dbt-adapters', before: '1.24.5', after: '1.16.3', change: 'downgrade' },
      { name: 'dbt-metricflow', before: null, after: '0.13.0', change: 'install' },
    ]);
    expect(grouped.upgrades).toHaveLength(1);
    expect(grouped.downgrades[0].name).toBe('dbt-adapters');
    expect(describeChange(grouped.upgrades[0])).toBe('dbt-core 1.10.2 → 1.10.23');
    expect(describeChange(grouped.installs[0])).toBe('dbt-metricflow 0.13.0 (new)');
  });

  it('titles the dialog', () => {
    expect(dialogTitle({ dbt_core: '1.10.2', reason_code: 'no_cli_release' }, true)).toBe("MetricFlow can't run with dbt-core 1.10.2");
    expect(dialogTitle({ dbt_core: '1.10.13', reason_code: null }, true)).toBe('Install the mf CLI into your dbt environment');
    expect(dialogTitle({ dbt_core: null, reason_code: 'unknown_version' }, false)).toBe('MetricFlow needs dbt-core');
  });
});
