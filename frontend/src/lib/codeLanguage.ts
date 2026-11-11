// Map a Markdown fence's language (```sql, ```yml, ```bash, …) to a Monaco language id.
// Pure; tested in codeLanguage.test.ts.

export interface LanguageInfo {
  id: string;
  aliases?: string[];
  extensions?: string[];
}

/** Fence names Monaco doesn't know itself. dbt models are Jinja + SQL, so Jinja reads best as SQL. */
const EXTRA_ALIASES: Record<string, string> = {
  bash: 'shell',
  sh: 'shell',
  zsh: 'shell',
  console: 'shell',
  shell: 'shell',
  jinja: 'sql',
  jinja2: 'sql',
  dbt: 'sql',
  yml: 'yaml',
  py: 'python',
  gql: 'graphql',
  js: 'javascript',
  ts: 'typescript',
};

/** Fences that are deliberately plain. */
const PLAIN = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'output', 'log']);

/** The Monaco language id for a fence's language, or null to leave the block unhighlighted. */
export function resolveMonacoLanguage(fence: string | null | undefined, languages: readonly LanguageInfo[]): string | null {
  const name = (fence ?? '').trim().toLowerCase();
  if (PLAIN.has(name)) return null;
  const wanted = EXTRA_ALIASES[name] ?? name;
  const known = (id: string) => languages.some((l) => l.id === id);
  if (known(wanted)) return wanted;
  const byAlias = languages.find((l) =>
    (l.aliases ?? []).some((a) => a.toLowerCase() === wanted)
    || (l.extensions ?? []).some((e) => e.toLowerCase() === `.${wanted}`));
  return byAlias?.id ?? null;
}

/** The language of a fenced block from its `language-xxx` class, as react-markdown renders it. */
export function fenceLanguage(className: string | undefined): string | null {
  const match = /(?:^|\s)language-([\w+#.-]+)/.exec(className ?? '');
  return match ? match[1] : null;
}
