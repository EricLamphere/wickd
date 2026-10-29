// The PNG export's picture: one standalone SVG composed from the tiles as laid out on
// screen (WebKit taints a canvas that draws SVG <foreignObject>, so no HTML inside).
// CSS variables are resolved to concrete colours, because an SVG drawn as an image can't
// see the page's styles. Pure; tested in dashboardExport.test.ts.
import { escapeXml } from '../dagExport/svg';

export type Shape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string; stroke?: string; rx?: number }
  | { kind: 'text'; x: number; y: number; text: string; color: string; size: number; weight: string; family: string }
  | { kind: 'svg'; x: number; y: number; w: number; h: number; markup: string };

export interface SvgScene {
  width: number;
  height: number;
  background: string;
  /** default font for text without its own (chart axis ticks) */
  fontFamily: string;
  shapes: Shape[];
}

/** Replace `var(--name)` with the value from `vars` (repeatedly, for nested vars). */
export function resolveCssVars(text: string, vars: (name: string) => string): string {
  let out = text;
  for (let i = 0; i < 4 && out.includes('var(--'); i += 1) {
    out = out.replace(/var\((--[\w-]+)(?:\s*,\s*([^()]*))?\)/g, (_m, name: string, fallback?: string) => vars(name).trim() || fallback || '');
  }
  return out;
}

const num = (v: number) => Math.round(v * 10) / 10;

/** An inner <svg>'s markup placed at x/y with its on-screen size. */
export function nestSvg(markup: string, x: number, y: number, w: number, h: number): string {
  const open = markup.match(/^<svg\b[^>]*>/i)?.[0] ?? '<svg>';
  const viewBox = open.match(/viewBox="([^"]*)"/i)?.[1] ?? `0 0 ${num(w)} ${num(h)}`;
  const inner = markup.slice(open.length).replace(/<\/svg>\s*$/i, '');
  return `<svg x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" viewBox="${viewBox}" overflow="hidden">${inner}</svg>`;
}

export function renderSceneSvg(scene: SvgScene): string {
  const parts = scene.shapes.map((s) => {
    if (s.kind === 'rect') {
      return `<rect x="${num(s.x)}" y="${num(s.y)}" width="${num(s.w)}" height="${num(s.h)}" rx="${s.rx ?? 0}" fill="${escapeXml(s.fill)}"`
        + `${s.stroke ? ` stroke="${escapeXml(s.stroke)}"` : ''}/>`;
    }
    if (s.kind === 'text') {
      return `<text x="${num(s.x)}" y="${num(s.y)}" fill="${escapeXml(s.color)}" font-size="${s.size}" font-weight="${escapeXml(s.weight)}"`
        + ` font-family="${escapeXml(s.family)}">${escapeXml(s.text)}</text>`;
    }
    return nestSvg(s.markup, s.x, s.y, s.w, s.h);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(scene.width)}" height="${num(scene.height)}" viewBox="0 0 ${num(scene.width)} ${num(scene.height)}" font-family="${escapeXml(scene.fontFamily)}">`
    + `<rect width="100%" height="100%" fill="${escapeXml(scene.background)}"/>${parts.join('')}</svg>`;
}
