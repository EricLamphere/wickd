import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';

/**
 * A label for a wickd Pro feature that isn't a button (tabs, card titles, options):
 * the Pro star first, then the text, the same as ProFeatureButton.
 */
export function ProLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} title="wickd Pro feature">
      <Sparkles size={12} className="text-brand-300 shrink-0" />
      {children}
    </span>
  );
}
