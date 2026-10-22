import type { GraphDto } from '../../../../lib/api';
import type { FilterState } from '../dagFilter';
import { buildExportHeader, type ExportFormat, type ExportTheme, type HtmlIncludes } from './config';
import { renderDagHtml, type LineageResults } from './html';
import { svgToPngBase64 } from './png';
import { projectSceneNodes, type DagScene } from './scene';
import { renderDagSvg } from './svg';

export interface ExportRequest {
  format: ExportFormat;
  theme: ExportTheme;
  includes: HtmlIncludes;
  scene: DagScene;
  projectName: string;
  filter: FilterState;
  lineage: LineageResults | null;
  /** The whole project (live statuses applied), for whole-project HTML exports. */
  graph: GraphDto;
  nodeHeights: Map<string, number>;
  expanded: Set<string>;
}

export interface RenderedExport {
  content: string;
  encoding: 'utf8' | 'base64';
  /** PNG only: below 2 when the canvas had to be shrunk to fit browser limits. */
  scale?: number;
}

/** Renders the file body for the chosen format. Only PNG needs the DOM (a canvas). */
export async function renderExport(req: ExportRequest): Promise<RenderedExport> {
  const header = buildExportHeader({
    projectName: req.projectName,
    filter: req.filter,
    nodeCount: req.scene.nodes.length,
    edgeCount: req.scene.edges.length,
    exportedAt: new Date(),
    includes: req.format === 'html' ? req.includes : undefined,
  });
  if (req.format === 'html') {
    const project = req.includes.wholeProject
      ? {
          nodes: projectSceneNodes(req.graph.nodes, req.scene, req.nodeHeights, req.expanded),
          edges: req.graph.edges,
        }
      : null;
    const content = renderDagHtml({
      scene: req.scene,
      header,
      theme: req.theme,
      includes: req.includes,
      lineage: req.lineage,
      filter: req.filter,
      project,
    });
    return { content, encoding: 'utf8' };
  }
  const { svg, width, height } = renderDagSvg(req.scene, header, req.theme);
  if (req.format === 'svg') return { content: svg, encoding: 'utf8' };
  const { base64, scale } = await svgToPngBase64(svg, width, height);
  return { content: base64, encoding: 'base64', scale };
}
