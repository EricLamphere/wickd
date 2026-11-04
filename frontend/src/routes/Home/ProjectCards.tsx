import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderOpen, Pin, Plus } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api, type Project, type ProjectSummary } from '../../lib/api';

// ── Platform config ───────────────────────────────────────────────────────────

const PLATFORM_META: Record<string, { icon: string; accent: string }> = {
  postgres:   { icon: '🐘', accent: 'border-blue-700/60' },
  bigquery:   { icon: '☁️', accent: 'border-sky-700/60' },
  snowflake:  { icon: '❄️', accent: 'border-cyan-700/60' },
  redshift:   { icon: '🔴', accent: 'border-red-700/60' },
  duckdb:     { icon: '🦆', accent: 'border-yellow-700/60' },
  spark:      { icon: '⚡', accent: 'border-orange-700/60' },
  databricks: { icon: '🧱', accent: 'border-orange-800/60' },
  athena:     { icon: '🦉', accent: 'border-purple-700/60' },
  trino:      { icon: '🔷', accent: 'border-indigo-700/60' },
  clickhouse: { icon: '🏡', accent: 'border-yellow-600/60' },
  unknown:    { icon: '⬡',  accent: 'border-gray-700/60' },
};

export function platformMeta(platform: string) {
  return PLATFORM_META[platform.toLowerCase()] ?? PLATFORM_META.unknown;
}

// ── Sort ──────────────────────────────────────────────────────────────────────

export type SortKey = 'name' | 'last_opened' | 'models';
export const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  last_opened: 'Last opened',
  models: 'Model count',
};
export const SORT_STORAGE_KEY = 'wickd:home-sort';

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    success: 'status-badge-success border',
    error:   'status-badge-error border',
    warn:    'status-badge-warn border',
    running: 'status-badge-running border',
  };
  const cls = map[status] ?? 'bg-zinc-800 text-zinc-400 border border-zinc-700';
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${cls}`}>
      {status}
    </span>
  );
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const RESOURCE_COLOR: Record<string, string> = {
  models:  'text-brand-400',
  sources: 'text-blue-400',
  seeds:   'text-emerald-400',
  tests:   'text-red-400',
};

function CountChip({ label, count }: { label: string; count: number }) {
  return (
    <span className="flex items-center gap-1 text-[11px] text-gray-500">
      <span className={`font-medium ${RESOURCE_COLOR[label] ?? 'text-gray-400'}`}>{count}</span>
      {label}
    </span>
  );
}

// ── Project summaries ─────────────────────────────────────────────────────────

export const SUMMARIES_KEY = ['project-summaries'] as const;
const EMPTY_COUNTS = {
  models: 0, sources: 0, seeds: 0, tests: 0, semantic_models: 0, metrics: 0, saved_queries: 0, macros: 0,
};

/** One request for every card's node counts + latest run (per-card fetches queue behind the browser's connection cap). */
export function useProjectSummaries<T>(select: (all: ProjectSummary[]) => T) {
  return useQuery({
    queryKey: SUMMARIES_KEY,
    queryFn: api.projects.summaries,
    select,
  }).data;
}

// ── Project card ──────────────────────────────────────────────────────────────

interface ProjectCardProps {
  project: Project;
  focused: boolean;
  shortcutKey?: number;
  cardRef: (el: HTMLButtonElement | null) => void;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onFocus: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
  dragStyle?: React.CSSProperties;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
  extraClassName?: string;
}

export function ProjectCard({ project, focused, shortcutKey, cardRef, onClick, onContextMenu, onFocus, onKeyDown, dragStyle, dragHandleProps, extraClassName }: ProjectCardProps) {
  const meta = platformMeta(project.platform);

  const summary = useProjectSummaries((all) => all.find((x) => x.project_id === project.id));
  const latest = summary?.latest_run ?? null;
  // A project that has never been compiled has no manifest — show zeros, not "loading…".
  const counts = summary === undefined ? null : summary.counts ?? EMPTY_COUNTS;

  return (
    <button
      ref={cardRef}
      style={dragStyle}
      {...(dragHandleProps ?? {})}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      className={[
        'group flex flex-col gap-3 min-w-0 bg-surface-panel border rounded-xl p-4 text-left',
        'hover:border-brand-600/70 hover:bg-surface-elevated/60 transition-all duration-150',
        'focus:outline-none',
        focused
          ? 'ring-2 ring-brand-500 border-brand-600/70'
          : `border-gray-800 ${meta.accent}`,
        extraClassName ?? '',
      ].filter(Boolean).join(' ')}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base leading-none">{meta.icon}</span>
          <span className="font-semibold text-gray-100 truncate">{project.name}</span>
          {project.pinned && (
            <Pin className="w-3 h-3 text-brand-400 shrink-0 fill-brand-400" />
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {shortcutKey !== undefined && (
            <span className="text-[10px] font-mono text-gray-600 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 leading-none">
              {shortcutKey}
            </span>
          )}
          {latest && <StatusPill status={latest.status} />}
        </div>
      </div>

      {/* Path — ellipsis at the start (rtl) so the project's own folder stays visible */}
      <span
        dir="rtl"
        title={project.path}
        className="block max-w-full truncate text-left text-[11px] text-gray-600 font-mono leading-none"
      >
        <bdi dir="ltr">{project.path}</bdi>
      </span>

      {/* Footer: node type counts + last opened */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-auto pt-2 border-t border-gray-800/60">
        {counts ? (
          <>
            <CountChip label="models"  count={counts.models} />
            <span className="text-gray-700 text-[11px]">·</span>
            <CountChip label="sources" count={counts.sources} />
            <span className="text-gray-700 text-[11px]">·</span>
            <CountChip label="seeds"   count={counts.seeds} />
            <span className="text-gray-700 text-[11px]">·</span>
            <CountChip label="tests"   count={counts.tests} />
          </>
        ) : (
          <span className="text-[11px] text-gray-700 italic">loading…</span>
        )}
        {project.last_opened_at && (
          <span className="ml-auto text-[11px] text-gray-600 whitespace-nowrap">
            {timeAgo(project.last_opened_at)}
          </span>
        )}
      </div>
    </button>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

export function StatsBar({ projects, lastRunAt }: { projects: Project[]; lastRunAt: string | null }) {
  const platforms = Array.from(new Set(projects.map((p) => p.platform))).sort();

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-xs text-gray-500">
      <span>
        <span className="font-medium text-gray-300">{projects.length}</span>{' '}
        {projects.length === 1 ? 'project' : 'projects'}
      </span>
      {platforms.length > 0 && (
        <span className="flex items-center gap-2">
          {platforms.map((p) => {
            const m = platformMeta(p);
            const count = projects.filter((pr) => pr.platform === p).length;
            return (
              <span key={p} className="flex items-center gap-1">
                <span>{m.icon}</span>
                <span className="capitalize">{p}</span>
                {count > 1 && <span className="text-gray-600">×{count}</span>}
              </span>
            );
          })}
        </span>
      )}
      {lastRunAt && (
        <span className="ml-auto">
          last run <span className="text-gray-400">{timeAgo(lastRunAt)}</span>
        </span>
      )}
    </div>
  );
}

// ── Sortable pinned card ──────────────────────────────────────────────────────

export function SortablePinnedCard({
  project,
  focused,
  shortcutKey,
  cardRefs,
  idx,
  isDragging,
  onNavigate,
  onContextMenu,
  onFocus,
  onKeyDown,
}: {
  project: Project;
  focused: boolean;
  shortcutKey?: number;
  cardRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
  idx: number;
  isDragging: boolean;
  onNavigate: (project: Project) => void;
  onContextMenu: (e: React.MouseEvent, project: Project) => void;
  onFocus: (idx: number) => void;
  onKeyDown: (idx: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging: isThisCardDragging } = useSortable({ id: project.id });

  return (
    <ProjectCard
      project={project}
      focused={focused}
      shortcutKey={shortcutKey}
      cardRef={(el) => { setNodeRef(el); cardRefs.current[idx] = el; }}
      dragStyle={{
        transform: CSS.Translate.toString(transform) ?? undefined,
        transition: transition ?? undefined,
        opacity: isThisCardDragging ? 0.4 : 1,
      }}
      dragHandleProps={{ ...attributes, ...listeners } as React.HTMLAttributes<HTMLButtonElement>}
      extraClassName={isDragging ? 'cursor-grabbing' : 'cursor-grab'}
      onClick={() => onNavigate(project)}
      onContextMenu={(e) => onContextMenu(e, project)}
      onFocus={() => onFocus(idx)}
      onKeyDown={onKeyDown(idx)}
    />
  );
}

// ── Context menu ──────────────────────────────────────────────────────────────

export interface CardMenuState {
  id: number;
  x: number;
  y: number;
  isIgnored: boolean;
  isPinned: boolean;
}

export function ProjectCardMenu({ menu, onIgnore, onPin, onClose }: {
  menu: CardMenuState;
  onIgnore: (id: number, ignored: boolean) => void;
  onPin: (id: number, pinned: boolean) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: Math.min(menu.y, window.innerHeight - 100),
        left: Math.min(menu.x, window.innerWidth - 160),
        zIndex: 50,
      }}
      className="bg-surface-panel border border-gray-700 rounded-lg shadow-xl py-1 w-36"
    >
      <button
        onClick={() => { onPin(menu.id, !menu.isPinned); onClose(); }}
        className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-surface-elevated transition-colors"
      >
        {menu.isPinned ? 'Unpin' : 'Pin to top'}
      </button>
      <button
        onClick={() => { onIgnore(menu.id, !menu.isIgnored); onClose(); }}
        className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-surface-elevated transition-colors"
      >
        {menu.isIgnored ? 'Un-ignore' : 'Ignore'}
      </button>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

export function EmptyState({ isConfigured, projectsPath, onNew }: {
  isConfigured: boolean;
  projectsPath: string | undefined;
  onNew: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
      <div className="w-16 h-16 rounded-2xl bg-surface-elevated border border-gray-800 flex items-center justify-center">
        <FolderOpen className="w-7 h-7 text-gray-600" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium text-gray-400">No dbt projects found</p>
        {projectsPath && (
          <p className="text-xs font-mono text-gray-700">{projectsPath}</p>
        )}
      </div>
      {isConfigured && (
        <button
          onClick={onNew}
          className="mt-2 flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add your first project
        </button>
      )}
    </div>
  );
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

export function sortProjects(projects: Project[], key: SortKey, modelCounts: Map<number, number>): Project[] {
  return [...projects].sort((a, b) => {
    if (key === 'name') return a.name.localeCompare(b.name);
    if (key === 'last_opened') {
      const ta = a.last_opened_at ? new Date(a.last_opened_at).getTime() : 0;
      const tb = b.last_opened_at ? new Date(b.last_opened_at).getTime() : 0;
      return tb - ta;
    }
    if (key === 'models') {
      return (modelCounts.get(b.id) ?? 0) - (modelCounts.get(a.id) ?? 0);
    }
    return 0;
  });
}

// ── Project grid ──────────────────────────────────────────────────────────────

export const COLS = 3;

interface ProjectGridProps {
  projects: Project[];
  focusedIdx: number | null;
  cardRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
  idxOffset: number;
  showShortcuts: boolean;
  onNavigate: (project: Project) => void;
  onContextMenu: (e: React.MouseEvent, project: Project) => void;
  onFocus: (idx: number) => void;
  onKeyDown: (idx: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}

export function ProjectGrid({ projects, focusedIdx, cardRefs, idxOffset, showShortcuts, onNavigate, onContextMenu, onFocus, onKeyDown }: ProjectGridProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {projects.map((project, i) => {
        const idx = idxOffset + i;
        const shortcutNum = idx + 1;
        return (
          <ProjectCard
            key={project.id}
            project={project}
            focused={focusedIdx === idx}
            shortcutKey={showShortcuts && shortcutNum <= 9 ? shortcutNum : undefined}
            cardRef={(el) => { cardRefs.current[idx] = el; }}
            onClick={() => onNavigate(project)}
            onContextMenu={(e) => onContextMenu(e, project)}
            onFocus={() => onFocus(idx)}
            onKeyDown={onKeyDown(idx)}
          />
        );
      })}
    </div>
  );
}
