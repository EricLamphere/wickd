// A rehype plugin for the dashboard text widget: writes each list item's marker ("•", "◦",
// "▪" by nesting depth, or "3." in a numbered list) into a `data-marker` property. The widget
// draws it as text rather than a CSS ::marker, so PNG exports (which copy text runs) keep it.

export interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const BULLETS = ['•', '◦', '▪'];

function isTask(li: HastNode): boolean {
  const first = li.children?.find((c) => c.type === 'element');
  const box = first?.tagName === 'input' ? first : first?.children?.find((c) => c.tagName === 'input');
  return box?.properties?.type === 'checkbox';
}

function walk(node: HastNode, depth: number): void {
  const list = node.tagName === 'ul' || node.tagName === 'ol';
  if (list) {
    const start = Number(node.properties?.start ?? 1) || 1;
    let i = 0;
    for (const li of node.children ?? []) {
      if (li.tagName !== 'li') continue;
      const marker = isTask(li) ? '' : node.tagName === 'ol' ? `${start + i}.` : BULLETS[depth % BULLETS.length];
      li.properties = { ...(li.properties ?? {}), dataMarker: marker };
      i += 1;
    }
  }
  for (const child of node.children ?? []) walk(child, list ? depth + 1 : depth);
}

export function rehypeListMarkers() {
  return (tree: HastNode) => walk(tree, 0);
}
