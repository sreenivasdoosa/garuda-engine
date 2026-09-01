/**
 * Client-side PnL math for the user portal (doc §5.3). Pure functions — no store or
 * React imports.
 *
 * Rules:
 * - pnl = qty x (price - avg) x contractMultiplier (Q15; multiplier is stamped on every
 *   row by the server, 1 for NSE/BSE).
 * - charges and realized PnL are ALWAYS server-computed (REST baseline + exit
 *   tradeUpdate events, Q9) — never computed here.
 * - Missing tick for a symbol -> fall back to the row's server baseline value and mark
 *   it stale; never show 0/NaN.
 * - live/paper/mixed partitions directly on isPaperTrading.
 */

import type { BrokerSummary, LivePosition, LiveTrade, TickMap, TradingModeFilter } from '@/types/user-live';
import { symbolKeyOf } from '@/types/user-live';

export interface PnlValue {
  value: number;
  /** True when no live tick was available and the server baseline was used. */
  stale: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function modeMatches(isPaperTrading: boolean, mode: TradingModeFilter): boolean {
  if (mode === 'live') return !isPaperTrading;
  if (mode === 'paper') return isPaperTrading;
  return true;
}

export function ltpOf(ticks: TickMap, exchange: string, tradingSymbol: string): number | undefined {
  const tick = ticks[symbolKeyOf(exchange, tradingSymbol)];
  return tick && tick.ltp > 0 ? tick.ltp : undefined;
}

/** Unrealized PnL of an active trade row: (ltp - entry) x filledQty x sign x multiplier. */
export function tradeUnrealizedPnl(trade: LiveTrade, ticks: TickMap): PnlValue {
  const isTerminal = trade.state === 'COMPLETED' || trade.state === 'CANCELLED';
  if (isTerminal || trade.filledQuantity <= 0 || trade.entry <= 0) {
    return { value: 0, stale: false };
  }
  const ltp = ltpOf(ticks, trade.exchange, trade.tradingSymbol);
  if (ltp === undefined) {
    // Server baseline: profitLoss of a non-terminal trade is its server-computed
    // unrealized PnL as of the last snapshot.
    return { value: round2(trade.profitLoss ?? 0), stale: true };
  }
  const sign = trade.direction === 'SHORT' ? -1 : 1;
  const multiplier = trade.contractMultiplier > 0 ? trade.contractMultiplier : 1;
  return { value: round2((ltp - trade.entry) * trade.filledQuantity * sign * multiplier), stale: false };
}

/** Unrealized PnL of a position row: (ltp - netAvg) x netQty x multiplier (netQty signed). */
export function positionUnrealizedPnl(pos: LivePosition, ticks: TickMap): PnlValue {
  if (pos.netQty === 0) {
    return { value: 0, stale: false };
  }
  const ltp = ltpOf(ticks, pos.exchange, pos.tradingSymbol);
  const multiplier = pos.contractMultiplier > 0 ? pos.contractMultiplier : 1;
  if (ltp === undefined) {
    return { value: round2(pos.unrealizedPnl ?? 0), stale: true };
  }
  const avg = pos.netQty > 0 ? pos.buyAvgPrice : pos.sellAvgPrice;
  const perUnit = pos.netQty > 0 ? ltp - avg : avg - ltp;
  return { value: round2(perUnit * Math.abs(pos.netQty) * multiplier), stale: false };
}

/** Total PnL of a position row: server realized + tick-derived unrealized. */
export function positionTotalPnl(pos: LivePosition, ticks: TickMap): PnlValue {
  const unrealized = positionUnrealizedPnl(pos, ticks);
  return { value: round2((pos.realizedPnl ?? 0) + unrealized.value), stale: unrealized.stale };
}

export interface PnlSummary {
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  charges: number;
  netPnl: number;
  openTradesCount: number;
  activeTradesCount: number;
  completedTradesCount: number;
  cancelledTradesCount: number;
  /** True when any contributing unrealized value used a baseline (no live tick). */
  stale: boolean;
}

/**
 * Aggregate tiles for the portal (doc §5.3):
 *   realized   = sum of profitLoss over TERMINAL trades (server-computed)
 *   unrealized = sum of tick-derived unrealized over non-terminal trades
 *   charges    = sum of trade.charges (server-computed, all trades)
 *   netPnl     = realized + unrealized - charges
 */
export function aggregatePnl(trades: LiveTrade[], ticks: TickMap, mode: TradingModeFilter): PnlSummary {
  const summary: PnlSummary = {
    realizedPnl: 0,
    unrealizedPnl: 0,
    totalPnl: 0,
    charges: 0,
    netPnl: 0,
    openTradesCount: 0,
    activeTradesCount: 0,
    completedTradesCount: 0,
    cancelledTradesCount: 0,
    stale: false,
  };

  for (const trade of trades) {
    if (!modeMatches(trade.isPaperTrading, mode)) continue;

    switch (trade.state) {
      case 'OPEN':
        summary.openTradesCount += 1;
        break;
      case 'ACTIVE':
        summary.activeTradesCount += 1;
        break;
      case 'COMPLETED':
        summary.completedTradesCount += 1;
        break;
      case 'CANCELLED':
        summary.cancelledTradesCount += 1;
        break;
      default:
        break;
    }

    summary.charges += trade.charges ?? 0;
    if (trade.state === 'COMPLETED' || trade.state === 'CANCELLED') {
      summary.realizedPnl += trade.profitLoss ?? 0;
    } else {
      const unrealized = tradeUnrealizedPnl(trade, ticks);
      summary.unrealizedPnl += unrealized.value;
      summary.stale = summary.stale || unrealized.stale;
    }
  }

  summary.realizedPnl = round2(summary.realizedPnl);
  summary.unrealizedPnl = round2(summary.unrealizedPnl);
  summary.charges = round2(summary.charges);
  summary.totalPnl = round2(summary.realizedPnl + summary.unrealizedPnl);
  summary.netPnl = round2(summary.totalPnl - summary.charges);
  return summary;
}

/** Server-roll-up scalars for one mode, broker-filtered (realized + terminal counts + charges). */
export interface ServerRealizedAgg {
  realizedPnl: number;
  realizedCharges: number;
  completedTradesCount: number;
  cancelledTradesCount: number;
}

/** Aggregate the per-broker /me/live/summary roll-up (one mode) to scalars. */
export function aggregateServerSummary(brokers: BrokerSummary[], broker?: string): ServerRealizedAgg {
  const agg: ServerRealizedAgg = {
    realizedPnl: 0,
    realizedCharges: 0,
    completedTradesCount: 0,
    cancelledTradesCount: 0,
  };
  for (const b of brokers ?? []) {
    if (broker && b.broker !== broker) continue;
    agg.realizedPnl += b.realizedPnl ?? 0;
    agg.realizedCharges += b.realizedCharges ?? 0;
    agg.completedTradesCount += b.completedCount ?? 0;
    agg.cancelledTradesCount += b.cancelledCount ?? 0;
  }
  return agg;
}

/**
 * Compose the tile summary from the split feeds (REST optimization): REALIZED + completed/cancelled
 * counts + realized-charges come from the SERVER roll-up (so we never ship completed rows);
 * UNREALIZED + open/active counts + active-trade charges are client-computed live over the active
 * set. `clientActive` MUST be aggregatePnl over OPEN/ACTIVE trades only (no terminal rows) so the
 * server realized is not double-counted against any lazily-loaded completed rows.
 */
export function composeSummary(clientActive: PnlSummary, server: ServerRealizedAgg): PnlSummary {
  const realizedPnl = round2(server.realizedPnl);
  const unrealizedPnl = clientActive.unrealizedPnl;
  const charges = round2(clientActive.charges + server.realizedCharges);
  const totalPnl = round2(realizedPnl + unrealizedPnl);
  return {
    realizedPnl,
    unrealizedPnl,
    totalPnl,
    charges,
    netPnl: round2(totalPnl - charges),
    openTradesCount: clientActive.openTradesCount,
    activeTradesCount: clientActive.activeTradesCount,
    completedTradesCount: server.completedTradesCount,
    cancelledTradesCount: server.cancelledTradesCount,
    stale: clientActive.stale,
  };
}

export interface StrategySummaryRow {
  strategy: string;
  tradesCount: number;
  activeCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  netPnl: number;
}

/** Strategy summaries grouped client-side (doc §5.6 — trivially a group-by). */
export function strategySummaries(
  trades: LiveTrade[],
  ticks: TickMap,
  mode: TradingModeFilter,
): StrategySummaryRow[] {
  const byStrategy = new Map<string, StrategySummaryRow>();
  for (const trade of trades) {
    if (!modeMatches(trade.isPaperTrading, mode)) continue;
    const key = trade.strategy || '(none)';
    let row = byStrategy.get(key);
    if (!row) {
      row = { strategy: key, tradesCount: 0, activeCount: 0, realizedPnl: 0, unrealizedPnl: 0, netPnl: 0 };
      byStrategy.set(key, row);
    }
    row.tradesCount += 1;
    const isTerminal = trade.state === 'COMPLETED' || trade.state === 'CANCELLED';
    if (isTerminal) {
      row.realizedPnl += trade.profitLoss ?? 0;
    } else {
      if (trade.state === 'ACTIVE' || trade.state === 'OPEN') row.activeCount += 1;
      row.unrealizedPnl += tradeUnrealizedPnl(trade, ticks).value;
    }
    row.netPnl = round2(row.realizedPnl + row.unrealizedPnl - 0); // charges shown at totals level
  }
  return Array.from(byStrategy.values()).map((row) => ({
    ...row,
    realizedPnl: round2(row.realizedPnl),
    unrealizedPnl: round2(row.unrealizedPnl),
  }));
}
