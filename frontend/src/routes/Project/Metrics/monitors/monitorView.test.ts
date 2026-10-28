import { describe, expect, it } from 'vitest';
import type { MonitorDto, MonitorPointDto, MonitorStatus } from '../../../../lib/monitorsApi';
import { clampBand, formatNumber, kindTone, monitoredDownstream, monitorTitle, sparkGeometry, statusStyle, statusesByMetric, vsExpected } from './monitorView';

function point(value: number | null, extra: Partial<MonitorPointDto> = {}): MonitorPointDto {
  return { period: '2026-10-01', value, expected: null, low: null, high: null, kind: 'none', partial: false, ...extra };
}

function monitor(metric: string, status: MonitorStatus | null, enabled = true): MonitorDto {
  return {
    id: Math.random(), metric, grain: 'day', dimension: null, sensitivity: 'normal', lookback: 180, enabled, target: null,
    slices: [], position: 0, created_at: null, last_checked_at: null,
    latest: status ? {
      monitor_id: 1, metric, grain: 'day', dimension: null, target: '', status, headline: `${status}!`, since: null,
      latest: null, worst_slice: null, slices: [], truncated: false, error: null, checked_at: '2026-10-28T00:00:00Z',
    } : null,
  };
}

describe('statusStyle', () => {
  it('maps statuses to tones', () => {
    expect(statusStyle('anomaly').tone).toBe('fail');
    expect(statusStyle('error').tone).toBe('fail');
    expect(statusStyle('warn').tone).toBe('warn');
    expect(statusStyle('ok').label).toBe('Normal');
    expect(statusStyle('not_enough_history').label).toBe('Learning');
    expect(statusStyle(null).label).toBe('Not checked');
    expect(statusStyle('ok', true).tone).toBe('running');
  });

  it('point kinds: alarms red, the rest amber', () => {
    expect(kindTone('level_shift')).toBe('fail');
    expect(kindTone('missing')).toBe('fail');
    expect(kindTone('restated')).toBe('warn');
    expect(kindTone('warn')).toBe('warn');
    expect(kindTone('none')).toBe('idle');
  });
});

describe('statusesByMetric', () => {
  it('keeps the worst status per metric and skips disabled monitors', () => {
    const map = statusesByMetric([
      monitor('revenue', 'ok'), monitor('revenue', 'anomaly'), monitor('revenue', 'warn'),
      monitor('orders', null), monitor('orders', 'ok'), monitor('gone', 'anomaly', false),
    ]);
    expect(map.get('revenue')).toEqual({ status: 'anomaly', headline: 'anomaly!', monitors: 3 });
    expect(map.get('orders')?.status).toBe('ok');
    expect(map.get('orders')?.monitors).toBe(2);
    expect(map.has('gone')).toBe(false);
  });
});

describe('monitoredDownstream', () => {
  it('counts monitored metrics once and lists the alarming ones', () => {
    const map = statusesByMetric([monitor('revenue', 'anomaly'), monitor('orders', 'ok'), monitor('aov', null)]);
    expect(monitoredDownstream(['revenue', 'orders', 'revenue', 'aov', 'other'], map)).toEqual({ count: 3, alarming: ['revenue'] });
    expect(monitoredDownstream([], map)).toEqual({ count: 0, alarming: [] });
  });
});

describe('sparkGeometry', () => {
  it('draws the line, breaks it at gaps, and bands the scored runs', () => {
    const pts = [
      point(10, { low: 8, high: 12 }), point(11, { low: 8, high: 12 }), point(null, { kind: 'missing' }),
      point(10, { low: 8, high: 12 }), point(30, { low: 8, high: 12, kind: 'anomaly' }),
    ];
    const g = sparkGeometry(pts, 100, 20, 0);
    expect(g.line.match(/M/g)).toHaveLength(2);
    expect(g.band.match(/Z/g)).toHaveLength(2);
    expect(g.flagged.map((f) => f.kind)).toEqual(['missing', 'anomaly']);
    expect(g.flagged[0].y).toBe(20); // missing sits on the floor
    expect(g.flagged[1]).toEqual({ x: 100, y: 0, kind: 'anomaly' }); // the max is at the top
    expect(g.partial).toBeNull();
  });

  it('handles a flat series, a partial last point and no data', () => {
    const g = sparkGeometry([point(5), point(5), point(5, { partial: true })], 10, 10, 0);
    expect(g.line).toBe('M0,5L5,5L10,5');
    expect(g.partial).toEqual({ x: 10, y: 5 });
    expect(sparkGeometry([], 10, 10)).toEqual({ line: '', band: '', flagged: [], partial: null });
    expect(sparkGeometry([point(null)], 10, 10).line).toBe('');
  });
});

describe('clampBand', () => {
  it('floors the band at 0 unless the series goes negative', () => {
    expect(clampBand([point(1, { low: -3, high: 5 })])[0].low).toBe(0);
    expect(clampBand([point(-1, { low: -3, high: 5 })])[0].low).toBe(-3);
  });
});

describe('numbers', () => {
  it('formats values and comparisons', () => {
    expect(formatNumber(1234.5)).toBe((1235).toLocaleString());
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(0.123456)).toBe((0.1235).toLocaleString());
    expect(vsExpected(112, 100)).toBe('+12% vs expected');
    expect(vsExpected(95, 100)).toBe('−5.0% vs expected');
    expect(vsExpected(100.1, 100)).toBe('as expected');
    expect(vsExpected(1, 0)).toBeNull();
    expect(vsExpected(null, 1)).toBeNull();
  });

  it('titles a monitor', () => {
    expect(monitorTitle({ metric: 'revenue', grain: 'week', dimension: 'customer__region' })).toBe('revenue · week · by customer__region');
  });
});
