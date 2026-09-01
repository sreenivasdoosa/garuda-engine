/** @type {import('tailwindcss').Config} */
//
// Tailwind foundation for the white-label design system.
//
// Every semantic color / surface / font / radius is backed by a CSS custom
// property so ONE component renders correctly across every brand flavor
// across light and dark, driven by the
// light/dark axis, with no per-element `dark:` overrides. Flavors are selected
// at runtime via `data-theme="<brand>"` on <html> (see ThemeContext); the
// light/dark axis is the `.dark` class on <html>. The two are independent.
//
// Plain Tailwind (no prefix) — the Bootstrap coexistence era and its 'tw-'
// namespace are over; Preflight is on.
const withVar = (v) => `rgb(var(${v}) / <alpha-value>)`

export default {
  darkMode: 'class',
  corePlugins: { preflight: true },
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        // Surfaces + text — flip with light/dark and can be re-toned per flavor.
        app: withVar('--c-app'),
        card: withVar('--c-card'),
        raised: withVar('--c-raised'),
        hairline: withVar('--c-hairline'),
        ink: {
          DEFAULT: withVar('--c-ink'),
          soft: withVar('--c-ink-soft'),
          faint: withVar('--c-ink-faint'),
        },
        // Primary accent ramp — flavor-driven (this is what makes a white-label
        // "a different product": each brand sets its own --c-primary-* values).
        primary: {
          50: withVar('--c-primary-50'), 100: withVar('--c-primary-100'),
          200: withVar('--c-primary-200'), 300: withVar('--c-primary-300'),
          400: withVar('--c-primary-400'), 500: withVar('--c-primary-500'),
          600: withVar('--c-primary-600'), 700: withVar('--c-primary-700'),
          800: withVar('--c-primary-800'), 900: withVar('--c-primary-900'),
          950: withVar('--c-primary-950'),
        },
        // Secondary accent (used in gradients / info) — flavor-driven.
        accent: {
          400: withVar('--c-accent-400'),
          500: withVar('--c-accent-500'),
          600: withVar('--c-accent-600'),
        },
        // Status ramps — fixed cross-flavor (green ALWAYS = success, etc.).
        // success 500/600 are MODE-aware vars: darker in light (the raw hexes
        // sit under 4.5:1 on white and read washed-out), brighter in dark.
        success: { 50:'#f0fdf4',100:'#dcfce7',200:'#bbf7d0',300:'#86efac',400:'#4ade80',500:withVar('--c-success-500'),600:withVar('--c-success-600'),700:'#15803d',800:'#166534',900:'#14532d',950:'#052e16' },
        warning: { 50:'#fffbeb',100:'#fef3c7',200:'#fde68a',300:'#fcd34d',400:'#fbbf24',500:'#f59e0b',600:'#d97706',700:'#b45309',800:'#92400e',900:'#78350f',950:'#451a03' },
        danger:  { 50:'#fef2f2',100:'#fee2e2',200:'#fecaca',300:'#fca5a5',400:'#f87171',500:'#ef4444',600:'#dc2626',700:'#b91c1c',800:'#991b1b',900:'#7f1d1d',950:'#450a0a' },
      },
      borderColor: { DEFAULT: withVar('--c-hairline') },
      backgroundImage: {
        'accent-gradient': 'var(--gradient-accent)',
        'hero-mesh': 'var(--hero-mesh)',
      },
      boxShadow: {
        glow: 'var(--shadow-glow)',
        'glow-lg': 'var(--shadow-glow-lg)',
        card: 'var(--shadow-card)',
        'card-dark': 'var(--shadow-card-dark)',
      },
      borderRadius: {
        card: 'var(--radius-card)',
        control: 'var(--radius-control)',
      },
    },
  },
  plugins: [],
}
