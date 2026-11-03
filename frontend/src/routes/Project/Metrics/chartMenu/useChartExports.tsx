// A chart's data items for its ⋯ menu, the same group in the same order everywhere (dashboard
// widgets, the metric page's charts, the Investigate widget): View SQL, Open in Workspace (its
// SQL as a new workspace file), Download PNG (the chart as on screen, with a header naming it,
// the period and when the data was queried) and Download CSV (its rows) — plus the dialogs they
// open.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, ExternalLink, Image, Info } from 'lucide-react';
import type { WidgetResultDto } from '../../../../lib/dashboardsApi';
import { alertError } from '../../../../lib/dialogs';
import { svgToPngBase64 } from '../../lib/dagExport/png';
import { captureScene } from '../../lib/dashboardExport/capture';
import { renderSceneSvg } from '../../lib/dashboardExport/svg';
import { SqlDialog } from '../dashboards/widgets/SqlDialog';
import type { WidgetMenuItem } from '../dashboards/widgets/WidgetMenu';
import { chartCsv, chartFileName, chartQuery } from '../lib/chartExport';
import { writeWorkspaceSql } from '../lib/openInWorkspace';
import { ExportChartModal, type ChartFileFormat, type RenderedChartFile } from './ExportChartModal';

export interface ChartExportSource {
  result: WidgetResultDto | null | undefined;
  /** the element to draw: the chart's card (marked `data-widget-id`) or an element around it */
  element: () => HTMLElement | null;
  /** the PNG's header: e.g. "Revenue — Over time" and "Last 30 days … · data queried …" */
  title: string;
  subtitle: string;
  /** file and workspace names, e.g. ["revenue", "over time"] */
  name: string[];
}

interface Download {
  format: ChartFileFormat;
  name: string;
  render: () => Promise<RenderedChartFile>;
}

const ICON = 'w-3.5 h-3.5';

export function useChartExports(projectId: number) {
  const navigate = useNavigate();
  const [download, setDownload] = useState<Download | null>(null);
  const [sqlOf, setSqlOf] = useState<WidgetResultDto | null>(null);

  /** The data group, starting with a divider when other items come before it. */
  const items = (src: ChartExportSource): WidgetMenuItem[] => {
    const sql = chartQuery(src.result)?.sql ?? null;
    const csv = chartCsv(src.result);
    const hasData = !!chartQuery(src.result);
    const name = chartFileName(src.name);
    const queries = src.result ? Object.keys(src.result.queries).length : 0;
    return [
      { label: 'View SQL', icon: <Info className={ICON} />, divider: true, disabled: !queries, onClick: () => setSqlOf(src.result ?? null) },
      {
        label: 'Open in Workspace', icon: <ExternalLink className={ICON} />, disabled: !sql,
        onClick: async () => {
          try {
            await writeWorkspaceSql(projectId, src.name.join('_'), sql!);
            navigate(`/projects/${projectId}/workspace`);
          } catch (err) {
            await alertError(err);
          }
        },
      },
      {
        label: 'Download PNG', icon: <Image className={ICON} />, disabled: !hasData,
        onClick: () => setDownload({
          format: 'png', name,
          render: async () => {
            const el = src.element();
            if (!el) throw new Error('The chart is no longer on screen.');
            const scene = captureScene(el, { title: src.title, subtitle: src.subtitle });
            const { base64 } = await svgToPngBase64(renderSceneSvg(scene), scene.width, scene.height);
            return { content: base64, encoding: 'base64' };
          },
        }),
      },
      {
        label: 'Download CSV', icon: <Download className={ICON} />, disabled: !csv,
        onClick: () => setDownload({ format: 'csv', name, render: async () => ({ content: `${csv}\n`, encoding: 'utf8' }) }),
      },
    ];
  };

  // never part of a PNG, wherever the caller renders it (a dashboard widget renders it inside itself)
  const modal = (
    <div data-export-hide="" className="contents">
      {download && (
        <ExportChartModal projectId={projectId} format={download.format} defaultName={download.name} render={download.render}
          onClose={() => setDownload(null)} />
      )}
      {sqlOf && <SqlDialog queries={sqlOf.queries} onClose={() => setSqlOf(null)} />}
    </div>
  );
  return { items, modal };
}
