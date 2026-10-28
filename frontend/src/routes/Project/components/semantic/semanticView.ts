import type { SemanticCheckDto, SemanticIssue, SemanticStatusDto } from '../../../../lib/semanticApi';

const SPEC_LABEL: Record<SemanticStatusDto['spec'], string> = {
  legacy: 'legacy YAML spec',
  latest: 'latest YAML spec',
  mixed: 'legacy + latest YAML spec',
  none: '',
};

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "dbt-core 1.10.13 · duckdb · legacy YAML spec · 2 semantic models · 7 metrics · 1 saved query" */
export function statusLine(status: SemanticStatusDto): string {
  const { counts } = status;
  return [
    status.dbt_core ? `dbt-core ${status.dbt_core}` : 'dbt-core not installed',
    status.adapter_type ?? '',
    SPEC_LABEL[status.spec],
    count(counts.semantic_models, 'semantic model', 'semantic models'),
    count(counts.metrics, 'metric', 'metrics'),
    count(counts.saved_queries, 'saved query', 'saved queries'),
  ].filter(Boolean).join(' · ');
}

export type IssueSeverity = 'error' | 'warning' | 'future_error';

export interface IssueGroup {
  key: string;
  objectType: SemanticIssue['object_type'];
  objectName: string | null;
  issues: { severity: IssueSeverity; message: string; element: string | null }[];
  worst: IssueSeverity;
}

const RANK: Record<IssueSeverity, number> = { error: 0, future_error: 1, warning: 2 };

/** Issues grouped by the semantic model / metric / saved query they're about; worst groups first. */
export function groupIssues(results: SemanticCheckDto['results']): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  const add = (severity: IssueSeverity, issue: SemanticIssue) => {
    const key = `${issue.object_type ?? 'project'}:${issue.object_name ?? ''}`;
    const group = groups.get(key) ?? {
      key, objectType: issue.object_type, objectName: issue.object_name, issues: [], worst: severity,
    };
    const element = issue.element_name ? `${issue.element_type ?? 'element'} ${issue.element_name}` : null;
    group.issues.push({ severity, message: issue.message, element });
    if (RANK[severity] < RANK[group.worst]) group.worst = severity;
    groups.set(key, group);
  };
  for (const i of results.errors ?? []) add('error', i);
  for (const i of results.future_errors ?? []) add('future_error', i);
  for (const i of results.warnings ?? []) add('warning', i);
  return [...groups.values()].sort((a, b) =>
    RANK[a.worst] - RANK[b.worst] || (a.objectName ?? '').localeCompare(b.objectName ?? ''));
}

export const OBJECT_LABEL: Record<NonNullable<SemanticIssue['object_type']>, string> = {
  semantic_model: 'Semantic model',
  metric: 'Metric',
  saved_query: 'Saved query',
};

/** reason_codes for which the dbt-core version dialog offers a compatible version. */
export const INCOMPATIBLE_REASONS = new Set(['too_old', 'latest_spec_needs_1_12', 'no_cli_release', 'unknown_version']);
