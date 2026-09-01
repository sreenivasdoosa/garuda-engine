/**
 * Client-side risk-profile computation (doc §5.6, Q17) — faithful TS port of the
 * server's calculateRiskProfile()/calculatePositionPnlAtPrice():
 *
 *   group positions by indexSymbol (server-stamped on each row);
 *   for each distance d in RISK_DISTANCES, reprice at spot x (1 + d/100):
 *     - CE: intrinsic = max(0, price - strike); PE: max(0, strike - price)
 *     - futures/equity rows keep their current PnL
 *     - pnlPerUnit = long ? intrinsic - buyAvg : sellAvg - intrinsic, x |netQty|
 *
 * Computed separately for algo and broker position lists (caller decides), and
 * separately per live/paper mode if desired. Rows without an indexSymbol or spotCMP
 * are skipped — same as the server.
 */

import type { LivePosition, TickMap } from '@/types/user-live';
import { positionTotalPnl } from '@/utils/pnlEngine';

/** Mirror of the server's RISK_DISTANCES (UserTradeSummaryService). */
export const RISK_DISTANCES = [-10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10] as const;

export type RiskProfile = Record<string, number>;

function intrinsicPnlAtPrice(pos: LivePosition, spotPrice: number, ticks: TickMap): number {
  if (pos.netQty === 0) return 0;

  // The suffix check alone misparses cash-equity symbols ending in CE/PE (e.g. RELIANCE) —
  // a real option row always carries a positive strike, so gate on it (server parity).
  const hasStrike = (pos.strike ?? 0) > 0;
  const isCall = hasStrike && pos.tradingSymbol.endsWith('CE');
  const isPut = hasStrike && pos.tradingSymbol.endsWith('PE');

  if (!isCall && !isPut) {
    // Futures / equity — linear: keep current PnL (server behavior), tick-derived here.
    return positionTotalPnl(pos, ticks).value;
  }

  const strike = pos.strike ?? 0;
  const intrinsic = isCall ? Math.max(0, spotPrice - strike) : Math.max(0, strike - spotPrice);
  const avgPrice = pos.netQty > 0 ? pos.buyAvgPrice : pos.sellAvgPrice;
  const pnlPerUnit = pos.netQty > 0 ? intrinsic - avgPrice : avgPrice - intrinsic;
  return pnlPerUnit * Math.abs(pos.netQty);
}

/**
 * PnL-at-distance curve over a position list. Keys are the integer-ish distance values
 * as strings ("-10" … "10") to match the server's UserTradeSummary.riskProfile shape.
 */
export function computeRiskProfile(positions: LivePosition[], ticks: TickMap): RiskProfile {
  // Group by index and remember each index's spot.
  const byIndex = new Map<string, LivePosition[]>();
  const spotByIndex = new Map<string, number>();
  for (const pos of positions) {
    if (!pos.indexSymbol) continue;
    let list = byIndex.get(pos.indexSymbol);
    if (!list) {
      list = [];
      byIndex.set(pos.indexSymbol, list);
    }
    list.push(pos);
    if ((pos.spotCMP ?? 0) > 0) {
      spotByIndex.set(pos.indexSymbol, pos.spotCMP as number);
    }
  }

  const profile: RiskProfile = {};
  for (const distance of RISK_DISTANCES) {
    let totalAtDistance = 0;
    for (const [indexSymbol, indexPositions] of byIndex) {
      const spot = spotByIndex.get(indexSymbol);
      if (!spot || spot <= 0) continue;
      const priceAtDistance = spot * (1 + distance / 100);
      for (const pos of indexPositions) {
        totalAtDistance += intrinsicPnlAtPrice(pos, priceAtDistance, ticks);
      }
    }
    // Server keys by String.valueOf((int) distance) — Java int-cast truncates toward
    // zero, so -7.5 -> "-7" and 2.5 -> "2". Match exactly: RiskProfileChart reads
    // these keys.
    profile[String(Math.trunc(distance))] = Math.round(totalAtDistance * 100) / 100;
  }
  return profile;
}
