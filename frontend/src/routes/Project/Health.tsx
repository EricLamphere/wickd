import { useParams } from 'react-router-dom';
import { useUrlTab } from '../../lib/useUrlTab';
import NavRail from './components/NavRail';
import { PageHeader } from './components/PageHeader';
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
        <PageHeader
          page="health"
          tabs={{
            active: activeTab,
            onChange: handleTabChange,
            items: TABS.filter((tab) => tab.kind !== 'semantic' || summary?.semantic || activeTab === tab.id).map((tab) => ({
              id: tab.id,
              label: (
                <>
                  {tab.label}
                  {tab.kind && summary?.[tab.kind] && <TabBadge badge={tabBadge(summary[tab.kind]!)} />}
                  {tab.id === 'test-gaps' && <TabBadge badge={gapsBadge} />}
                </>
              ),
            })),
          }}
        />

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
