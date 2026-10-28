/** Glyph per resource type, shared by DAG nodes and node lists. */
export const TYPE_ICON: Record<string, string> = {
  model: '▣',
  source: '⬡',
  seed: '⊡',
  snapshot: '◈',
  test: '⬤',
  exposure: '◉',
  semantic_model: '◇',
  metric: '∑',
  saved_query: '⧉',
};

export function typeIconFor(resourceType: string): string {
  return TYPE_ICON[resourceType] ?? '▣';
}
