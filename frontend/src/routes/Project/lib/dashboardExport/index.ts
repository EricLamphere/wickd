// Dashboard exports: a self-contained HTML file (the grid as rendered, its data embedded) or a
// PNG of the same layout. Both read the rendered grid, so they match what's on screen.
import type { DashboardDoc, WidgetResultDto } from '../../../../lib/dashboardsApi';
import { svgToPngBase64 } from '../dagExport/png';
import { captureScene, collectCss, gridMarkup } from './capture';
import { renderDashboardHtml, type DashboardExportMeta } from './html';
import { renderSceneSvg } from './svg';

export type DashboardExportFormat = 'html' | 'png';

export interface DashboardExportRequest {
  format: DashboardExportFormat;
  grid: HTMLElement;
  doc: DashboardDoc;
  results: WidgetResultDto[];
  meta: DashboardExportMeta;
}

export interface RenderedDashboard {
  content: string;
  encoding: 'utf8' | 'base64';
  scale?: number;
}

export async function renderDashboardExport(req: DashboardExportRequest): Promise<RenderedDashboard> {
  if (req.format === 'html') {
    const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    const data = {
      dashboard: req.doc,
      widgets: req.results.map((r) => ({
        widget_id: r.widget_id, status: r.status, error: r.error, current: r.current, previous: r.previous,
        queries: Object.fromEntries(Object.entries(r.queries).map(([role, q]) => [role, { columns: q.columns, rows: q.rows, ran_at: q.ran_at }])),
      })),
    };
    const content = renderDashboardHtml({
      meta: req.meta, gridHtml: gridMarkup(req.grid), width: req.grid.getBoundingClientRect().width,
      css: collectCss(), theme, data,
    });
    return { content, encoding: 'utf8' };
  }
  const scene = captureScene(req.grid, req.meta);
  const { base64, scale } = await svgToPngBase64(renderSceneSvg(scene), scene.width, scene.height);
  return { content: base64, encoding: 'base64', scale };
}
