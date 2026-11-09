import { describe, expect, it } from 'vitest';
import type { ColumnLineageDto } from '../../../lib/api';
import { isLineageScanning, lineageAction, lineageScanError } from './columnLineageState';

function snap(over: Partial<ColumnLineageDto> = {}): ColumnLineageDto {
  return {
    id: 1, project_id: 1, started_at: '', finished_at: '', status: 'done', total_models: 1, checked_models: 1,
    results: {}, row_dependencies: {}, lineage_version: 4, error_message: null,
    stale: false, stale_reason: null, refresh_status: null, refresh_error: null, ...over,
  };
}

describe('lineageAction', () => {
  it('offers nothing while the cache is current', () => {
    expect(lineageAction({ locked: false, loading: false, snapshot: snap() })).toBe('none');
  });
  it('offers a refresh only when the cache is out of date', () => {
    expect(lineageAction({ locked: false, loading: false, snapshot: snap({ stale: true }) })).toBe('refresh');
  });
  it('offers a load when nothing has finished yet', () => {
    expect(lineageAction({ locked: false, loading: false, snapshot: null })).toBe('load');
    expect(lineageAction({ locked: false, loading: false, snapshot: snap({ status: 'error' }) })).toBe('load');
  });
  it('locked and loading win', () => {
    expect(lineageAction({ locked: true, loading: true, snapshot: snap({ stale: true }) })).toBe('locked');
    expect(lineageAction({ locked: false, loading: true, snapshot: snap({ stale: true }) })).toBe('loading');
  });
});

describe('scan state', () => {
  it('a refresh behind the cache counts as scanning', () => {
    expect(isLineageScanning(snap({ refresh_status: 'running' }))).toBe(true);
    expect(isLineageScanning(snap({ status: 'running' }))).toBe(true);
    expect(isLineageScanning(snap())).toBe(false);
    expect(isLineageScanning(null)).toBe(false);
  });
  it('reports a failed refresh or a failed first scan', () => {
    expect(lineageScanError(snap({ refresh_status: 'error', refresh_error: 'boom' }))).toBe('boom');
    expect(lineageScanError(snap({ status: 'error', error_message: 'bad' }))).toBe('bad');
    expect(lineageScanError(snap())).toBeNull();
  });
});
