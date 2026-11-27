// The Runs page Log tab's text for Copy / Download: the command line, then dbt's output without
// its ANSI color codes. Pure; tested in runLog.test.ts.
import { stripAnsi } from '../../../lib/ansi';

export function runLogText(cliCommand: string | null, lines: readonly string[]): string {
  const body = lines.map(stripAnsi);
  const all = cliCommand ? [`$ ${cliCommand}`, '', ...body] : body;
  return all.length === 0 ? '' : `${all.join('\n')}\n`;
}

/** File name (without extension) for a downloaded run log, e.g. `dbt-build-run-42`. */
export function runLogFilename(command: string, invocationId: number): string {
  const slug = command.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `dbt-${slug || 'run'}-run-${invocationId}`;
}
