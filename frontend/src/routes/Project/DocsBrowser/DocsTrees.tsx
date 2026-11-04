import { useMemo } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Package } from 'lucide-react';
import { resourceColor, resourceIcon } from '../lib/resourceTypeStyle';
import { collectMatching, expandedDirsForFilter, type TreeDir, type TreeNode } from './docsTree';

// ---- ProjectRootTree (Project tab wrapper) ----

interface ProjectRootTreeProps {
  projectName: string;
  sections: { id: string; label: string; resourceType: string; tree: TreeDir }[];
  selectedUid: string | null;
  onSelect: (uid: string) => void;
  filterQ: string;
  expanded: Set<string>;
  onToggle: (key: string, open: boolean) => void;
}

export function ProjectRootTree({ projectName, sections, selectedUid, onSelect, filterQ, expanded, onToggle }: ProjectRootTreeProps) {
  const isFilterActive = filterQ.length > 0;
  // Default open if not explicitly collapsed
  const open = isFilterActive || !expanded.has('__root__:closed');

  const handleToggle = () => {
    // We track closed state specially so default is open
    if (open) {
      onToggle('__root__:closed', true);
    } else {
      onToggle('__root__:closed', false);
    }
  };

  const isSelected = selectedUid === '__project__';

  return (
    <div>
      {/* Project root row */}
      <div className="flex items-center">
        <button
          onClick={handleToggle}
          className="p-1 pl-2 text-gray-600 hover:text-gray-400 shrink-0"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        <button
          onClick={() => onSelect('__project__')}
          className={`flex-1 text-left py-1 pr-3 text-xs flex items-center gap-1.5 transition-colors
            ${isSelected
              ? 'text-brand-300'
              : 'text-gray-300 hover:text-gray-100'
            }`}
        >
          <Package className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-brand-400' : 'text-brand-500'}`} />
          <span className="font-semibold truncate">{projectName}</span>
          {isSelected && <ChevronRight className="w-3 h-3 ml-auto shrink-0 opacity-60" />}
        </button>
      </div>

      {/* Nested sections */}
      {open && (
        <div className="pl-3">
          {sections.map((section) => (
            <SectionTree
              key={section.id}
              sectionKey={section.id}
              label={section.label}
              resourceType={section.resourceType}
              tree={section.tree}
              selectedUid={selectedUid}
              onSelect={onSelect}
              filterQ={filterQ}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );

}

// ---- SectionTree (Project tab) ----

interface SectionTreeProps {
  sectionKey: string;
  label: string;
  resourceType: string;
  tree: TreeDir;
  selectedUid: string | null;
  onSelect: (uid: string) => void;
  filterQ: string;
  expanded: Set<string>;
  onToggle: (key: string, open: boolean) => void;
}

function SectionTree({ sectionKey, label, resourceType, tree, selectedUid, onSelect, filterQ, expanded, onToggle }: SectionTreeProps) {
  const { matchingUids, expandedDirs } = useMemo(() => {
    if (!filterQ) return { matchingUids: null, expandedDirs: null };
    return {
      matchingUids: collectMatching(tree, filterQ),
      expandedDirs: expandedDirsForFilter(tree, filterQ),
    };
  }, [tree, filterQ]);

  const totalCount = useMemo(() => {
    let n = 0;
    function walk(node: TreeNode) {
      if (node.kind === 'leaf') n++;
      else node.children.forEach(walk);
    }
    tree.children.forEach(walk);
    return n;
  }, [tree]);

  const visibleCount = matchingUids?.size ?? null;
  if (matchingUids !== null && matchingUids.size === 0) return null;

  const isFilterActive = !!filterQ && matchingUids !== null && matchingUids.size > 0;
  const open = isFilterActive || expanded.has(sectionKey);

  return (
    <div className="mb-0.5">
      <button
        onClick={() => onToggle(sectionKey, !open)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wider text-gray-500 font-semibold hover:text-gray-300 transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <span className={`${resourceColor(resourceType)}`}>{resourceIcon(resourceType, 'w-3 h-3 shrink-0')}</span>
        <span className="text-gray-500">{label}</span>
        <span className="text-gray-700 font-normal normal-case ml-0.5">
          ({visibleCount !== null ? visibleCount : totalCount})
        </span>
      </button>

      {open && (
        <div>
          {tree.children.map((child) => (
            <TreeNodeRow
              key={child.kind === 'leaf' ? child.uid : child.name}
              node={child}
              depth={1}
              resourceType={resourceType}
              selectedUid={selectedUid}
              onSelect={onSelect}
              matchingUids={matchingUids}
              expandedDirs={expandedDirs}
              pathKey={sectionKey + '/' + (child.kind === 'dir' ? child.name : '')}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- FlatTree (Database / Group tabs) ----
// Renders a flat tree of dirs with no section header — the top-level dirs (database names / group names)
// are rendered directly as collapsible rows.

interface FlatTreeProps {
  tree: TreeDir;
  selectedUid: string | null;
  onSelect: (uid: string) => void;
  filterQ: string;
  emptyLabel: string;
  expanded: Set<string>;
  onToggle: (key: string, open: boolean) => void;
}

export function FlatTree({ tree, selectedUid, onSelect, filterQ, emptyLabel, expanded, onToggle }: FlatTreeProps) {
  const q = filterQ.toLowerCase().trim();
  const matchingUids = useMemo(() => q ? collectMatching(tree, q) : null, [tree, q]);
  const expandedDirs = useMemo(() => q ? expandedDirsForFilter(tree, q) : null, [tree, q]);

  const visible = matchingUids !== null
    ? tree.children.filter((child) => {
        const uids = matchingUids as Set<string>;
        const anyMatch = (n: TreeNode): boolean =>
          n.kind === 'leaf' ? uids.has(n.uid) : n.children.some(anyMatch);
        return anyMatch(child);
      })
    : tree.children;

  if (visible.length === 0) {
    return <p className="text-xs text-gray-600 italic px-3 py-4">{emptyLabel}</p>;
  }

  return (
    <div>
      {visible.map((child) => (
        <TreeNodeRow
          key={child.kind === 'leaf' ? child.uid : child.name}
          node={child}
          depth={1}
          resourceType={child.kind === 'leaf' ? child.resourceType : ''}
          selectedUid={selectedUid}
          onSelect={onSelect}
          matchingUids={matchingUids}
          expandedDirs={expandedDirs}
          pathKey={child.kind === 'dir' ? child.name : ''}
          expanded={expanded}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

// ---- TreeNodeRow ----

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  resourceType: string;
  selectedUid: string | null;
  onSelect: (uid: string) => void;
  matchingUids: Set<string> | null;
  expandedDirs: Set<string> | null;
  pathKey: string;
  expanded: Set<string>;
  onToggle: (key: string, open: boolean) => void;
}

function TreeNodeRow({ node, depth, resourceType, selectedUid, onSelect, matchingUids, expandedDirs, pathKey, expanded, onToggle }: TreeNodeRowProps) {
  const isFilterActive = matchingUids !== null;
  const open = isFilterActive
    ? (expandedDirs?.has(pathKey) ?? false) || expanded.has(pathKey)
    : expanded.has(pathKey);

  const indent = depth * 12;

  if (node.kind === 'leaf') {
    if (matchingUids && !matchingUids.has(node.uid)) return null;
    const isSelected = node.uid === selectedUid;
    return (
      <button
        onClick={() => onSelect(node.uid)}
        style={{ paddingLeft: indent + 4 }}
        className={`w-full text-left py-1 pr-3 text-xs flex items-center gap-1.5 transition-colors group
          ${isSelected
            ? 'bg-brand-900/40 text-brand-300'
            : 'text-gray-400 hover:text-gray-200 hover:bg-surface-elevated/50'
          }`}
      >
        <span className={`shrink-0 ${isSelected ? 'text-brand-400' : resourceColor(node.resourceType)}`}>
          {resourceIcon(node.resourceType, 'w-3.5 h-3.5 shrink-0')}
        </span>
        <span className="truncate font-mono">{node.name}</span>
        {isSelected && <ChevronRight className="w-3 h-3 ml-auto shrink-0 opacity-60" />}
      </button>
    );
  }

  // Directory — hide if filter active and no matching children
  if (matchingUids !== null) {
    const uids = matchingUids;
    const hasMatch = (() => {
      function anyMatch(n: TreeNode): boolean {
        if (n.kind === 'leaf') return uids.has(n.uid);
        return n.children.some(anyMatch);
      }
      return node.children.some(anyMatch);
    })();
    if (!hasMatch) return null;
  }

  return (
    <div>
      <button
        onClick={() => onToggle(pathKey, !open)}
        style={{ paddingLeft: indent }}
        className="w-full text-left py-1 pr-3 text-xs flex items-center gap-1.5 text-gray-500 hover:text-gray-300 transition-colors"
      >
        <span className="shrink-0 text-gray-600">
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </span>
        <span className="shrink-0 text-gray-600">
          {open ? <FolderOpen className="w-3.5 h-3.5" /> : <Folder className="w-3.5 h-3.5" />}
        </span>
        <span className="truncate">{node.name}</span>
      </button>
      {open && node.children.map((child) => (
        <TreeNodeRow
          key={child.kind === 'leaf' ? child.uid : child.name}
          node={child}
          depth={depth + 1}
          resourceType={child.kind === 'leaf' ? child.resourceType : resourceType}
          selectedUid={selectedUid}
          onSelect={onSelect}
          matchingUids={matchingUids}
          expandedDirs={expandedDirs}
          pathKey={pathKey + '/' + child.name}
          expanded={expanded}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}
