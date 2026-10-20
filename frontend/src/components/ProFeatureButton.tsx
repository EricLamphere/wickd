import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';

interface ProFeatureButtonProps {
  onClick: () => void;
  children: ReactNode;
  title?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Standard "shiny" treatment for gated wickd Pro features — an animated
 * gradient border/sheen so locked Pro actions read as premium, not disabled.
 * Use this for every Pro-gated action button in the app.
 */
export function ProFeatureButton({ onClick, children, title, className = '', disabled = false }: ProFeatureButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`group relative flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded shrink-0 overflow-hidden
        text-brand-300 bg-surface-elevated disabled:opacity-60 disabled:pointer-events-none
        transition-transform duration-150 hover:scale-[1.03] active:scale-[0.98] ${className}`}
    >
      {/* Animated gradient border. Most of the brand ramp is remapped in light
          mode (for text contrast), which would make this border look dull
          there — so it uses fixed teal-700/teal-200, vivid in both themes. */}
      <span
        className="pointer-events-none absolute inset-0 rounded bg-[length:200%_100%] animate-pro-shimmer opacity-90"
        style={{
          background:
            'linear-gradient(110deg, rgb(15 118 110) 0%, rgb(153 246 228) 25%, rgb(15 118 110) 50%, rgb(153 246 228) 75%, rgb(15 118 110) 100%)',
          backgroundSize: '200% 100%',
        }}
      />
      {/* Inner fill, inset by 1px to leave the gradient as a border */}
      <span className="pointer-events-none absolute inset-[1px] rounded-[3px] bg-surface-elevated group-hover:bg-surface-elevated/80 transition-colors" />

      <span className="relative flex items-center gap-1.5">
        <Sparkles size={12} className="text-brand-300" />
        {children}
      </span>
    </button>
  );
}
