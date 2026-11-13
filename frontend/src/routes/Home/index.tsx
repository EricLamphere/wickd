import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, FolderKanban, Plus, RefreshCw, Settings2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useUrlTab } from '../../lib/useUrlTab';
import { alertError } from '../../lib/dialogs';
import NewProjectModal from '../Project/components/NewProjectModal';
import { GlobalSettingsModal } from '../../components/GlobalSettingsModal';
import { HomeCommandPalette } from '../../components/HomeCommandPalette';
import { DbtCoreDriftBanner } from '../../components/DbtCoreDriftBanner';
import { SUMMARIES_KEY } from './ProjectCards';
import { ProjectsTab } from './ProjectsTab';
import { CombinedDocs } from './CombinedDocs';
import { WorkspaceWickyPane } from './WorkspaceWickyPane';
import { HomeBottomPane } from './HomeBottomPane';

const HOME_TABS = ['projects', 'docs'] as const;
type HomeTab = (typeof HOME_TABS)[number];

const TABS: { id: HomeTab; label: string; icon: React.ReactNode }[] = [
  { id: 'projects', label: 'Projects', icon: <FolderKanban className="w-3.5 h-3.5" /> },
  { id: 'docs', label: 'Docs', icon: <BookOpen className="w-3.5 h-3.5" /> },
];

/** App home: Projects / combined Docs tabs, with Wicky across projects (Pro) on the right. */
export default function Home() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useUrlTab<HomeTab>('tab', HOME_TABS, 'projects');
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');

  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => api.settings.get(),
  });

  const { data: dbtCoreStatus } = useQuery({
    queryKey: ['dbt-core-status'],
    queryFn: () => api.init.dbtCoreStatus(),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
    // Re-check on every visit: a project's init pipeline may have changed dbt-core meanwhile
    refetchOnMount: 'always',
  });

  const isConfigured = appSettings?.configured ?? true;

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects.list,
    enabled: isConfigured,
  });

  const openNewProject = useCallback(() => {
    if (isConfigured) setNewProjectOpen(true);
    else setGlobalSettingsOpen(true);
  }, [isConfigured]);

  useEffect(() => {
    window.addEventListener('wickd:new-project', openNewProject);
    return () => window.removeEventListener('wickd:new-project', openNewProject);
  }, [openNewProject]);

  // Global ⌘K listener — mirrors ProjectLayout's, since this page sits
  // outside ProjectLayout and never mounts its project-scoped CommandPalette.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => {
          setPaletteQuery('');
          return !open;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const handleRescan = async () => {
    try {
      await api.projects.rescan();
    } catch (e) {
      alertError(e);
      return;
    }
    qc.invalidateQueries({ queryKey: ['projects'] });
    qc.invalidateQueries({ queryKey: SUMMARIES_KEY });
    qc.invalidateQueries({ queryKey: ['workspace-docs'] });
  };

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex flex-col flex-1 min-w-0">
        {appSettings && !isConfigured && (
          <div className="flex items-center justify-between gap-4 mx-6 mt-4 px-4 py-3 bg-amber-950/40 border border-amber-800/60 rounded-lg shrink-0">
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium text-amber-300">WICKD_DBT_PROJECTS_PATH is not set</p>
              <p className="text-xs text-amber-500">Set the path to your dbt projects folder before scanning or creating projects.</p>
            </div>
            <button
              onClick={() => setGlobalSettingsOpen(true)}
              className="shrink-0 px-3 py-1.5 text-xs rounded bg-amber-700 hover:bg-amber-600 text-white font-medium transition-colors"
            >
              Configure
            </button>
          </div>
        )}

        {dbtCoreStatus && !dbtCoreStatus.installed && (
          <div className="flex items-center gap-4 mx-6 mt-4 px-4 py-3 bg-red-950/40 border border-red-800/60 rounded-lg shrink-0">
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium text-red-300">dbt is not installed</p>
              <p className="text-xs text-red-500">
                Click Run global setup in the header to install it — your global requirements file if one is set, otherwise <code className="font-mono">dbt-core</code> (the version chosen in setup, or the latest).
              </p>
            </div>
          </div>
        )}

        <div className="shrink-0 empty:hidden mx-6 [&>*]:mt-4">
          <DbtCoreDriftBanner status={dbtCoreStatus} />
        </div>

        {/* Tabs + workspace actions */}
        <div className="flex items-center justify-between gap-4 px-6 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-4">
            <div className="flex items-center" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`relative flex items-center gap-1.5 px-3 py-3 text-sm font-medium transition-colors ${
                    tab === t.id ? 'text-brand-300' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {t.icon}
                  {t.label}
                  {tab === t.id && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-400 rounded-t" />}
                </button>
              ))}
            </div>
            {dbtCoreStatus?.version && (
              <span className="text-[11px] text-gray-600">dbt {dbtCoreStatus.version}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setGlobalSettingsOpen(true)}
              title="Global settings"
              className="p-2 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-surface-elevated transition-colors"
            >
              <Settings2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleRescan}
              disabled={!isConfigured}
              title="Rescan projects"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-surface-elevated hover:bg-gray-700 text-gray-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed border border-gray-800"
            >
              <RefreshCw className="w-3 h-3" />
              Rescan
            </button>
            <button
              onClick={openNewProject}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors"
            >
              <Plus className="w-3 h-3" />
              New project
            </button>
          </div>
        </div>

        <div className="flex flex-col flex-1 min-h-0">
          {tab === 'projects' ? (
            <ProjectsTab
              isConfigured={isConfigured}
              projectsPath={appSettings?.dbt_projects_path ?? undefined}
              paletteOpen={paletteOpen}
              onNewProject={openNewProject}
            />
          ) : (
            <CombinedDocs />
          )}
        </div>

        <HomeBottomPane projectsPath={appSettings ? appSettings.dbt_projects_path : undefined} />
      </div>

      <WorkspaceWickyPane />

      {newProjectOpen && (
        <NewProjectModal
          onClose={(newId) => {
            setNewProjectOpen(false);
            qc.invalidateQueries({ queryKey: ['projects'] });
            if (newId) navigate(`/projects/${newId}`);
          }}
        />
      )}

      {globalSettingsOpen && (
        <GlobalSettingsModal onClose={() => setGlobalSettingsOpen(false)} />
      )}

      {paletteOpen && (
        <HomeCommandPalette
          projects={projects}
          onNavigateToProject={(p) => navigate(`/projects/${p.id}`)}
          onOpenUrl={navigate}
          onNewProject={openNewProject}
          onRescan={handleRescan}
          onOpenGlobalSettings={() => setGlobalSettingsOpen(true)}
          query={paletteQuery}
          onQueryChange={setPaletteQuery}
          onClose={() => { setPaletteOpen(false); setPaletteQuery(''); }}
        />
      )}
    </div>
  );
}
