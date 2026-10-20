/**
 * Read the suggested tests out of an answer that is still streaming
 * (`{"tests": [{…}, {…}, {"column": "i`): every element that is complete so far.
 */
export interface PartialTest {
  column: string;
  test: string;
  reason?: string;
  values?: string[];
  to?: string;
  field?: string;
}

export function parsePartialTests(text: string): PartialTest[] {
  const start = text.indexOf('[');
  if (start < 0) return [];
  const tests: PartialTest[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      if (depth === 0 && ch === '{') objectStart = i;
      depth++;
    } else if (ch === '}' || ch === ']') {
      if (depth === 0) break; // end of the tests array
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try {
          const item = JSON.parse(text.slice(objectStart, i + 1)) as PartialTest;
          if (item && typeof item.column === 'string' && typeof item.test === 'string') tests.push(item);
        } catch {
          // incomplete or malformed element — skip
        }
        objectStart = -1;
      }
    }
  }
  return tests;
}

/** e.g. `unique`, `accepted_values [a, b]`, `relationships → customers.id` */
export function describeTest(t: Pick<PartialTest, 'test' | 'values' | 'to' | 'field'>): string {
  if (t.test === 'accepted_values' && t.values?.length) return `accepted_values [${t.values.join(', ')}]`;
  if (t.test === 'relationships' && t.to) return `relationships → ${t.to.split('.').pop()}.${t.field ?? ''}`;
  return t.test;
}
