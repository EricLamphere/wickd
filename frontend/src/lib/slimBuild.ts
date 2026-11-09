// Pure helpers for slim builds (plan 18), unit-tested in slimBuild.test.ts.
import { ApiError, type EnvVarDto, type RunOpts } from './api';

export const STATE_SOURCE_KEY = 'STATE_SOURCE';
export const DEFER_KEY = 'state_defer';
export const BASE_TARGET_KEY = 'DIFF_BASE_TARGET';

export type DeferMode = 'off' | 'defer' | 'favor';

export interface SlimSettings {
  /** raw STATE_SOURCE ('' = git, the repo's base branch) */
  source: string;
  defer: DeferMode;
  /** DIFF_BASE_TARGET, the target a git: state is parsed for ('' = the active one) */
  baseTarget: string;
}

export function slimSettings(envVars: readonly Pick<EnvVarDto, 'key' | 'value'>[]): SlimSettings {
  const value = (key: string) => envVars.find((v) => v.key === key)?.value?.trim() ?? '';
  const raw = value(DEFER_KEY);
  return {
    source: value(STATE_SOURCE_KEY),
    defer: raw === 'favor' ? 'favor' : raw === 'defer' ? 'defer' : 'off',
    baseTarget: value(BASE_TARGET_KEY),
  };
}

/** What the Header chip says while deferring, e.g. "Deferring to prod". */
export function deferLabel(settings: SlimSettings): string {
  if (settings.source.startsWith('path:')) {
    const folder = settings.source.slice(5).replace(/\/+$/, '').split('/').pop() || 'prod artifacts';
    return `Deferring to ${folder}`;
  }
  return `Deferring to ${settings.baseTarget || 'the state manifest'}`;
}

/** What the build dialog builds: what the Impact view shows, or what changed vs production. */
export type BuildSource = 'shown' | 'prod';

export interface CommandParts {
  select: string;
  /** --state folder, when the select uses state: methods */
  statePath?: string | null;
  /** --defer-state folder, when deferring */
  deferPath?: string | null;
  defer: DeferMode;
  target?: string | null;
}

/** The dbt command a build runs, as you'd type it (wickd adds --profiles-dir itself). */
export function commandLine(parts: CommandParts): string {
  const args = ['dbt', 'build', '--select', parts.select || '(nothing)'];
  if (parts.statePath) args.push('--state', parts.statePath);
  if (parts.defer !== 'off') {
    args.push('--defer');
    if (parts.deferPath) args.push('--defer-state', parts.deferPath);
    if (parts.defer === 'favor') args.push('--favor-state');
  }
  if (parts.target) args.push('--target', parts.target);
  return args.join(' ');
}

/** Run options for a build: --state only for state: selectors, and the chosen defer mode. */
export function buildOpts(needsState: boolean, defer: DeferMode): RunOpts {
  return { state: needsState || undefined, defer: defer !== 'off', favor_state: defer === 'favor' };
}

/** Readable text for an API error (the backend sends `detail` as a string or `{message}`). */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string } | string | null;
    if (typeof body === 'string' && body) return body;
    if (body && typeof body === 'object' && body.message) return body.message;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Clone from prod makes sense for relations dbt builds as tables. */
export function canClone(resourceType: string, materialization: string | null | undefined): boolean {
  if (resourceType === 'snapshot') return true;
  return resourceType === 'model' && (materialization === 'table' || materialization === 'incremental');
}
