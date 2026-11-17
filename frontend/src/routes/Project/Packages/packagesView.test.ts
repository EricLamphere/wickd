import { describe, expect, it } from 'vitest';
import type { PackageRowDto } from '../../../lib/packagesApi';
import { pinnedDbtVersion } from '../../../lib/dbtCoreDrift';
import { compatLabel, diffIsEmpty, isDepsFinished, latestHint, lockDiff, rangeText, upgradeAllChanges } from './packagesView';

const row = (over: Partial<PackageRowDto> = {}): PackageRowDto => ({
  key: 'dbt-labs/dbt_utils', name: 'dbt-labs/dbt_utils', source: 'hub', direct: true, requested: '1.1.1',
  locked: '1.1.1', installed: '1.1.1', project_name: 'dbt_utils', require_dbt_version: ['>=1.3.0', '<2.0.0'],
  compatible: true, hub_name: 'dbt-labs/dbt_utils', latest: '1.3.0', latest_compatible: '1.3.0', upgrade_to: '1.3.0',
  latest_blocked: false, editable: true, notes: [], ...over,
});

describe('lockDiff', () => {
  it('reports added, removed and changed entries', () => {
    const diff = lockDiff(
      [{ key: 'a/a', source: 'hub', version: '1.0.0' }, { key: 'b/b', source: 'hub', version: '2.0.0' }],
      [{ key: 'a/a', source: 'hub', version: '1.1.0' }, { key: 'c/c', source: 'hub', version: '0.1.0' }],
    );
    expect(diff.changed).toEqual([{ key: 'a/a', from: '1.0.0', to: '1.1.0' }]);
    expect(diff.added).toEqual([{ key: 'c/c', from: null, to: '0.1.0' }]);
    expect(diff.removed).toEqual([{ key: 'b/b', from: '2.0.0', to: null }]);
    expect(diffIsEmpty(diff)).toBe(false);
  });

  it('is empty when nothing changed', () => {
    const lock = [{ key: 'a/a', source: 'hub', version: '1.0.0' }];
    expect(diffIsEmpty(lockDiff(lock, lock))).toBe(true);
  });
});

describe('upgradeAllChanges', () => {
  it('upgrades direct, editable packages with a compatible newer release', () => {
    expect(upgradeAllChanges([
      row(),
      row({ key: 'x', upgrade_to: null }),
      row({ key: 'local', editable: false }),
      row({ key: 'dep', direct: false }),
    ])).toEqual([{ op: 'set_version', key: 'dbt-labs/dbt_utils', version: '1.3.0' }]);
  });
});

describe('labels', () => {
  it('describes compatibility', () => {
    expect(compatLabel(row(), '1.10.0').tone).toBe('ok');
    expect(compatLabel(row({ compatible: false }), '1.10.0')).toMatchObject({ text: 'Incompatible', tone: 'fail' });
    expect(compatLabel(row({ compatible: null, installed: null }), '1.10.0').text).toBe('Not installed');
    expect(compatLabel(row({ compatible: null }), null).text).toBe('Unknown');
  });

  it('hints at the latest release', () => {
    expect(latestHint(row())).toBe('Upgrade to 1.3.0');
    expect(latestHint(row({ upgrade_to: null, latest: '2.0.0', latest_blocked: true }))).toBe('2.0.0 needs a newer dbt-core');
    expect(latestHint(row({ upgrade_to: null }))).toBeNull();
    expect(rangeText([])).toBe('any');
  });
});

describe('pinnedDbtVersion', () => {
  it('reads exact pins only', () => {
    expect(pinnedDbtVersion('dbt-core==1.10.13')).toBe('1.10.13');
    expect(pinnedDbtVersion('dbt-core>=1.8')).toBeNull();
    expect(pinnedDbtVersion(null)).toBeNull();
  });
});

describe('isDepsFinished', () => {
  it('matches only a finished dbt deps', () => {
    expect(isDepsFinished({ type: 'run_finished', data: { command: 'deps' } })).toBe(true);
    expect(isDepsFinished({ type: 'run_finished', data: { command: 'run' } })).toBe(false);
    expect(isDepsFinished({ type: 'run_started', data: { command: 'deps' } })).toBe(false);
  });
});
