import { useDarkMode } from '@/hooks/useDarkMode'

// recharts/chart.js take concrete color strings in props (SVG presentation
// attributes can't resolve CSS var()), so charts can't use design tokens
// directly. This hook returns theme-appropriate concrete colors for axes,
// grid, and reference lines based on the active light/dark mode. Semantic
// series colors (positive/negative) are shared across both modes.
export function useChartTheme() {
  const { isDark } = useDarkMode()
  return {
    grid: isDark ? 'rgba(148, 163, 184, 0.15)' : '#eef2f6',
    axisTick: isDark ? '#94a3b8' : '#64748b',
    axisLine: isDark ? '#334155' : '#e2e8f0',
    refLine: isDark ? '#64748b' : '#94a3b8',
    positive: '#22c55e',
    negative: '#ef4444',
    warning: '#f59e0b',
  }
}
