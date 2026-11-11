import { Link, NavLink } from 'react-router-dom';
import { navAlert } from './health/healthStatus';
import { useHealthSummary } from './health/useHealth';
import { useScheduleAlerts } from '../../../lib/useRunSchedules';

import { PAGE_META, PageIcon, type CurrentPage } from './pageMeta';

export type { CurrentPage };

interface Props {
  projectId: number;
  current: CurrentPage;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const CHEVRON_LEFT = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
  </svg>
);

const CHEVRON_RIGHT = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
  </svg>
);

interface NavItem { key: CurrentPage; path: string }

const CONFIGURE_ITEMS: NavItem[] = [
  { key: 'environment', path: 'environment' },
  { key: 'init',        path: 'init' },
];

const PROJECT_ITEMS: NavItem[] = [
  { key: 'files',     path: 'files' },
  { key: 'dag',       path: 'models' },
  { key: 'docs',      path: 'docs' },
  { key: 'metrics',   path: 'metrics' },
  { key: 'charts',    path: 'charts' },
  { key: 'workspace', path: 'workspace' },
  { key: 'runs',      path: 'runs' },
  { key: 'health',    path: 'health' },
  { key: 'git',       path: 'git' },
];

type NavAlerts = Partial<Record<CurrentPage, 'warn' | 'fail'>>;

const ALERT_DOT: Record<'warn' | 'fail', string> = { warn: 'bg-amber-500', fail: 'bg-red-500' };
const ALERT_TITLE: Record<'warn' | 'fail', string> = { warn: 'needs attention', fail: 'failing' };

function NavSection({
  label,
  items,
  projectId,
  current,
  collapsed,
  alerts = {},
}: {
  label: string;
  items: NavItem[];
  projectId: number;
  current: CurrentPage;
  collapsed: boolean;
  alerts?: NavAlerts;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {!collapsed && (
        <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-600 select-none">
          {label}
        </p>
      )}
      {collapsed && <div className="pt-3" />}
      {items.map((item) => {
        const isActive = item.key === current;
        const alert = alerts[item.key];
        const itemLabel = PAGE_META[item.key].label;
        if (collapsed) {
          return (
            <NavLink
              key={item.key}
              to={`/projects/${projectId}/${item.path}`}
              title={alert ? `${itemLabel} — ${ALERT_TITLE[alert]}` : itemLabel}
              className={`relative flex items-center justify-center mx-1.5 p-2 rounded-lg transition-colors
                ${isActive
                  ? 'bg-brand-900/40 text-brand-300'
                  : 'text-gray-400 hover:bg-surface-elevated hover:text-gray-200'
                }`}
            >
              <PageIcon page={item.key} />
              {alert && <span className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${ALERT_DOT[alert]}`} />}
            </NavLink>
          );
        }
        return (
          <NavLink
            key={item.key}
            to={`/projects/${projectId}/${item.path}`}
            className={`flex items-center gap-2.5 mx-2 px-3 py-2 rounded-lg text-sm transition-colors
              ${isActive
                ? 'bg-brand-900/40 text-brand-300 font-medium'
                : 'text-gray-400 hover:bg-surface-elevated hover:text-gray-200'
              }`}
          >
            <PageIcon page={item.key} />
            <span className="flex-1 truncate">{itemLabel}</span>
            {alert && (
              <span title={ALERT_TITLE[alert]} className={`w-1.5 h-1.5 rounded-full shrink-0 ${ALERT_DOT[alert]}`} />
            )}
          </NavLink>
        );
      })}
    </div>
  );
}

export default function ProjectNav({ projectId, current, collapsed = false, onToggleCollapse }: Props) {
  const { data: health } = useHealthSummary(projectId);
  const healthAlert = navAlert(health);
  const { failures: scheduleFailures } = useScheduleAlerts(projectId);
  const alerts: NavAlerts = {
    ...(healthAlert ? { health: healthAlert } : {}),
    ...(scheduleFailures.length > 0 ? { runs: 'fail' as const } : {}),
  };

  return (
    <nav className="flex flex-col pt-2 overflow-hidden h-full">
      {collapsed ? (
        <Link
          to={`/projects/${projectId}`}
          title="Project home"
          className="flex items-center justify-center mx-1.5 p-2 text-gray-400 hover:text-gray-200 hover:bg-surface-elevated rounded-lg transition-colors"
        >
          <PageIcon page="home" />
        </Link>
      ) : (
        <Link
          to={`/projects/${projectId}`}
          className="mx-2 px-3 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-surface-elevated rounded-lg transition-colors"
        >
          ← Project home
        </Link>
      )}
      <div className="mx-4 my-2 border-t border-gray-800" />
      <div className="flex flex-col flex-1 overflow-y-auto">
        <NavSection label="Configure" items={CONFIGURE_ITEMS} projectId={projectId} current={current} collapsed={collapsed} />
        <NavSection label="Project" items={PROJECT_ITEMS} projectId={projectId} current={current} collapsed={collapsed} alerts={alerts} />
      </div>
      {onToggleCollapse && (
        <button
          onClick={onToggleCollapse}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex items-center justify-center mx-auto mb-3 mt-1 w-7 h-7 rounded-md text-gray-500 hover:text-gray-300 hover:bg-surface-elevated transition-colors"
        >
          {collapsed ? CHEVRON_RIGHT : CHEVRON_LEFT}
        </button>
      )}
    </nav>
  );
}
