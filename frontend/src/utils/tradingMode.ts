/**
 * Trading-mode aggregation helpers.
 *
 * The terminal's live / paper / mixed selector filters every aggregated metric.
 * The backend ships each metric's combined total plus a `paper*` twin that is
 * the paper-only portion, so the UI derives the displayed value:
 *
 *   live  = total - paper   (the real-money desk; the default view)
 *   paper = paper
 *   mixed = total           (everything, live + paper)
 *
 * Use `valueForMode` for money (P&L may be negative — never clamp) and
 * `countForMode` for trade/position counts (clamp at 0 to absorb any rounding).
 *
 * Capital is intentionally NOT mode-split: the terminal always shows the
 * user-broker configured total capital (overlap-capital at the allocation-model
 * → strategy mapping level makes a per-subscription paper/live split unreliable),
 * so capital is rendered directly from `totalCapital` regardless of mode.
 *
 * Margin / mismatch are live-only: paper trades consume no real broker margin
 * and never reconcile against a real broker position, so their paper value is
 * 0 — use `liveOnlyForMode` (live & mixed → the real value, paper → 0).
 */

export type TradingMode = 'live' | 'paper' | 'mixed';

/** Money metric: live = total - paper, paper = paper, mixed = total. No clamping. */
export function valueForMode(total: number | undefined, paper: number | undefined, mode: TradingMode): number {
  const t = total || 0;
  const p = paper || 0;
  if (mode === 'paper') return p;
  if (mode === 'mixed') return t;
  return t - p;
}

/** Count metric: same as valueForMode but clamped at 0. */
export function countForMode(total: number | undefined, paper: number | undefined, mode: TradingMode): number {
  const v = valueForMode(total, paper, mode);
  return Math.max(0, v);
}

/**
 * Live-only metric (margins, mismatch): there is no paper contribution.
 * live & mixed → the real value, paper → 0.
 */
export function liveOnlyForMode(value: number | undefined, mode: TradingMode): number {
  if (mode === 'paper') return 0;
  return value || 0;
}
