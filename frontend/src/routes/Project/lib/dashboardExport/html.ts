// A dashboard as one self-contained HTML file: the grid as rendered in the app (its markup
// and the app's own CSS, so charts match), the tile results as embedded JSON, and a tiny
// runtime for chart hover readouts. No external URLs. Pure; tested in dashboardExport.test.ts.
import { escapeXml } from '../dagExport/svg';
import { jsonForScript } from '../dagExport/html';
import { TOOLTIP_RUNTIME } from './runtime';

export interface DashboardExportMeta {
  title: string;
  /** e.g. "Project jaffle_shop · target dev · data queried Oct 28, 2026, 14:02" */
  subtitle: string;
  /** filters, date range etc. as label → value rows */
  rows: { label: string; value: string }[];
}

export interface DashboardHtmlInput {
  meta: DashboardExportMeta;
  /** the grid's markup, already cleaned of app-only controls */
  gridHtml: string;
  /** the grid's on-screen width (px), so widgets lay out as they did */
  width: number;
  /** the app's CSS (fonts and other url()s removed) */
  css: string;
  /** html[data-theme] at export time */
  theme: 'light' | 'dark';
  data: unknown;
}

/** Drop rules that would reach outside the file: @font-face, @import and anything with url(). */
export function selfContainedCss(rules: string[]): string {
  return rules
    .filter((r) => !/^@(font-face|import)\b/i.test(r.trim()) && !/url\(/i.test(r))
    .join('\n');
}

const PAGE_CSS = `
body { margin: 0; background: rgb(var(--bg-app)); color: rgb(var(--text-primary)); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.wickd-export { box-sizing: border-box; padding: 24px; margin: 0 auto; }
.wickd-export header { margin-bottom: 16px; }
.wickd-export h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
.wickd-export .subtitle { margin: 0 0 8px; font-size: 12px; color: rgb(var(--text-secondary)); }
.wickd-export dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 0; font-size: 11px; }
.wickd-export dt { color: rgb(var(--text-muted)); }
.wickd-export dd { margin: 0; font-family: ui-monospace, monospace; color: rgb(var(--text-secondary)); }
.wickd-export footer { margin-top: 16px; font-size: 10px; color: rgb(var(--text-muted)); }
.wickd-tip { position: fixed; z-index: 10; pointer-events: none; padding: 6px 8px; font-size: 11px; border-radius: 4px;
  background: rgb(var(--bg-elevated)); border: 1px solid rgb(var(--border-default)); box-shadow: 0 6px 16px rgb(0 0 0 / 0.3); }
.wickd-tip b { display: block; margin-bottom: 2px; }
.wickd-tip span { display: flex; gap: 8px; align-items: center; }
.wickd-tip i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.wickd-tip em { margin-left: auto; font-style: normal; font-family: ui-monospace, monospace; }
.wickd-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.wickd-table th, .wickd-table td { padding: 2px 6px; text-align: left; border-bottom: 1px solid rgb(var(--border-default)); white-space: nowrap; }
.wickd-table th { color: rgb(var(--text-secondary)); font-weight: 500; }
`;

export function renderDashboardHtml(input: DashboardHtmlInput): string {
  const { meta } = input;
  const rows = meta.rows.map((r) => `<dt>${escapeXml(r.label)}</dt><dd>${escapeXml(r.value)}</dd>`).join('');
  return `<!doctype html>
<html lang="en" data-theme="${input.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="wickd">
<title>${escapeXml(meta.title)}</title>
<style>${input.css.replace(/<\/style/gi, '<\\/style')}</style>
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="wickd-export" style="width:${Math.round(input.width) + 48}px">
<header><h1>${escapeXml(meta.title)}</h1><p class="subtitle">${escapeXml(meta.subtitle)}</p>${rows ? `<dl>${rows}</dl>` : ''}</header>
${input.gridHtml}
<footer>Exported from wickd. The data is embedded in this file; it doesn't update.</footer>
</main>
<script type="application/json" id="wickd-dashboard-data">${jsonForScript(input.data)}</script>
<script>${TOOLTIP_RUNTIME}</script>
</body>
</html>
`;
}

/** A static table for a table widget (the app's DataTable is interactive and virtualised). */
export function tableHtml(columns: string[], rows: unknown[][], max = 200): string {
  const head = columns.map((c) => `<th>${escapeXml(c)}</th>`).join('');
  const body = rows.slice(0, max)
    .map((r) => `<tr>${r.map((v) => `<td>${escapeXml(v == null ? '' : String(v))}</td>`).join('')}</tr>`).join('');
  const more = rows.length > max ? `<p class="subtitle">${rows.length - max} more rows not shown</p>` : '';
  return `<div style="overflow:auto;height:100%"><table class="wickd-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}</div>`;
}
