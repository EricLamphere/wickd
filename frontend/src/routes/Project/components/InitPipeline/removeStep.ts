import type { InitStepDto } from '../../../../lib/api';

const DEFAULT_INIT_DIR = 'wickd/init';

export function bareStepName(name: string): string {
  return name.replace(/^custom:\s*/, '');
}

/**
 * Whether the step's script is one wickd keeps in the project's init dir (so it can be
 * deleted with the step), rather than a linked script elsewhere, which is never deleted.
 */
export function ownsScript(step: Pick<InitStepDto, 'name' | 'script_path'>, projectPath: string, initDir: string): boolean {
  if (!step.script_path) return true;
  const dir = (initDir || DEFAULT_INIT_DIR).replace(/^\/+|\/+$/g, '');
  const expected = `${projectPath.replace(/\/+$/, '')}/${dir}/${bareStepName(step.name)}.sh`;
  return step.script_path === expected;
}

/** The remove-step confirm's wording. */
export function removeStepMessage(step: Pick<InitStepDto, 'name' | 'script_path'>, owned: boolean): string {
  const name = bareStepName(step.name);
  if (owned) {
    return `Remove "${name}" from the init pipeline? Its script stays in the init folder unless you also delete it.`;
  }
  return `Remove "${name}" from the init pipeline? The linked script (${step.script_path}) isn't deleted.`;
}
