/**
 * Shared chart.js options for the analytics + dashboard pages.
 *
 * Two ready-to-use option objects:
 *   countChartOptions     — for charts whose values are counts (users,
 *                           strategies, etc.). Tooltip + Y-axis ticks
 *                           use Indian grouping (1,23,456).
 *   currencyChartOptions  — for charts whose values are rupee amounts.
 *                           Y-axis ticks abbreviated to ₹L / ₹Cr; tooltip
 *                           shows the full Indian-grouped amount with ₹.
 *
 * Built once at module load (chart.js options are read shallowly per
 * render; immutability is fine).
 */
import { formatIndianNumber, formatIndianCompact } from './formatters';

// chart.js TooltipItem types diverge per chart type (line/bar/doughnut/
// pie); typing as any here keeps callbacks reusable across all of them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tooltipValue = (ctx: any): number => {
  const p = ctx?.parsed;
  if (typeof p === 'number') return p;
  if (p && typeof p.y === 'number') return p.y;
  return 0;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tooltipLabel = (ctx: any): string | undefined => ctx?.dataset?.label || ctx?.label;

export const countChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      bodyFont: { size: 11 },
      titleFont: { size: 11 },
      callbacks: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        label: (ctx: any) => {
          const formatted = formatIndianNumber(tooltipValue(ctx));
          const label = tooltipLabel(ctx);
          return label ? `${label}: ${formatted}` : formatted;
        },
      },
    },
  },
  scales: {
    x: { ticks: { font: { size: 10 } } },
    y: {
      ticks: {
        font: { size: 10 },
        callback: (val: number | string) => formatIndianNumber(Number(val)),
      },
    },
  },
};

export const currencyChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      bodyFont: { size: 11 },
      titleFont: { size: 11 },
      callbacks: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        label: (ctx: any) => {
          const formatted = `₹${formatIndianNumber(tooltipValue(ctx))}`;
          const label = tooltipLabel(ctx);
          return label ? `${label}: ${formatted}` : formatted;
        },
      },
    },
  },
  scales: {
    x: { ticks: { font: { size: 10 } } },
    y: {
      ticks: {
        font: { size: 10 },
        callback: (val: number | string) => `₹${formatIndianCompact(Number(val))}`,
      },
    },
  },
};
