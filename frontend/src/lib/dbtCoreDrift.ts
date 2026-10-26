import type { DbtCoreStatusDto } from './api';

export interface DbtCoreDrift {
  title: string;
  detail: string;
}

/** The home page warning when the installed dbt-core doesn't meet what global setup
 *  would install (a project's requirements or an adapter moved it), or null. */
export function dbtCoreDrift(status: DbtCoreStatusDto | undefined): DbtCoreDrift | null {
  if (!status?.installed || status.matches !== false || !status.version || !status.expected) return null;
  const detail = 'A project’s requirements or an adapter probably changed it while installing. '
    + 'Every project shares this dbt, so they’re all running the installed version.';
  if (status.expected_source === 'setting') {
    const chosen = status.expected.replace(/^dbt-core==/, '');
    return {
      title: `dbt-core ${status.version} is installed, not the ${chosen} you chose`,
      detail: `${detail} Reinstall to go back to ${chosen}, or change WICKD_DBT_CORE_VERSION in Global Settings.`,
    };
  }
  return {
    title: `dbt-core ${status.version} is installed, but your requirements file asks for ${status.expected}`,
    detail: `${detail} Reinstall to apply your requirements file again.`,
  };
}
