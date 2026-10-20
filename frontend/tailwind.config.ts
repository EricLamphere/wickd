import type { Config } from 'tailwindcss';
import colors from 'tailwindcss/colors';
import plugin from 'tailwindcss/plugin';

// Accent hues are theme-aware, like gray. The UI is designed dark-first: tinted
// pills and highlights pair a dark fill (900/950) with light text (300/400),
// which on a white background turns into a faint wash behind pale text. In the
// light theme those shades swap for their mirror (a light fill behind dark
// text). Mid shades (500–700) are solid fills under white text and stay put.
const ACCENT_HUES = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan',
  'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
] as const;
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
// Fills land one step darker than an exact mirror so /30–/60 tints stay visible.
const LIGHT_THEME_SHADE: Partial<Record<(typeof SHADES)[number], number>> = {
  200: 800, 300: 700, 400: 600, 800: 300, 900: 200, 950: 100,
};

const channels = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

const accentVars = (shadeFor: (shade: number) => number) =>
  Object.fromEntries(
    ACCENT_HUES.flatMap((hue) =>
      SHADES.map((shade) => [`--${hue}-${shade}`, channels(colors[hue][shadeFor(shade) as keyof typeof colors.red])]),
    ),
  );

const accentColors = Object.fromEntries(
  ACCENT_HUES.map((hue) => [
    hue,
    Object.fromEntries(SHADES.map((shade) => [shade, `rgb(var(--${hue}-${shade}) / <alpha-value>)`])),
  ]),
);

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Spread all built-in colors, then override gray and the accent hues with CSS variables
    colors: {
      ...colors,
      ...accentColors,
      // Gray scale — theme-aware via CSS variables (inverted in light mode)
      gray: {
        100: 'rgb(var(--gray-100) / <alpha-value>)',
        200: 'rgb(var(--gray-200) / <alpha-value>)',
        300: 'rgb(var(--gray-300) / <alpha-value>)',
        400: 'rgb(var(--gray-400) / <alpha-value>)',
        500: 'rgb(var(--gray-500) / <alpha-value>)',
        600: 'rgb(var(--gray-600) / <alpha-value>)',
        700: 'rgb(var(--gray-700) / <alpha-value>)',
        800: 'rgb(var(--gray-800) / <alpha-value>)',
        900: 'rgb(var(--gray-900) / <alpha-value>)',
      },
    },
    extend: {
      colors: {
        // Teal accent ramp — reads from CSS variables so runtime theming is possible
        brand: {
          50:  'rgb(var(--brand-50)  / <alpha-value>)',
          100: 'rgb(var(--brand-100) / <alpha-value>)',
          200: 'rgb(var(--brand-200) / <alpha-value>)',
          300: 'rgb(var(--brand-300) / <alpha-value>)',
          400: 'rgb(var(--brand-400) / <alpha-value>)',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
          800: 'rgb(var(--brand-800) / <alpha-value>)',
          900: 'rgb(var(--brand-900) / <alpha-value>)',
          950: 'rgb(var(--brand-950) / <alpha-value>)',
        },
        // Surface layers
        surface: {
          app:      'rgb(var(--bg-app)      / <alpha-value>)',
          panel:    'rgb(var(--bg-panel)    / <alpha-value>)',
          elevated: 'rgb(var(--bg-elevated) / <alpha-value>)',
        },
        // Semantic text/border tokens (theme-aware)
        'text-primary':   'rgb(var(--text-primary)   / <alpha-value>)',
        'text-secondary': 'rgb(var(--text-secondary) / <alpha-value>)',
        'text-muted':     'rgb(var(--text-muted)     / <alpha-value>)',
        'border-default': 'rgb(var(--border-default) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        'pro-shimmer': {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
      },
      animation: {
        'pro-shimmer': 'pro-shimmer 3s linear infinite',
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => addBase({
      ':root': accentVars((shade) => shade),
      'html[data-theme="light"]': accentVars((shade) => LIGHT_THEME_SHADE[shade as keyof typeof LIGHT_THEME_SHADE] ?? shade),
    })),
    // `mod:` — applies while Cmd/Ctrl is held (class toggled by useModifierKeyClass)
    plugin(({ addVariant }) => addVariant('mod', 'html.mod-held &')),
  ],
} satisfies Config;
