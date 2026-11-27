// dbt colors its terminal output with ANSI escape codes (e.g. "\x1b[32mPASS\x1b[0m"), and those
// codes stay in captured logs. Strip them before matching keywords or showing a line as text.

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE, '');
}
