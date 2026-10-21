import type { ConnectorState } from './flow';

const HEIGHT = 52;
const ARROW_SIZE = 5;

const STATE_STYLE: Record<ConnectorState, { color: string; flow: boolean; durationS: number }> = {
  idle:   { color: 'text-gray-600',    flow: true,  durationS: 1.6 },
  active: { color: 'text-blue-400',    flow: true,  durationS: 0.5 },
  done:   { color: 'text-green-500',   flow: true,  durationS: 1.6 },
  failed: { color: 'text-red-500/70',  flow: false, durationS: 0 },
  add:    { color: 'text-gray-700',    flow: false, durationS: 0 },
};

interface StepConnectorProps {
  /** Width of the flow column in px (the SVG draws in real pixels so dashes and the arrow aren't stretched). */
  width: number;
  fromPct: number;
  toPct: number;
  state: ConnectorState;
  dimmed?: boolean;
}

/** S-curve "string" from the bottom of one step tile to the top of the next, with dashes flowing along it. */
export function StepConnector({ width, fromPct, toPct, state, dimmed = false }: StepConnectorProps) {
  const style = STATE_STYLE[state];
  if (width <= 0) return <div style={{ height: HEIGHT }} />;

  const x1 = (width * fromPct) / 100;
  const x2 = (width * toPct) / 100;
  const end = HEIGHT - ARROW_SIZE - 1;
  const path = `M ${x1} 0 C ${x1} ${HEIGHT / 2}, ${x2} ${HEIGHT / 2}, ${x2} ${end}`;
  const arrow = `${x2 - ARROW_SIZE},${end} ${x2 + ARROW_SIZE},${end} ${x2},${HEIGHT}`;

  return (
    <svg
      width={width}
      height={HEIGHT}
      viewBox={`0 0 ${width} ${HEIGHT}`}
      aria-hidden
      className={`block shrink-0 overflow-visible transition-opacity ${style.color} ${dimmed ? 'opacity-20' : ''}`}
    >
      {/* Faint track */}
      <path d={path} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={4} strokeLinecap="round" />
      {/* Flowing dashes */}
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={state === 'failed' ? undefined : '5 9'}
        className={style.flow ? 'motion-safe:animate-flow-dash' : ''}
        style={style.flow ? { animationDuration: `${style.durationS}s` } : undefined}
      />
      <polygon points={arrow} fill="currentColor" />
    </svg>
  );
}
