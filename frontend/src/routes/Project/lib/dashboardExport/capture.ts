// Read the rendered dashboard from the DOM for export: a cleaned copy of the grid's markup
// (HTML) or a scene of rectangles, text runs and chart SVGs at their on-screen positions (PNG).
import { selfContainedCss, tableHtml } from './html';
import { resolveCssVars, type Shape, type SvgScene } from './svg';

const HIDDEN = '[data-export-hide]';

/** The app's CSS rules that can travel in a file (same-origin sheets; fonts and url()s dropped). */
export function collectCss(): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) rules.push(rule.cssText);
    } catch {
      // a cross-origin sheet can't be read; the export doesn't need it
    }
  }
  return selfContainedCss(rules);
}

/** The grid's markup without app-only controls; tables become static tables of their data. */
export function gridMarkup(grid: HTMLElement): string {
  const copy = grid.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(HIDDEN).forEach((el) => el.remove());
  // "as of 2m ago" would be wrong whenever the file is opened later
  copy.querySelectorAll<HTMLElement>('[data-export-asof]').forEach((el) => {
    el.textContent = `as of ${new Date(el.dataset.exportAsof ?? '').toLocaleString()}`;
  });
  copy.querySelectorAll<HTMLElement>('[data-export-table]').forEach((table) => {
    try {
      const { columns, rows } = JSON.parse(table.dataset.exportTable ?? '{}') as { columns?: string[]; rows?: unknown[][] };
      if (columns && rows) table.outerHTML = tableHtml(columns, rows);
    } catch { /* keep the rendered table */ }
  });
  copy.querySelectorAll<HTMLElement>('[data-widget-id]').forEach((widget) => {
    widget.style.transform = '';
    widget.style.opacity = '';
  });
  return `<div class="dashboard-grid-wrap">${copy.outerHTML}</div>`;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

function isTransparent(color: string): boolean {
  return !color || color === 'transparent' || /rgba?\([^)]*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color);
}

function textShape(node: Text, origin: DOMRect): Shape | null {
  const text = node.textContent?.trim();
  const parent = node.parentElement;
  if (!text || !parent) return null;
  const range = document.createRange();
  range.selectNodeContents(node);
  const r = range.getBoundingClientRect();
  if (!r.width) return null;
  const style = getComputedStyle(parent);
  const size = parseFloat(style.fontSize) || 12;
  return { kind: 'text', x: r.left - origin.left, y: r.top - origin.top + size * 0.95, text, color: style.color, size,
    weight: style.fontWeight, family: style.fontFamily };
}

/** Text runs, coloured boxes and SVGs inside `el`, relative to `origin` (depth first, paint order). */
function shapesIn(el: Element, origin: DOMRect, out: Shape[], isRoot = true): void {
  if (el.matches(HIDDEN)) return;
  if (el instanceof SVGSVGElement) {
    const r = el.getBoundingClientRect();
    if (r.width && r.height) {
      // currentColor (icons) has no page colour to follow once the SVG is an image
      const color = getComputedStyle(el).color;
      const markup = resolveCssVars(new XMLSerializer().serializeToString(el), cssVar).replace(/currentColor/g, color);
      out.push({ kind: 'svg', x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height, markup });
    }
    return;
  }
  if (el instanceof HTMLElement && !isRoot) {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!isTransparent(style.backgroundColor) && r.width && r.height) {
      out.push({ kind: 'rect', x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height,
        fill: style.backgroundColor, rx: parseFloat(style.borderTopLeftRadius) || 0 });
    }
  }
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const shape = textShape(child as Text, origin);
      if (shape) out.push(shape);
    } else if (child instanceof Element) {
      shapesIn(child, origin, out, false);
    }
  }
}

/** The PNG's scene: a header, then every widget with its contents, as on screen. */
export function captureScene(grid: HTMLElement, header: { title: string; subtitle: string }): SvgScene {
  const pad = 24;
  const headerH = 56;
  const origin = grid.getBoundingClientRect();
  const shifted = new DOMRect(origin.left - pad, origin.top - pad - headerH, origin.width, origin.height);
  const root = getComputedStyle(document.documentElement);
  const color = (name: string) => `rgb(${root.getPropertyValue(name).trim()})`;
  const family = getComputedStyle(document.body).fontFamily;
  const shapes: Shape[] = [
    { kind: 'text', x: pad, y: pad + 16, text: header.title, color: color('--text-primary'), size: 18, weight: '600', family },
    { kind: 'text', x: pad, y: pad + 38, text: header.subtitle, color: color('--text-secondary'), size: 12, weight: '400', family },
  ];
  grid.querySelectorAll<HTMLElement>('[data-widget-id]').forEach((tile) => {
    const r = tile.getBoundingClientRect();
    const style = getComputedStyle(tile);
    shapes.push({ kind: 'rect', x: r.left - shifted.left, y: r.top - shifted.top, w: r.width, h: r.height,
      fill: style.backgroundColor, stroke: style.borderTopColor, rx: parseFloat(style.borderTopLeftRadius) || 0 });
    shapesIn(tile, shifted, shapes);
  });
  return {
    width: origin.width + pad * 2,
    height: origin.height + pad * 2 + headerH,
    background: color('--bg-app'),
    fontFamily: family,
    shapes,
  };
}
