import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Pin } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy } from '@dnd-kit/sortable';
import { api, type Project } from '../../lib/api';
import { NodeSearchResults } from '../../components/NodeSearchResults';
import { isNodeQuery } from '../../lib/nodeSearch';
import { alertError } from '../../lib/dialogs';
import {
  COLS, EmptyState, ProjectCard, ProjectCardMenu, ProjectGrid, SORT_LABELS, SORT_STORAGE_KEY, SortablePinnedCard,
  StatsBar, sortProjects, useProjectSummaries, type CardMenuState, type SortKey,
} from './ProjectCards';

interface ProjectsTabProps {
  isConfigured: boolean;
  projectsPath: string | undefined;
  /** The command palette owns the keyboard while it's open. */
  paletteOpen: boolean;
  onNewProject: () => void;
}

/** The home page's Projects tab: search, sort, pinned tiles and the project grid. */
export function ProjectsTab({ isConfigured, projectsPath, paletteOpen, onNewProject }: ProjectsTabProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const [sort, setSort] = useState<SortKey>(() => {
    const saved = localStorage.getItem(SORT_STORAGE_KEY);
    return (saved as SortKey) || 'last_opened';
  });
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [cardMenu, setCardMenu] = useState<CardMenuState | null>(null);
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const { data: projects = [], isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects.list,
    enabled: isConfigured,
  });

  const summaries = useProjectSummaries((all) => all);

  // Most recent run across all projects for the stats bar
  const lastRunAt = (summaries ?? []).reduce<string | null>((best, sm) => {
    const t = sm.latest_run?.finished_at ?? null;
    if (!t) return best;
    return !best || new Date(t).getTime() > new Date(best).getTime() ? t : best;
  }, null);

  // Model counts for sort-by-models
  const modelCounts = useMemo(
    () => new Map<number, number>((summaries ?? []).map((sm) => [sm.project_id, sm.counts?.models ?? 0])),
    [summaries],
  );

  // Memoized so the keyboard handlers below that depend on allVisible aren't
  // re-registered on every render.
  const { activeProjects, ignoredProjects, activeFiltered, pinnedProjects, unpinnedProjects, allVisible } = useMemo(() => {
    const active = projects.filter((p) => !p.ignored);
    const filtered = active.filter((p) => {
      const matchName = p.name.toLowerCase().includes(search.toLowerCase());
      const matchPlatform = !platformFilter || p.platform === platformFilter;
      return matchName && matchPlatform;
    });
    const pinned = [...filtered.filter((p) => p.pinned)].sort(
      (a, b) => (a.pin_order ?? 999) - (b.pin_order ?? 999),
    );
    const unpinned = sortProjects(filtered.filter((p) => !p.pinned), sort, modelCounts);
    return {
      activeProjects: active,
      ignoredProjects: projects.filter((p) => p.ignored),
      activeFiltered: filtered,
      pinnedProjects: pinned,
      unpinnedProjects: unpinned,
      // Flat ordered list for keyboard navigation (pinned first)
      allVisible: [...pinned, ...unpinned],
    };
  }, [projects, search, platformFilter, sort, modelCounts]);

  const platforms = Array.from(new Set(activeProjects.map((p) => p.platform))).sort();

  const handleSortChange = (key: SortKey) => {
    setSort(key);
    localStorage.setItem(SORT_STORAGE_KEY, key);
  };

  const handleIgnore = useCallback(async (id: number, ignored: boolean) => {
    try {
      await api.projects.ignore(id, ignored);
      qc.invalidateQueries({ queryKey: ['projects'] });
    } catch (e) {
      alertError(e);
    }
  }, [qc]);

  const handlePin = useCallback(async (id: number, pinned: boolean) => {
    try {
      await api.projects.pin(id, pinned);
      qc.invalidateQueries({ queryKey: ['projects'] });
    } catch (e) {
      alertError(e);
    }
  }, [qc]);

  const [activeDragId, setActiveDragId] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as number);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = pinnedProjects.findIndex((p) => p.id === active.id);
    const newIndex = pinnedProjects.findIndex((p) => p.id === over.id);
    const reordered = arrayMove(pinnedProjects, oldIndex, newIndex);

    // Optimistic update
    qc.setQueryData<Project[]>(['projects'], (old) => {
      if (!old) return old;
      return old.map((p) => {
        const idx = reordered.findIndex((r) => r.id === p.id);
        return idx !== -1 ? { ...p, pin_order: idx } : p;
      });
    });

    api.projects.reorderPins(reordered.map((p) => p.id));
  }, [pinnedProjects, qc]);

  const openCardMenu = (e: React.MouseEvent, project: Project) => {
    e.preventDefault();
    setCardMenu({ id: project.id, x: e.clientX, y: e.clientY, isIgnored: project.ignored, isPinned: project.pinned });
  };

  // Number key shortcuts: 1–9 navigate directly to that card
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (paletteOpen) return; // palette owns the keyboard while it's open
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 9) {
        const project = allVisible[n - 1];
        if (project) navigate(`/projects/${project.id}`);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [allVisible, navigate, paletteOpen]);

  // Arrow key navigation: bootstrap focus onto the grid when no card is currently focused
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (paletteOpen) return; // palette owns the keyboard while it's open — without
      // this, its search input isn't a project card, so the "already focused" check
      // below never matched, and this handler stole every arrow keypress meant for
      // the palette's own list navigation, force-focusing a card underneath it.
      if (allVisible.length === 0) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // ⌘← / ⌘→ are back/forward (navHistoryContext)
      const isArrow = e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      if (!isArrow) return;
      const activeEl = document.activeElement;
      if (cardRefs.current.some((el) => el === activeEl)) return; // card already focused — its onKeyDown handles it
      if (activeEl instanceof HTMLSelectElement) return;
      e.preventDefault();
      const startIdx = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? allVisible.length - 1 : 0;
      setFocusedIdx(startIdx);
      cardRefs.current[startIdx]?.focus();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [allVisible, paletteOpen]);

  // Arrow key navigation + Enter to open
  const makeCardKeyDown = useCallback((idx: number): ((e: React.KeyboardEvent<HTMLButtonElement>) => void) => {
    return (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // ⌘← / ⌘→ are back/forward (navHistoryContext)
      const len = allVisible.length;
      let next: number;
      if (e.key === 'ArrowRight')      { e.preventDefault(); next = Math.min(idx + 1, len - 1); }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); next = Math.max(idx - 1, 0); }
      else if (e.key === 'ArrowDown')  { e.preventDefault(); next = Math.min(idx + COLS, len - 1); }
      else if (e.key === 'ArrowUp')    { e.preventDefault(); next = Math.max(idx - COLS, 0); }
      else if (e.key === 'Enter')      { e.preventDefault(); const p = allVisible[idx]; if (p) navigate(`/projects/${p.id}`); return; }
      else { return; }
      setFocusedIdx(next);
      cardRefs.current[next]?.focus();
    };
  }, [allVisible, navigate]);

  const showShortcuts = allVisible.length > 1;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-auto p-6 gap-5 max-w-6xl mx-auto w-full">
      {/* Search + filter + sort */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search projects, models, columns…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={!isConfigured}
          className="flex-1 min-w-[200px] bg-surface-elevated border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-40"
        />
        {platforms.length > 1 && (
          <select
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value)}
            className="bg-surface-elevated border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">All platforms</option>
            {platforms.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}
        <select
          value={sort}
          onChange={(e) => handleSortChange(e.target.value as SortKey)}
          disabled={!isConfigured}
          className="bg-surface-elevated border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-40"
        >
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <option key={k} value={k}>{SORT_LABELS[k]}</option>
          ))}
        </select>
      </div>

      {/* Stats bar */}
      {isConfigured && !isLoading && activeProjects.length > 0 && (
        <StatsBar
          projects={activeFiltered.length < activeProjects.length ? activeFiltered : activeProjects}
          lastRunAt={lastRunAt}
        />
      )}

      {/* Loading / error */}
      {isLoading && isConfigured && (
        <p className="text-gray-500 text-sm">Discovering projects…</p>
      )}
      {error && (
        <p className="text-red-400 text-sm">Error: {String(error)}</p>
      )}

      {/* Empty state */}
      {isConfigured && !isLoading && activeProjects.length === 0 && ignoredProjects.length === 0 && (
        <EmptyState
          isConfigured={isConfigured}
          projectsPath={projectsPath}
          onNew={onNewProject}
        />
      )}

      {/* Pinned section */}
      {pinnedProjects.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 px-1">
            <Pin className="w-3 h-3 text-gray-600 fill-gray-600" />
            <span className="text-xs text-gray-600 font-medium">Pinned</span>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={pinnedProjects.map((p) => p.id)} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {pinnedProjects.map((project, i) => (
                  <SortablePinnedCard
                    key={project.id}
                    project={project}
                    focused={focusedIdx === i}
                    shortcutKey={showShortcuts && i + 1 <= 9 ? i + 1 : undefined}
                    cardRefs={cardRefs}
                    idx={i}
                    isDragging={activeDragId !== null}
                    onNavigate={(p) => navigate(`/projects/${p.id}`)}
                    onContextMenu={openCardMenu}
                    onFocus={setFocusedIdx}
                    onKeyDown={makeCardKeyDown}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay>
              {activeDragId !== null && (() => {
                const pinnedIdx = pinnedProjects.findIndex((p) => p.id === activeDragId);
                if (pinnedIdx === -1) return null;
                const project = pinnedProjects[pinnedIdx];
                const w = cardRefs.current[pinnedIdx]?.getBoundingClientRect().width;
                return (
                  <ProjectCard
                    project={project}
                    focused={false}
                    cardRef={() => {}}
                    dragStyle={{ width: w, opacity: 0.9 }}
                    extraClassName="rotate-1 cursor-grabbing"
                    onClick={() => {}}
                    onContextMenu={() => {}}
                    onFocus={() => {}}
                    onKeyDown={() => {}}
                  />
                );
              })()}
            </DragOverlay>
          </DndContext>
        </div>
      )}

      {/* Main grid */}
      {unpinnedProjects.length > 0 && (
        <div className="flex flex-col gap-2">
          {pinnedProjects.length > 0 && (
            <span className="text-xs text-gray-600 font-medium px-1">All projects</span>
          )}
          <ProjectGrid
            projects={unpinnedProjects}
            focusedIdx={focusedIdx}
            cardRefs={cardRefs}
            idxOffset={pinnedProjects.length}
            showShortcuts={showShortcuts}
            onNavigate={(p) => navigate(`/projects/${p.id}`)}
            onContextMenu={openCardMenu}
            onFocus={setFocusedIdx}
            onKeyDown={makeCardKeyDown}
          />
        </div>
      )}

      {/* Models / sources / columns across all projects */}
      {isConfigured && isNodeQuery(search) && (
        <NodeSearchResults query={search} projects={activeProjects} onOpen={navigate} />
      )}

      {/* Ignored section */}
      {ignoredProjects.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          <button
            onClick={() => setIgnoredOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-400 transition-colors"
          >
            {ignoredOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <span>Ignored ({ignoredProjects.length})</span>
          </button>
          {ignoredOpen && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 opacity-50">
              {ignoredProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  focused={false}
                  cardRef={() => {}}
                  onClick={() => navigate(`/projects/${project.id}`)}
                  onContextMenu={(e) => openCardMenu(e, project)}
                  onFocus={() => {}}
                  onKeyDown={() => {}}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {cardMenu && (
        <ProjectCardMenu
          menu={cardMenu}
          onIgnore={handleIgnore}
          onPin={handlePin}
          onClose={() => setCardMenu(null)}
        />
      )}
    </div>
  );
}
