import type { StartRefactorDetail } from '../../lib/refactorEvents';

/** The prompt shown before a refactor starts: what's being renamed / extracted, and a starting name. */
export function refactorPrompt(detail: StartRefactorDetail): { title: string; message: string; initial: string; confirm: string } {
  if (detail.op === 'rename_model') {
    return {
      title: 'Rename model',
      message: `New name for ${detail.model}. Its file, every ref() and its YAML entry are updated; you review the changes first.`,
      initial: detail.model,
      confirm: 'Prepare rename',
    };
  }
  if (detail.op === 'rename_column') {
    return {
      title: 'Rename column',
      message: `New name for ${detail.model}.${detail.column}. The model, its YAML and downstream models that use it are updated; you review the changes first.`,
      initial: detail.column ?? '',
      confirm: 'Prepare rename',
    };
  }
  return {
    title: 'Extract CTE to a model',
    message: `Name of the new model for the ${detail.cte} CTE of ${detail.model}. ${detail.model} will select from it with ref(); you review the changes first.`,
    initial: `${detail.model}_${detail.cte ?? ''}`,
    confirm: 'Prepare extract',
  };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** null when the name is usable, else why not. */
export function nameProblem(name: string, current: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name.';
  if (!IDENTIFIER.test(trimmed)) return 'Use letters, digits and underscores, not starting with a digit.';
  if (trimmed === current) return 'That’s the current name.';
  return null;
}
