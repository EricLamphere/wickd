import { describe, expect, it } from 'vitest';
import { rangePick } from './zoom';

const day = (s: string) => Date.parse(`${s}T00:00:00Z`);

describe('rangePick', () => {
  it('picks the zoomed periods when the pointer is inside them', () => {
    const zoom = { start: '2026-02-01', end: '2026-03-31' };
    expect(rangePick(day('2026-03-01'), zoom, 'month')).toEqual({ values: [], range: zoom });
  });

  it('picks the period under the pointer otherwise', () => {
    expect(rangePick(day('2026-04-01'), { start: '2026-02-01', end: '2026-03-31' }, 'month'))
      .toEqual({ values: [], range: { start: '2026-04-01', end: '2026-04-30' } });
    expect(rangePick(day('2026-04-06'), null, 'week')).toEqual({ values: [], range: { start: '2026-04-06', end: '2026-04-12' } });
  });
});
