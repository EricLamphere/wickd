import type { FilterState } from '../dagFilter';

export type ExportFormat = 'html' | 'svg' | 'png';
export type ExportTheme = 'dark' | 'light';

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  html: 'Interactive HTML',
  svg: 'SVG image',
  png: 'PNG image',
};

export interface HeaderRow {
  label: string;
  value: string;
}

/** The block printed at the top of every export: what was exported and how it was filtered. */
export interface ExportHeader {
  title: string;
  subtitle: string;
  rows: HeaderRow[];
}

export interface HtmlIncludes {
  modelLineage: boolean;
  columnLineage: boolean;
  /** Every node in the project, so viewers can change the filters; else only the nodes shown. */
  wholeProject: boolean;
}

function listOrAll(values: Set<string>): string {
  return values.size === 0 ? 'All' : [...values].sort().join(', ');
}

/** The on-screen DAG filter as label/value rows, in the filter bar's order. */
export function describeFilter(filter: FilterState): HeaderRow[] {
  const selector = filter.selector.trim();
  return [
    { label: 'Selector', value: selector || 'None' },
    { label: 'Types', value: listOrAll(filter.resourceTypes) },
    { label: 'Materializations', value: listOrAll(filter.materializations) },
    { label: 'Tags', value: listOrAll(filter.tags) },
    { label: 'Statuses', value: listOrAll(filter.statuses) },
  ];
}

export function describeIncludes(includes: HtmlIncludes): string {
  const parts = [
    includes.wholeProject && 'whole project',
    includes.modelLineage && 'model lineage',
    includes.columnLineage && 'column lineage',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Graph only';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface HeaderInput {
  projectName: string;
  filter: FilterState;
  nodeCount: number;
  edgeCount: number;
  exportedAt: Date;
  /** Interactive HTML only. */
  includes?: HtmlIncludes;
}

export function buildExportHeader(input: HeaderInput): ExportHeader {
  const rows = [
    ...describeFilter(input.filter),
    { label: 'Nodes', value: `${input.nodeCount} nodes, ${input.edgeCount} edges` },
  ];
  if (input.includes) rows.push({ label: 'Includes', value: describeIncludes(input.includes) });
  return {
    title: `${input.projectName} DAG`,
    subtitle: `Exported from wickd on ${formatTimestamp(input.exportedAt)}`,
    rows,
  };
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

export function defaultExportFilename(projectName: string, format: ExportFormat, date: Date): string {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${slug(projectName)}-dag-${stamp}.${format}`;
}

/** Swap (or add) the extension so the name follows the chosen format. */
export function withExtension(filename: string, format: ExportFormat): string {
  const trimmed = filename.trim();
  const base = trimmed.replace(/\.(html|svg|png)$/i, '');
  return `${base || 'dag'}.${format}`;
}
