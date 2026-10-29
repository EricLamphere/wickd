import { describe, expect, it } from 'vitest';
import { renderDashboardHtml, selfContainedCss, tableHtml } from './html';
import { nestSvg, renderSceneSvg, resolveCssVars } from './svg';

const input = {
  meta: { title: 'Revenue <overview>', subtitle: 'Target dev · data queried today', rows: [{ label: 'Dates', value: 'Last 90 days' }] },
  gridHtml: '<div class="dashboard-grid"><section data-widget-id="rev"><svg class="recharts-surface"></svg></section></div>',
  width: 960,
  css: '.a { color: red; }',
  theme: 'light' as const,
  data: { widgets: [{ widget_id: 'rev', rows: [['</script><script>alert(1)</script>', 1]] }] },
};

describe('dashboard HTML export', () => {
  const html = renderDashboardHtml(input);

  it('is one self-contained page', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).toContain('<title>Revenue &lt;overview&gt;</title>');
    expect(html).toContain('<dt>Dates</dt><dd>Last 90 days</dd>');
    expect(html).toContain('data-widget-id="rev"');
    expect(html).toContain('width:1008px');
    expect(html).not.toMatch(/\b(src|href)=/);
    expect(html).not.toMatch(/url\(/);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('embeds the data safely', () => {
    const json = html.match(/<script type="application\/json" id="wickd-dashboard-data">(.*?)<\/script>/s)?.[1] ?? '';
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json)).toEqual(input.data);
  });

  it('ships the hover runtime', () => {
    expect(html).toContain('data-export-series');
    expect(html).toContain("className = 'wickd-tip'");
  });
});

describe('helpers', () => {
  it('keeps only CSS that can travel in a file', () => {
    const css = selfContainedCss(['.a{}', '@font-face { src: url(x.woff) }', '@import "x.css";', '.b { background: url(/img.png) }', '.c{}']);
    expect(css).toBe('.a{}\n.c{}');
  });

  it('renders static tables with escaped cells and a row cap', () => {
    const t = tableHtml(['a'], [['<b>'], [null], ['x']], 2);
    expect(t).toContain('<td>&lt;b&gt;</td>');
    expect(t).toContain('<td></td>');
    expect(t).toContain('1 more rows not shown');
  });

  it('resolves CSS variables, nested and with fallbacks', () => {
    const vars: Record<string, string> = { '--a': ' 1 2 3', '--b': 'var(--a)' };
    expect(resolveCssVars('fill="rgb(var(--a))" stroke="var(--b)" x="var(--none, red)"', (n) => vars[n] ?? ''))
      .toBe('fill="rgb(1 2 3)" stroke="1 2 3" x="red"');
  });

  it('nests an svg at a position, keeping its viewBox', () => {
    expect(nestSvg('<svg class="x" viewBox="0 0 10 5"><path/></svg>', 1, 2, 10, 5))
      .toBe('<svg x="1" y="2" width="10" height="5" viewBox="0 0 10 5" overflow="hidden"><path/></svg>');
  });

  it('renders a scene', () => {
    const svg = renderSceneSvg({ width: 100, height: 50, background: 'rgb(0 0 0)', fontFamily: 'Inter', shapes: [
      { kind: 'rect', x: 1, y: 1, w: 10, h: 10, fill: 'red', stroke: 'blue', rx: 4 },
      { kind: 'text', x: 2, y: 12, text: 'a & b', color: 'white', size: 12, weight: '400', family: '"Inter", sans-serif' },
    ] });
    expect(svg).toContain('<rect x="1" y="1" width="10" height="10" rx="4" fill="red" stroke="blue"/>');
    expect(svg).toContain('>a &amp; b</text>');
    expect(svg).toContain('font-family="Inter">');
    expect(svg).toContain('font-family="&quot;Inter&quot;, sans-serif"');
  });
});
