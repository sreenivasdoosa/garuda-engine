/**
 * Capital-grid math for subscription capital inputs.
 *
 * For a plain index/single-symbol F&O strategy the grid unit is simply capitalPerLot.
 * For a WATCHLIST-DRIVEN strategy (universeId set, non-equity) the engine splits the
 * subscription capital equally across maxActivePositions member stocks BEFORE lot math,
 * so the effective grid unit becomes capitalPerLot × maxActivePositions — capital off
 * that grid silently idles (fractional lots are floored per stock). This helper computes
 * the step and a human hint showing the per-stock arithmetic, so the 2026-08-26 lab
 * mystery (tranch allocating zero lots on perfectly reasonable-looking numbers) explains
 * itself in the form.
 *
 * capitalPerLot is a strategy-wide constant while real per-lot margins vary per stock
 * (~₹1–3L for most stock futures), so it plays the role of "worst-case member margin" —
 * hence "up to N lots" wording, never exact.
 */

export interface CapitalGridStrategy {
  capitalPerLot?: number | null;
  tradeMode?: string | null;
  universeId?: number | null;
  maxActivePositions?: number | null;
}

export interface CapitalGrid {
  /** Input step / minimum sensible increment. */
  step: number;
  /** True when the strategy is watchlist-driven (per-stock capital split applies). */
  isUniverse: boolean;
  /** Per-stock arithmetic for the entered capital; null when not applicable. */
  hint: string | null;
}

const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

export function capitalGridFor(
  strategy: CapitalGridStrategy | null | undefined,
  capital?: number | null,
  subscriptionMaxActivePositions?: number | null,
  tranchCount?: number | null,
): CapitalGrid {
  const cpl = strategy?.capitalPerLot || 0;
  if (!strategy || cpl <= 0) {
    return { step: 1, isUniverse: false, hint: null };
  }
  const isUniverse = strategy.universeId != null && strategy.tradeMode !== 'EQUITY';
  if (!isUniverse) {
    return { step: cpl, isUniverse: false, hint: null };
  }

  const maxAP = subscriptionMaxActivePositions || strategy.maxActivePositions || 1;
  const unit = cpl * maxAP;
  if (!capital || capital <= 0) {
    return {
      step: unit,
      isUniverse: true,
      hint: `Watchlist strategy: capital splits across ${maxAP} stock${maxAP > 1 ? 's' : ''} — full steps of ${inr(unit)} (${inr(cpl)}/lot × ${maxAP})`,
    };
  }

  const perStock = Math.floor(capital / maxAP);
  const lots = Math.floor(perStock / cpl);
  const used = lots * unit;
  const idle = capital - used;

  let hint: string;
  if (lots <= 0) {
    hint = `${inr(capital)} ÷ ${maxAP} stocks = ${inr(perStock)} per stock — below 1 lot (${inr(cpl)}); nothing will trade. Minimum: ${inr(unit)}`;
  } else {
    hint = `${inr(capital)} ÷ ${maxAP} stock${maxAP > 1 ? 's' : ''} = ${inr(perStock)} per stock → up to ${lots} lot${lots > 1 ? 's' : ''} per stock`;
    if (idle > 0) {
      hint += ` (${inr(idle)} idle — next full step ${inr(used + unit)})`;
    }
  }
  // Lots are deployed sequentially across tranches WITHIN each stock, so fewer lots than
  // tranches means the later tranches allocate zero (the 2026-08-26 lab run).
  if (tranchCount && tranchCount > 1 && lots < tranchCount) {
    hint += ` · ${tranchCount} tranches configured → wants ${tranchCount} lots/stock (${inr(unit * tranchCount)})`;
  }
  return { step: unit, isUniverse: true, hint };
}
