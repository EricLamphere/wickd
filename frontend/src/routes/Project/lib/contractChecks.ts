import { ApiError } from '../../../lib/api';
import type {
  BreakingChange, ContractCheckDto, ContractConsumers, ContractFinding, ContractResult, ContractSeverity,
} from '../../../lib/contractsApi';

/** What a consumer chip opens. */
export type ConsumerChip =
  | { kind: 'node'; type: 'model' | 'test' | 'exposure' | 'semantic_model'; label: string; uniqueId: string; title?: string; uncertain?: boolean }
  | { kind: 'metric'; label: string; metric: string }
  | { kind: 'saved_query'; label: string; name: string }
  | { kind: 'dashboard'; label: string; slug: string }
  | { kind: 'monitor'; label: string; metric: string; monitorId: number };

export interface BreakingBadge {
  severity: Exclude<ContractSeverity, 'none'>;
  text: string;
  title: string;
}

const SEVERITY_RANK: Record<ContractSeverity, number> = { none: 0, info: 1, warning: 2, error: 3 };

const PHASE_LABEL: Record<string, string> = {
  changes: 'Reading changes…',
  compiling_head: 'Compiling your changes…',
  compiling_base: 'Compiling the base…',
  types: 'Reading column types…',
  checking: 'Checking consumers…',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function phaseLabel(phase: string | null): string {
  return (phase && PHASE_LABEL[phase]) || 'Checking contracts…';
}

export function isBreaking(change: BreakingChange): boolean {
  return change.severity === 'error' || change.severity === 'warning';
}

export function describeChange(change: BreakingChange): string {
  if (change.change === 'renamed') return `${change.column} → ${change.to} (renamed)`;
  if (change.change === 'retyped') return `${change.column}: ${change.from_type} → ${change.to_type}`;
  return `${change.column} removed`;
}

export function describeFinding(finding: ContractFinding): string {
  switch (finding.kind) {
    case 'missing': return `${finding.column} is in the contract but the SQL doesn't produce it`;
    case 'extra': return `${finding.column} is produced but not in the contract`;
    case 'type_mismatch': return `${finding.column} is ${finding.actual_type}, the contract says ${finding.declared_type}`;
    default: return "Couldn't tell which columns the SQL produces (e.g. SELECT * from an unknown relation)";
  }
}

export function consumerChips(c: ContractConsumers): ConsumerChip[] {
  return [
    ...c.models.map((m) => ({ kind: 'node' as const, type: 'model' as const, label: m.name, uniqueId: m.unique_id, title: `uses ${m.columns.join(', ')}` })),
    ...c.row_uses.map((m) => ({ kind: 'node' as const, type: 'model' as const, label: m.name, uniqueId: m.unique_id, title: 'filters, joins or groups on it' })),
    ...c.possibly.map((m) => ({ kind: 'node' as const, type: 'model' as const, label: m.name, uniqueId: m.unique_id, title: "couldn't be traced, but its SQL mentions the column", uncertain: true })),
    ...c.tests.map((t) => ({ kind: 'node' as const, type: 'test' as const, label: t.name, uniqueId: t.unique_id })),
    ...c.exposures.map((e) => ({ kind: 'node' as const, type: 'exposure' as const, label: e.name, uniqueId: e.unique_id })),
    ...c.semantic_models.map((s) => ({
      kind: 'node' as const, type: 'semantic_model' as const, label: s.name, uniqueId: s.unique_id,
      title: s.fields.map((f) => `${f.kind} ${f.name}${f.uncertain ? " (expr couldn't be parsed)" : ''}`).join(', '),
      uncertain: s.fields.every((f) => f.uncertain),
    })),
    ...c.metrics.map((m) => ({ kind: 'metric' as const, label: m, metric: m })),
    ...c.saved_queries.map((s) => ({ kind: 'saved_query' as const, label: s, name: s })),
    ...c.dashboards.map((d) => ({ kind: 'dashboard' as const, label: d.title || d.slug, slug: d.slug })),
    ...c.monitors.map((m) => ({ kind: 'monitor' as const, label: `${m.metric} monitor`, metric: m.metric, monitorId: m.id })),
  ];
}

export interface ConsumerGroup {
  label: string;
  chips: ConsumerChip[];
}

const GROUP_ORDER = ['Models', 'Possibly', 'Tests', 'Exposures', 'Semantic models', 'Metrics', 'Saved queries', 'Dashboards', 'Monitors'];

function groupLabel(chip: ConsumerChip): string {
  if (chip.kind === 'node') {
    if (chip.type === 'model') return chip.uncertain ? 'Possibly' : 'Models';
    return { test: 'Tests', exposure: 'Exposures', semantic_model: 'Semantic models' }[chip.type];
  }
  return { metric: 'Metrics', saved_query: 'Saved queries', dashboard: 'Dashboards', monitor: 'Monitors' }[chip.kind];
}

/** Consumers as labelled rows (Models, Tests, …), in a fixed order; a model is listed once. */
export function consumerGroups(c: ContractConsumers): ConsumerGroup[] {
  const groups = new Map<string, ConsumerChip[]>();
  const seen = new Set<string>();
  for (const chip of consumerChips(c)) {
    const label = groupLabel(chip);
    const key = `${label}:${chip.kind === 'node' ? chip.uniqueId : chip.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.set(label, [...(groups.get(label) ?? []), chip]);
  }
  return GROUP_ORDER.filter((l) => groups.has(l)).map((label) => ({ label, chips: groups.get(label)! }));
}

/** Short label for a contract finding's kind. */
export function findingLabel(kind: ContractFinding['kind']): string {
  return { missing: 'missing', extra: 'extra', type_mismatch: 'type', unknown_columns: 'unknown' }[kind];
}

/** A contract finding without the column name (shown separately). */
export function findingDetail(finding: ContractFinding): string {
  switch (finding.kind) {
    case 'missing': return "declared in the contract, but the SQL doesn't produce it";
    case 'extra': return 'produced by the SQL, but not in the contract';
    case 'type_mismatch': return `is ${finding.actual_type}, the contract says ${finding.declared_type}`;
    default: return describeFinding(finding);
  }
}

/** Severity badge per changed model for the Impact table's Breaking column. */
export function breakingBadges(results: readonly ContractResult[]): Map<string, BreakingBadge> {
  const badges = new Map<string, BreakingBadge>();
  for (const r of results) {
    if (r.severity === 'none' || r.severity === 'info') continue;
    const breaking = r.breaking_changes.filter(isBreaking);
    const contract = r.contract_findings.filter((f) => f.kind !== 'unknown_columns');
    const parts = [
      breaking.length > 0 ? plural(breaking.length, 'breaking change') : '',
      contract.length > 0 ? `contract: ${plural(contract.length, 'problem')}` : '',
    ].filter(Boolean);
    badges.set(r.unique_id, {
      severity: r.severity,
      text: breaking.length > 0 ? `${breaking.length} breaking` : contract.length > 0 ? 'contract' : 'check',
      title: parts.join(' · ') || describeFinding({ kind: 'unknown_columns' }),
    });
  }
  return badges;
}

function consumerKeys(c: ContractConsumers): string[] {
  return consumerChips(c).map((chip) => {
    if (chip.kind === 'node') return chip.uniqueId;
    if (chip.kind === 'dashboard') return `dashboard:${chip.slug}`;
    if (chip.kind === 'monitor') return `monitor:${chip.monitorId}`;
    if (chip.kind === 'metric') return `metric:${chip.metric}`;
    return `saved_query:${chip.name}`;
  });
}

export interface CheckSummary {
  breaking: number;
  consumers: number;
  dashboards: number;
  contractProblems: number;
  severity: ContractSeverity;
}

export function summarizeCheck(results: readonly ContractResult[]): CheckSummary {
  const breaking = results.flatMap((r) => r.breaking_changes.filter(isBreaking));
  const consumers = new Set(breaking.flatMap((b) => consumerKeys(b.consumers)));
  const dashboards = new Set(breaking.flatMap((b) => b.consumers.dashboards.map((d) => d.slug)));
  const severity = results.reduce<ContractSeverity>((worst, r) => (SEVERITY_RANK[r.severity] > SEVERITY_RANK[worst] ? r.severity : worst), 'none');
  return {
    breaking: breaking.length,
    consumers: consumers.size,
    dashboards: dashboards.size,
    contractProblems: results.reduce((n, r) => n + r.contract_findings.filter((f) => f.kind !== 'unknown_columns').length, 0),
    severity,
  };
}

/** "2 breaking changes for 5 consumers, incl. 1 dashboard" (Git page), or null when nothing breaks. */
export function summaryLine(s: CheckSummary): string | null {
  const parts: string[] = [];
  if (s.breaking > 0) {
    const dashboards = s.dashboards > 0 ? `, incl. ${plural(s.dashboards, 'dashboard')}` : '';
    parts.push(`${plural(s.breaking, 'breaking change')} for ${plural(s.consumers, 'consumer')}${dashboards}`);
  }
  if (s.contractProblems > 0) parts.push(`${plural(s.contractProblems, 'contract problem')}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Whether a stored check is for the base shown now (branch mode; null = the server default). */
export function checkMatchesBase(check: ContractCheckDto, base: string | null, resolvedBase: string | null): boolean {
  if (check.scope !== 'branch') return true;
  const wanted = base ?? resolvedBase;
  return !wanted || check.base === wanted;
}

export function contractStartError(err: unknown): string | null {
  if (err instanceof ApiError && err.status === 409) return null; // already running; its events update the query
  if (err instanceof ApiError && err.status === 503) return 'Contract checks are unavailable in this build (the wickd Pro package is not installed).';
  if (err instanceof ApiError && typeof err.body === 'string') return err.body;
  return err instanceof Error ? err.message : 'Failed to start the contract check';
}
