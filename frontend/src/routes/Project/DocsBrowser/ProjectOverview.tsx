import { useQuery } from '@tanstack/react-query';
import { Package } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { api } from '../../../lib/api';
import { useUrlTab } from '../../../lib/useUrlTab';
import { InheritDescriptionsButton } from '../components/propagation/InheritDescriptionsButton';
import { useDocsScope } from './docsScope';

// ---- ProjectOverview ----

type ProjectTab = 'overview' | 'readme';

const PROJECT_TAB_IDS: readonly ProjectTab[] = ['overview', 'readme'];

export function ProjectOverview({ projectId, projectName, description }: {
  projectId: number;
  projectName: string;
  description: string;
}) {
  const [tab, setTab] = useUrlTab<ProjectTab>('view', PROJECT_TAB_IDS, 'overview', null);
  const { canEdit } = useDocsScope();

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.projects.get(projectId),
  });

  const TABS: { id: ProjectTab; label: string }[] = [
    { id: 'overview', label: 'Project Overview' },
    { id: 'readme',   label: 'README' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-8 pt-6 pb-0 shrink-0">
        <div className="flex items-baseline gap-3 mb-4">
          <Package className="w-6 h-6 text-brand-400 shrink-0" />
          <h1 className="text-2xl font-semibold text-gray-100 font-mono">{projectName}</h1>
        </div>
        {canEdit && (
          <div className="mb-4">
            <InheritDescriptionsButton projectId={projectId} />
          </div>
        )}
        {/* Centered tabs */}
        <div className="flex justify-center border-b border-gray-800">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-6 py-2 text-sm font-medium transition-colors relative ${tab === t.id ? 'text-brand-300' : 'text-gray-500 hover:text-gray-300'}`}
            >
              {t.label}
              {tab === t.id && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-400 rounded-t" />}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {tab === 'overview' && (
          <div className="px-8 py-6">
            {description ? (
              <div className="prose-readme">
                <ReactMarkdown>{description}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-gray-600 italic">No project overview available.</p>
            )}
          </div>
        )}
        {tab === 'readme' && (
          <div className="px-8 py-6">
            {project?.readme ? (
              <div className="prose-readme">
                <ReactMarkdown>{project.readme}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-gray-600 italic">No README found in this project.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
