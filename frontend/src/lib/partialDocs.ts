/**
 * Read model + column descriptions out of a documentation answer that is still
 * streaming (`{"description": "…", "columns": {"a": "…", "b": "…`), so Wicky
 * can show them as they're written. Tolerates any truncation point.
 */
export interface PartialDocs {
  description: string | null;
  columns: { name: string; description: string; done: boolean }[];
}

interface Token {
  value: string;
  closed: boolean;
}

function unescape(raw: string): string {
  const safe = raw.replace(/\\(u[0-9a-fA-F]{0,3})?$/, ''); // drop a half-written escape at the end
  try {
    return JSON.parse(`"${safe}"`) as string;
  } catch {
    return safe;
  }
}

function stringTokens(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /"((?:[^"\\]|\\.)*)("?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ value: unescape(m[1]), closed: m[2] === '"' });
  }
  return tokens;
}

export function parsePartialDocs(text: string): PartialDocs {
  const tokens = stringTokens(text);
  const result: PartialDocs = { description: null, columns: [] };
  let i = 0;
  while (i < tokens.length) {
    const key = tokens[i];
    if (!key.closed) break;
    if (key.value === 'description' && result.columns.length === 0 && result.description === null) {
      result.description = tokens[i + 1]?.value ?? '';
      i += 2;
    } else if (key.value === 'columns') {
      i += 1;
      while (i < tokens.length && tokens[i].closed) {
        const value = tokens[i + 1];
        result.columns.push({ name: tokens[i].value, description: value?.value ?? '', done: !!value?.closed });
        i += 2;
      }
    } else {
      i += 2;
    }
  }
  return result;
}
