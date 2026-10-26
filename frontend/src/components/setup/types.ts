import type { GlobalEnvVarDto, SetupFieldError } from '../../lib/api';

export interface SetupForm {
  projectsPath: string;
  createProjectsDir: boolean;
  /** '' → auto-detect */
  pythonPath: string;
  /** '' → no file: global setup installs dbt-core (dbtCoreVersion) */
  requirementsPath: string;
  createRequirementsFile: boolean;
  /** dbt-core to install when the requirements file doesn't decide it; '' = latest,
   *  null = not chosen yet (the newest release once the list loads) */
  dbtCoreVersion: string | null;
  /** Once the user edits the requirements path, stop deriving it from the projects folder. */
  requirementsTouched: boolean;
  theme: 'dark' | 'light';
  /** Global env vars; null until the current ones have loaded (null on save → left unchanged). */
  envVars: GlobalEnvVarDto[] | null;
}

/** Suggested global requirements file: `<projects folder>/requirements.txt`. */
export function defaultRequirementsPath(projectsPath: string): string {
  const base = projectsPath.trim().replace(/\/+$/, '');
  return base ? `${base}/requirements.txt` : '';
}

export type StepId =
  | 'welcome'
  | 'projects'
  | 'python'
  | 'packages'
  | 'environment'
  | 'preferences'
  | 'review'
  | 'install';

export const STEPS: { id: StepId; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'projects', label: 'Projects' },
  { id: 'python', label: 'Python' },
  { id: 'packages', label: 'dbt packages' },
  { id: 'environment', label: 'Environment variables' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'review', label: 'Review' },
  { id: 'install', label: 'Install' },
];

/** Which step owns each server-validated field, so a failed save jumps back to it. */
export const FIELD_STEP: Record<SetupFieldError['field'], StepId> = {
  dbt_projects_path: 'projects',
  python_path: 'python',
  global_requirements_path: 'packages',
  dbt_core_version: 'packages',
  global_env_vars: 'environment',
};

export interface StepProps {
  form: SetupForm;
  update: (patch: Partial<SetupForm>) => void;
  /** Server error for this step's field, if the last save failed on it. */
  error: string | null;
  /** Which server field `error` is about, when it came from saving. */
  errorField?: SetupFieldError['field'] | null;
  onEnter: () => void;
}
