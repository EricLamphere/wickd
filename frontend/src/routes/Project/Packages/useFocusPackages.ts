import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/** Router state that asks the project home to scroll to and flash the Packages tab
 *  (Health → Packages card). One-shot: cleared once handled, so back/forward don't repeat it. */
export const FOCUS_PACKAGES_STATE = { focus: 'packages' } as const;

const HIGHLIGHT_MS = 1800;
// content above the panel (counts, recent runs) loads async and can push it down: scroll again
const RESCROLL_DELAYS_MS = [50, 500];

export function useFocusPackages(target: RefObject<HTMLElement | null>): boolean {
  const location = useLocation();
  const navigate = useNavigate();
  const [highlight, setHighlight] = useState(false);
  const requested = (location.state as { focus?: string } | null)?.focus === 'packages';
  // timers outlive the effect: clearing the router state re-runs it, which must not cancel them
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  useEffect(() => {
    if (!requested) return;
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
    const scroll = () => target.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    timers.current.push(
      ...RESCROLL_DELAYS_MS.map((ms) => window.setTimeout(scroll, ms)),
      window.setTimeout(() => setHighlight(false), HIGHLIGHT_MS),
    );
    setHighlight(true);
  }, [requested, navigate, location.pathname, location.search, target]);

  return highlight;
}
