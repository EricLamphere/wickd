import { BookOpen, Loader2 } from 'lucide-react';
import { isDocsRunActive, type WorkspaceDocsProject, type WorkspaceDocsState } from '../../lib/workspaceApi';
import { docStats, type ProjectDocs } from './docsJoin';
import { platformMeta, timeAgo } from './ProjectCards';

export function NoProjectsSelected({ projects, onSelectAll }: {
  projects: WorkspaceDocsProject[];
  onSelectAll: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-3 p-6 text-center">
      <BookOpen className="w-7 h-7 text-gray-600" />
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium text-gray-300">Browse several projects&rsquo; docs in one place</p>
        <p className="text-sm text-gray-500">Pick projects from the Projects menu above. Your choice is saved.</p>
      </div>
      {projects.length > 0 && (
        <button
          onClick={onSelectAll}
          className="px-3 py-1.5 text-xs rounded border border-gray-700 bg-surface-elevated hover:bg-gray-700 text-gray-300 transition-colors"
        >
          Select all {projects.length}
        </button>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium tracking-wider text-gray-600 uppercase">{label}</span>
      <span className="text-sm text-gray-200">{value}</span>
    </div>
  );
}

const BUSY_LABEL: Partial<Record<WorkspaceDocsState, string>> = {
  queued: 'Queued',
  initializing: 'Running init',
  generating: 'Generating',
};

function ProjectDocsCard({ project, docs, failed, onOpen, onGenerate }: {
  project: WorkspaceDocsProject;
  docs: ProjectDocs | undefined;
  failed: boolean;
  onOpen: () => void;
  onGenerate: () => void;
}) {
  const busy = isDocsRunActive(project.state);
  const stats = docs ? docStats(docs.data) : null;
  const coverage = stats && stats.documentable > 0
    ? `${Math.round((stats.described / stats.documentable) * 100)}%`
    : '—';

  return (
    <div className="flex flex-col gap-3 p-4 border border-gray-800 rounded-xl bg-surface-panel">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-base leading-none">{platformMeta(project.platform).icon}</span>
        {docs ? (
          <button onClick={onOpen} className="font-semibold text-gray-100 truncate hover:text-brand-300 transition-colors">
            {project.name}
          </button>
        ) : (
          <span className="font-semibold text-gray-100 truncate">{project.name}</span>
        )}
        {project.generated_at && !busy && (
          <span className="ml-auto text-[11px] text-gray-600 whitespace-nowrap">{timeAgo(project.generated_at)}</span>
        )}
        {busy && (
          <span className="flex items-center gap-1 ml-auto text-[11px] text-gray-500 whitespace-nowrap">
            <Loader2 className="w-3 h-3 animate-spin" /> {BUSY_LABEL[project.state]}
          </span>
        )}
      </div>

      {stats && (
        <div className="grid grid-cols-4 gap-2">
          <Stat label="Models" value={stats.models} />
          <Stat label="Sources" value={stats.sources} />
          <Stat label="Tests" value={stats.tests} />
          <Stat label="Described" value={coverage} />
        </div>
      )}
      {failed && <p className="text-xs text-red-400">Couldn&rsquo;t read this project&rsquo;s docs. Try regenerating them.</p>}
      {project.state === 'error' && project.error && (
        <pre className="max-h-24 p-2 overflow-auto text-[11px] text-red-400 whitespace-pre-wrap rounded bg-surface-app">{project.error}</pre>
      )}
      {!project.generated_at && !busy && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-gray-500">No docs yet</span>
          <button
            onClick={onGenerate}
            className="px-2.5 py-1 text-xs text-white transition-colors rounded bg-brand-600 hover:bg-brand-500"
          >
            Generate
          </button>
        </div>
      )}
    </div>
  );
}

/** What's in the combined docs: shown until a node is opened. */
export function CombinedDocsOverview({ projects, loaded, failed, onOpen, onGenerate }: {
  projects: WorkspaceDocsProject[];
  loaded: ProjectDocs[];
  failed: number[];
  onOpen: (projectId: number) => void;
  onGenerate: (projectId: number) => void;
}) {
  const totals = loaded.map((docs) => docStats(docs.data)).reduce(
    (sum, s) => ({ models: sum.models + s.models, sources: sum.sources + s.sources, tests: sum.tests + s.tests }),
    { models: 0, sources: 0, tests: 0 },
  );

  return (
    <div className="flex flex-col gap-5 max-w-5xl px-8 py-6 mx-auto">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-gray-100">Combined docs</h1>
        <p className="text-sm text-gray-500">
          {totals.models} models, {totals.sources} sources and {totals.tests} tests across {projects.length} {projects.length === 1 ? 'project' : 'projects'}.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {projects.map((project) => (
          <ProjectDocsCard
            key={project.id}
            project={project}
            docs={loaded.find((d) => d.projectId === project.id)}
            failed={failed.includes(project.id)}
            onOpen={() => onOpen(project.id)}
            onGenerate={() => onGenerate(project.id)}
          />
        ))}
      </div>
    </div>
  );
}
