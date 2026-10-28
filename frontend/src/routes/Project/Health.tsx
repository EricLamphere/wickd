import { useParams } from 'react-router-dom';
import { useUrlTab } from '../../lib/useUrlTab';
import NavRail from './components/NavRail';
import HealthCheckPanel from './components/HealthCheckPanel';
import DriftPanel from './components/DriftPanel';
import FreshnessPanel from './components/FreshnessPanel';
import SemanticLayerPanel from './components/semantic/SemanticLayerPanel';
import HealthOverview from './components/health/HealthOverview';
import TestGapsPanel from './components/health/TestGapsPanel';
import { TONE_BADGE, TONE_DOT, type Tone, tabBadge } from './components/health/healthStatus';
import { testGapsBadge } from './components/health/testGapsView';
import { useTestGaps } from './components/health/useTestGaps';
import { type HealthCheckKind, useHealthSummary } from './components/health/useHealth';

type HealthTab = 'overview' | 'connection' | 'schema-drift' | 'test-gaps' | 'source-freshness' | 'semantic-layer';

const TABS: { id: HealthTab; label: string; kind?: HealthCheckKind }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'connection', label: 'Connection', kind: 'connection' },
  { id: 'schema-drift', label: 'Schema Drift', kind: 'drift' },
  { id: 'test-gaps', label: 'Test Gaps' },
  { id: 'source-freshness', label: 'Source Freshness', kind: 'freshness' },
  { id: 'semantic-layer', label: 'Semantic Layer', kind: 'semantic' },
];

const TAB_IDS = TABS.map((t) => t.id);

const TAB_FOR_KIND: Record<HealthCheckKind, HealthTab> = {
  connection: 'connection',
  drift: 'schema-drift',
  freshness: 'source-freshness',
  semantic: 'semantic-layer',
};

export default function HealthPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = Number(projectId);
  // ?tab= drives the active tab (so back/forward covers it); the last-used tab is
  // remembered per project for visits without one (e.g. clicking Health in the nav rail)
  const [activeTab, handleTabChange] = useUrlTab<HealthTab>('tab', TAB_IDS, 'overview', `health-tab:${id}`);
  const { data: summary } = useHealthSummary(id);
  // same query as the Test Gaps tab and overview card (limit 50); disabled without Pro
  const gaps = useTestGaps(id, 50);
  const gapsBadge = testGapsBadge(gaps.data?.total ?? null, gaps.notReady);

  return (
    <div className="flex h-full overflow-hidden">
      <NavRail projectId={id} current="health" />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Page header + tab bar */}
        <div className="shrink-0 border-b border-gray-800 px-6 pt-5 pb-0 bg-surface-app">
          <div className="flex items-center gap-2.5 mb-4">
            <svg
              className="w-5 h-5 text-rose-400 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 12h3l2-4 3 8 2-4 1 2h3.5" strokeWidth={1.5} />
            </svg>
            <h1 className="text-base font-semibold text-gray-100">Health</h1>
          </div>

          <div className="flex gap-1">
            {TABS.filter((tab) => tab.kind !== 'semantic' || summary?.semantic || activeTab === tab.id).map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 text-sm rounded-t whitespace-nowrap transition-colors border-b-2 -mb-px ${
                  activeTab === tab.id
                    ? 'text-brand-300 border-brand-500 font-medium'
                    : 'text-gray-500 border-transparent hover:text-gray-300'
                }`}
              >
                {tab.label}
                {tab.kind && summary?.[tab.kind] && <TabBadge badge={tabBadge(summary[tab.kind]!)} />}
                {tab.id === 'test-gaps' && <TabBadge badge={gapsBadge} />}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-auto">
          {activeTab === 'overview' && (
            <HealthOverview
              projectId={id}
              onOpen={(kind) => handleTabChange(TAB_FOR_KIND[kind])}
              onOpenTestGaps={() => handleTabChange('test-gaps')}
            />
          )}
          {activeTab === 'connection' && (
            <div className="p-6 pb-12 max-w-[62rem] mx-auto w-full">
              <HealthCheckPanel projectId={id} />
            </div>
          )}
          {activeTab === 'schema-drift' && <DriftPanel projectId={id} />}
          {activeTab === 'test-gaps' && <TestGapsPanel projectId={id} />}
          {activeTab === 'source-freshness' && <FreshnessPanel projectId={id} />}
          {activeTab === 'semantic-layer' && <SemanticLayerPanel projectId={id} />}
        </div>
      </div>
    </div>
  );
}

function TabBadge({ badge }: { badge: { label: string | null; tone: Tone } | null }) {
  if (!badge) return null;
  if (badge.label === null) {
    return <span title="Running" className={`w-1.5 h-1.5 rounded-full ${TONE_DOT[badge.tone]}`} />;
  }
  return (
    <span className={`min-w-[1.25rem] px-1 py-px rounded-full border text-[10px] font-medium leading-none text-center ${TONE_BADGE[badge.tone]}`}>
      {badge.label}
    </span>
  );
}
