import { typeIconFor } from '../nodeTypeIcon';
import type { ExportHeader, ExportTheme } from './config';
import { COLUMN_ROW_HEIGHT, COLUMNS_TOP, type DagScene, type SceneNode } from './scene';

export interface Palette {
  background: string;
  panel: string;
  headerBackground: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  edge: string;
  brand: string;
  idleRing: string;
  idleDot: string;
}

export const PALETTES: Record<ExportTheme, Palette> = {
  dark: {
    background: '#0d1014',
    panel: '#161a21',
    headerBackground: '#12161c',
    border: '#2a303b',
    text: '#f3f4f6',
    muted: '#9ca3af',
    faint: '#6b7280',
    edge: '#4b5563',
    brand: '#14b8a6',
    idleRing: '#374151',
    idleDot: '#4b5563',
  },
  light: {
    background: '#ffffff',
    panel: '#f9fafb',
    headerBackground: '#f3f4f6',
    border: '#e5e7eb',
    text: '#111827',
    muted: '#4b5563',
    faint: '#6b7280',
    edge: '#9ca3af',
    brand: '#0d9488',
    idleRing: '#d1d5db',
    idleDot: '#9ca3af',
  },
};

// Same hues as ModelNode's status ring and dot
const STATUS_RING: Record<string, string> = {
  pending: '#2563eb',
  running: '#3b82f6',
  success: '#059669',
  error: '#dc2626',
  stale: '#f59e0b',
  warn: '#eab308',
};
const STATUS_DOT: Record<string, string> = {
  pending: '#60a5fa',
  running: '#60a5fa',
  success: '#34d399',
  error: '#ef4444',
  stale: '#fbbf24',
  warn: '#facc15',
};

export const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif";
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const HEADER_TOP = 28;
const HEADER_ROW_HEIGHT = 18;
const HEADER_LABEL_WIDTH = 130;
const HEADER_MIN_WIDTH = 640;

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(max - 1, 1))}…`;
}

function ringFor(status: string, palette: Palette): string {
  return STATUS_RING[status] ?? palette.idleRing;
}

function dotFor(status: string, palette: Palette): string {
  return STATUS_DOT[status] ?? palette.idleDot;
}

function renderColumns(node: SceneNode, palette: Palette): string {
  if (node.visibleColumns.length === 0 && node.hiddenColumnCount === 0) return '';
  const parts = [
    `<line x1="8" y1="${COLUMNS_TOP - 4}" x2="${node.width - 8}" y2="${COLUMNS_TOP - 4}" stroke="${palette.border}"/>`,
  ];
  node.visibleColumns.forEach((col, i) => {
    const y = COLUMNS_TOP + i * COLUMN_ROW_HEIGHT + 14;
    const typeChars = col.dataType ? Math.min(col.dataType.length, 12) : 0;
    const nameChars = Math.floor((node.width - 20 - typeChars * 5) / 6.2);
    parts.push(
      `<g class="col" data-col="${escapeXml(col.name)}">`
      + `<rect class="col-bg" x="4" y="${y - 14}" width="${node.width - 8}" height="${COLUMN_ROW_HEIGHT - 2}" rx="3" fill="transparent"/>`
      + `<text x="10" y="${y}" fill="${palette.muted}" font-family="${MONO}" font-size="10">${escapeXml(truncate(col.name, nameChars))}</text>`
      + (col.dataType
        ? `<text x="${node.width - 10}" y="${y}" text-anchor="end" fill="${palette.faint}" font-family="${SANS}" font-size="8">${escapeXml(truncate(col.dataType, 12))}</text>`
        : '')
      + '</g>',
    );
  });
  if (node.hiddenColumnCount > 0) {
    const y = COLUMNS_TOP + node.visibleColumns.length * COLUMN_ROW_HEIGHT + 14;
    parts.push(
      `<text x="10" y="${y}" fill="${palette.faint}" font-family="${SANS}" font-size="9">+${node.hiddenColumnCount} more</text>`,
    );
  }
  return parts.join('');
}

export function renderNode(node: SceneNode, palette: Palette): string {
  const m = node.model;
  const expanded = node.visibleColumns.length > 0 || node.hiddenColumnCount > 0;
  const footer = !expanded && m.columns.length > 0
    ? `<text x="${node.width / 2}" y="${node.height - 6}" text-anchor="middle" fill="${palette.faint}" font-family="${SANS}" font-size="9">${m.columns.length} columns</text>`
    : '';
  return (
    `<g class="node" data-id="${escapeXml(m.unique_id)}" transform="translate(${node.x},${node.y})">`
    + `<title>${escapeXml(m.name)}</title>`
    + `<rect class="box" width="${node.width}" height="${node.height}" rx="8" fill="${palette.panel}" stroke="${ringFor(m.status, palette)}" stroke-width="1.5"/>`
    + `<text x="12" y="20" fill="${palette.muted}" font-family="${SANS}" font-size="11">${typeIconFor(m.resource_type)}</text>`
    + `<text x="27" y="19" fill="${palette.faint}" font-family="${MONO}" font-size="10">${escapeXml(m.resource_type)}</text>`
    + `<circle cx="${node.width - 14}" cy="15" r="4" fill="${dotFor(m.status, palette)}"/>`
    + `<text class="name" x="12" y="40" fill="${palette.text}" font-family="${SANS}" font-size="12" font-weight="600">${escapeXml(truncate(m.name, 25))}</text>`
    + (m.materialized
      ? `<text x="12" y="55" fill="${palette.faint}" font-family="${MONO}" font-size="9">${escapeXml(truncate(m.materialized, 30))}</text>`
      : '')
    + footer
    + renderColumns(node, palette)
    + '</g>'
  );
}

/** Arrowhead marker + edges + nodes, in scene coordinates. Shared by the SVG/PNG and HTML exports. */
export function arrowDefs(palette: Palette): string {
  return '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
    + `<path d="M0,0 L10,5 L0,10 z" fill="${palette.edge}"/></marker></defs>`;
}

export function renderGraphBody(scene: DagScene, palette: Palette): string {
  const defs = arrowDefs(palette);
  const edges = scene.edges
    .map((e) => `<path class="edge" data-source="${escapeXml(e.source)}" data-target="${escapeXml(e.target)}" d="${e.path}" fill="none" stroke="${palette.edge}" stroke-width="1.5" marker-end="url(#arrow)"/>`)
    .join('');
  const nodes = scene.nodes.map((n) => renderNode(n, palette)).join('');
  return `${defs}<g class="edges">${edges}</g><g class="nodes">${nodes}</g>`;
}

export function headerHeight(header: ExportHeader): number {
  return HEADER_TOP + 48 + header.rows.length * HEADER_ROW_HEIGHT + 20;
}

function renderHeader(header: ExportHeader, width: number, palette: Palette): string {
  const valueChars = Math.max(20, Math.floor((width - HEADER_LABEL_WIDTH - 64) / 6.8));
  const rows = header.rows.map((row, i) => {
    const y = HEADER_TOP + 52 + i * HEADER_ROW_HEIGHT;
    return `<text x="32" y="${y}" fill="${palette.faint}" font-family="${SANS}" font-size="12">${escapeXml(row.label)}</text>`
      + `<text x="${32 + HEADER_LABEL_WIDTH}" y="${y}" fill="${palette.text}" font-family="${MONO}" font-size="12">`
      + `<title>${escapeXml(row.value)}</title>${escapeXml(truncate(row.value, valueChars))}</text>`;
  });
  const height = headerHeight(header);
  return `<rect width="${width}" height="${height}" fill="${palette.headerBackground}"/>`
    + `<line x1="0" y1="${height}" x2="${width}" y2="${height}" stroke="${palette.border}"/>`
    + `<text x="32" y="${HEADER_TOP + 8}" fill="${palette.text}" font-family="${SANS}" font-size="18" font-weight="700">${escapeXml(header.title)}</text>`
    + `<text x="32" y="${HEADER_TOP + 28}" fill="${palette.muted}" font-family="${SANS}" font-size="12">${escapeXml(header.subtitle)}</text>`
    + rows.join('');
}

export interface RenderedSvg {
  svg: string;
  width: number;
  height: number;
}

/** A standalone SVG document: the filter header on top, the DAG below it. */
export function renderDagSvg(scene: DagScene, header: ExportHeader, theme: ExportTheme): RenderedSvg {
  const palette = PALETTES[theme];
  const width = Math.max(scene.width, HEADER_MIN_WIDTH);
  const top = headerHeight(header);
  const height = top + scene.height;
  const offsetX = Math.round((width - scene.width) / 2);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="${palette.background}"/>`
    + renderHeader(header, width, palette)
    + `<g transform="translate(${offsetX},${top})">${renderGraphBody(scene, palette)}</g>`
    + '</svg>';
  return { svg, width, height };
}
