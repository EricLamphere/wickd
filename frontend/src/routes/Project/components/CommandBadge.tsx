const CMD_COLORS: Record<string, string> = {
  run:   'cmd-badge-run',
  build: 'cmd-badge-build',
  test:  'cmd-badge-test',
  seed:  'cmd-badge-seed',
};

/** Colored pill for a dbt command (run/build/test/seed); shared by Run History and the project home page. */
export function CommandBadge({ command }: { command: string }) {
  const cls = CMD_COLORS[command] ?? 'text-gray-300 bg-surface-elevated';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium ${cls}`}>
      {command}
    </span>
  );
}
