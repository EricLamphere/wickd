import type { FileNode } from '../../../lib/api';

export type TreeNode = Omit<FileNode, 'children'> & { expanded?: boolean; children?: TreeNode[] };

export function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const lower = q.toLowerCase();
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (node.is_dir) {
      const filteredChildren = filterTree(node.children ?? [], q);
      if (filteredChildren.length > 0 || node.name.toLowerCase().includes(lower)) {
        result.push({ ...node, expanded: true, children: filteredChildren.length > 0 ? filteredChildren : node.children });
      }
    } else {
      if (node.name.toLowerCase().includes(lower)) {
        result.push(node);
      }
    }
  }
  return result;
}
