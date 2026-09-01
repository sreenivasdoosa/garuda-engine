import { create } from 'zustand';

import type {
  BrokerFunds,
  BrokerSummary,
  LivePosition,
  LivePositionsResponse,
  LiveStateResponse,
  LiveSummaryResponse,
  LiveTrade,
  LiveTradePageResponse,
  LiveTradesResponse,
  PositionUpdateEventMsg,
  TickMap,
  TradeUpdateEvent,
} from '@/types/user-live';

/**
 * Single client-side source of truth for the user-portal live view (doc §5.1/§5.2).
 *
 * REST snapshots are the BASELINE (replace wholesale, ordered by asOf — stale responses
 * are discarded); WS events layer keyed upserts on top; ticks only feed the derived
 * PnL math (pnlEngine) — they never mutate trade/position baselines.
 */

const positionKey = (broker: string, pos: LivePosition): string =>
  `${broker}|${pos.tradingSymbol}|${pos.productType}|${pos.isPaperTrading ? 'P' : 'L'}`;

interface UserLiveState {
  /** All of today's trades keyed by tradeID (REST baseline + tradeUpdate deltas). */
  tradesById: Record<string, LiveTrade>;
  /** Single-symbol rows keyed by broker|symbol|productType|mode. */
  algoPositionsByKey: Record<string, LivePosition>;
  brokerPositionsByKey: Record<string, LivePosition>;
  /** Broker-position cache freshness per broker (server-reported). */
  brokerPositionsAsOf: Record<string, number | null>;
  ticks: TickMap;
  /** Per-broker cached funds/margin from the last snapshot that included `margins`. */
  margins: Record<string, BrokerFunds>;
  /** Per-broker allocated capital (from the mixed /summary). */
  capital: Record<string, number>;
  /** Per-broker server roll-up from /me/live/summary?mode=mixed (realized + counts). */
  summaryMixed: BrokerSummary[];
  /** Per-broker server roll-up from /me/live/summary?mode=paper. */
  summaryPaper: BrokerSummary[];
  summaryMixedAsOf: number;
  summaryPaperAsOf: number;
  /** asOf of the last applied /active snapshot — older responses discarded. */
  activeAsOf: number;
  /** asOf of the last applied /positions snapshot. */
  positionsAsOf: number;
  /** asOf of the last applied legacy /state snapshot (compat path). */
  lastSnapshotAsOf: number;
  wsHealthy: boolean;
  /** Set when the server closed the WS with 4001 — poll-only for the rest of the day. */
  marketClosedForToday: boolean;

  applyRestSnapshot: (state: LiveStateResponse) => void;
  /** Server roll-up for the tiles (realized + counts + capital + margins); mode = mixed | paper. */
  applySummarySnapshot: (mode: 'mixed' | 'paper', resp: LiveSummaryResponse) => void;
  /** Replace the active+open set (drop exited), preserving any lazily-loaded terminal rows. */
  applyActiveSnapshot: (resp: LiveTradesResponse) => void;
  /** Replace algo+broker positions from /me/live/positions. */
  applyPositionsSnapshot: (resp: LivePositionsResponse) => void;
  /** Merge a lazily-loaded completed page (history tab / scroll). */
  appendCompletedPage: (resp: LiveTradePageResponse) => void;
  /** Replace the lazily-loaded cancelled set. */
  setCancelled: (resp: LiveTradePageResponse) => void;
  applyTradesSnapshot: (trades: LiveTradesResponse) => void;
  applyTicks: (ticks: TickMap) => void;
  /** Returns false when the tradeID is unknown — caller schedules a targeted refetch. */
  applyTradeUpdate: (event: TradeUpdateEvent) => boolean;
  applyAlgoPositionUpdate: (event: PositionUpdateEventMsg) => void;
  applyBrokerPositionUpdate: (event: PositionUpdateEventMsg) => void;
  setWsHealthy: (healthy: boolean) => void;
  setMarketClosedForToday: (closed: boolean) => void;
  reset: () => void;
}

function indexTrades(resp: LiveTradesResponse): Record<string, LiveTrade> {
  const byId: Record<string, LiveTrade> = {};
  for (const brokerTrades of resp.brokers ?? []) {
    for (const trade of brokerTrades.trades ?? []) {
      if (trade?.tradeID) byId[trade.tradeID] = trade;
    }
  }
  return byId;
}

export const useUserLiveStore = create<UserLiveState>((set, get) => ({
  tradesById: {},
  algoPositionsByKey: {},
  brokerPositionsByKey: {},
  brokerPositionsAsOf: {},
  ticks: {},
  margins: {},
  capital: {},
  summaryMixed: [],
  summaryPaper: [],
  summaryMixedAsOf: 0,
  summaryPaperAsOf: 0,
  activeAsOf: 0,
  positionsAsOf: 0,
  lastSnapshotAsOf: 0,
  wsHealthy: false,
  marketClosedForToday: false,

  applyPositionsSnapshot: (resp) => {
    if (!resp || resp.asOf <= get().positionsAsOf) return;
    set((state) => {
      const algo: Record<string, LivePosition> = {};
      const broker: Record<string, LivePosition> = {};
      const asOfMap: Record<string, number | null> = { ...state.brokerPositionsAsOf };
      for (const bp of resp.brokers ?? []) {
        for (const pos of bp.algoPositions ?? []) algo[positionKey(bp.broker, pos)] = pos;
        for (const pos of bp.brokerPositions ?? []) broker[positionKey(bp.broker, pos)] = pos;
        asOfMap[bp.broker] = bp.brokerPositionsAsOf ?? null;
      }
      return {
        algoPositionsByKey: algo,
        brokerPositionsByKey: broker,
        brokerPositionsAsOf: asOfMap,
        positionsAsOf: resp.asOf,
      };
    });
  },

  applySummarySnapshot: (mode, resp) => {
    if (!resp) return;
    if (mode === 'paper') {
      if (resp.asOf <= get().summaryPaperAsOf) return;
      set({ summaryPaper: resp.brokers ?? [], summaryPaperAsOf: resp.asOf });
      return;
    }
    // mixed: also carries per-broker margins + allocated capital (the tiles' source)
    if (resp.asOf <= get().summaryMixedAsOf) return;
    const margins: Record<string, BrokerFunds> = {};
    const capital: Record<string, number> = {};
    for (const b of resp.brokers ?? []) {
      if (b.margins) margins[b.broker] = b.margins;
      if (b.capital != null) capital[b.broker] = b.capital;
    }
    set({ summaryMixed: resp.brokers ?? [], summaryMixedAsOf: resp.asOf, margins, capital });
  },

  applyActiveSnapshot: (resp) => {
    if (!resp || resp.asOf <= get().activeAsOf) return;
    const incoming = indexTrades(resp); // open+active rows by id
    set((state) => {
      // Keep lazily-loaded terminal rows (completed/cancelled tabs); replace the live set.
      const next: Record<string, LiveTrade> = {};
      for (const [id, t] of Object.entries(state.tradesById)) {
        if (t.state === 'COMPLETED' || t.state === 'CANCELLED') next[id] = t;
      }
      for (const [id, t] of Object.entries(incoming)) next[id] = t;
      return { tradesById: next, activeAsOf: resp.asOf };
    });
  },

  appendCompletedPage: (resp) => {
    if (!resp?.trades?.length) return;
    set((state) => {
      const next = { ...state.tradesById };
      for (const t of resp.trades) if (t?.tradeID) next[t.tradeID] = t;
      return { tradesById: next };
    });
  },

  setCancelled: (resp) => {
    if (!resp) return;
    set((state) => {
      const next: Record<string, LiveTrade> = {};
      for (const [id, t] of Object.entries(state.tradesById)) {
        if (t.state !== 'CANCELLED') next[id] = t;
      }
      for (const t of resp.trades ?? []) if (t?.tradeID) next[t.tradeID] = t;
      return { tradesById: next };
    });
  },

  applyRestSnapshot: (snapshot) => {
    if (!snapshot || snapshot.asOf <= get().lastSnapshotAsOf) {
      return; // out-of-order response — the newer baseline already applied
    }
    set((state) => {
      const next: Partial<UserLiveState> = { lastSnapshotAsOf: snapshot.asOf };
      if (snapshot.trades) {
        next.tradesById = indexTrades(snapshot.trades);
      }
      if (snapshot.positions) {
        const algo: Record<string, LivePosition> = {};
        const broker: Record<string, LivePosition> = {};
        const asOfMap: Record<string, number | null> = { ...state.brokerPositionsAsOf };
        for (const bp of snapshot.positions.brokers ?? []) {
          for (const pos of bp.algoPositions ?? []) {
            algo[positionKey(bp.broker, pos)] = pos;
          }
          for (const pos of bp.brokerPositions ?? []) {
            broker[positionKey(bp.broker, pos)] = pos;
          }
          asOfMap[bp.broker] = bp.brokerPositionsAsOf ?? null;
        }
        next.algoPositionsByKey = algo;
        next.brokerPositionsByKey = broker;
        next.brokerPositionsAsOf = asOfMap;
      }
      if (snapshot.margins) {
        next.margins = snapshot.margins;
      }
      if (snapshot.capital) {
        next.capital = snapshot.capital;
      }
      return next as UserLiveState;
    });
  },

  applyTradesSnapshot: (trades) => {
    if (!trades || trades.asOf <= get().lastSnapshotAsOf) return;
    set({ tradesById: indexTrades(trades), lastSnapshotAsOf: trades.asOf });
  },

  applyTicks: (incoming) => {
    if (!incoming) return;
    set((state) => ({ ticks: { ...state.ticks, ...incoming } }));
  },

  applyTradeUpdate: (event) => {
    if (!event?.tradeID) return true;
    const existing = get().tradesById[event.tradeID];
    if (!existing) {
      return false; // unknown trade — caller refetches /me/live/trades (debounced)
    }
    const merged: LiveTrade = {
      ...existing,
      state: event.state ?? existing.state,
      filledQuantity: event.filledQuantity ?? existing.filledQuantity,
      entry: event.entryAvgPrice ?? existing.entry,
      exit: event.exitAvgPrice ?? existing.exit,
      exitReason: event.exitReason ?? existing.exitReason,
      charges: event.charges ?? existing.charges,
      profitLoss: event.profitLoss ?? existing.profitLoss,
      netProfitLoss: event.netProfitLoss ?? existing.netProfitLoss,
    };
    set((state) => ({ tradesById: { ...state.tradesById, [event.tradeID]: merged } }));
    return true;
  },

  applyAlgoPositionUpdate: (event) => {
    if (!event?.position?.tradingSymbol) return;
    set((state) => ({
      algoPositionsByKey: {
        ...state.algoPositionsByKey,
        [positionKey(event.broker, event.position)]: event.position,
      },
    }));
  },

  applyBrokerPositionUpdate: (event) => {
    if (!event?.position?.tradingSymbol) return;
    set((state) => ({
      brokerPositionsByKey: {
        ...state.brokerPositionsByKey,
        [positionKey(event.broker, event.position)]: event.position,
      },
    }));
  },

  setWsHealthy: (healthy) => set({ wsHealthy: healthy }),
  setMarketClosedForToday: (closed) => set({ marketClosedForToday: closed }),

  reset: () =>
    set({
      tradesById: {},
      algoPositionsByKey: {},
      brokerPositionsByKey: {},
      brokerPositionsAsOf: {},
      ticks: {},
      margins: {},
      capital: {},
      summaryMixed: [],
      summaryPaper: [],
      summaryMixedAsOf: 0,
      summaryPaperAsOf: 0,
      activeAsOf: 0,
      positionsAsOf: 0,
      lastSnapshotAsOf: 0,
      wsHealthy: false,
      marketClosedForToday: false,
    }),
}));

// ==================== server-summary selectors ====================

export const selectSummaryMixed = (state: UserLiveState): BrokerSummary[] => state.summaryMixed;
export const selectSummaryPaper = (state: UserLiveState): BrokerSummary[] => state.summaryPaper;

// ==================== plain selectors (no React) ====================

export const selectTrades = (state: UserLiveState): LiveTrade[] => Object.values(state.tradesById);

export const selectAlgoPositions = (state: UserLiveState): LivePosition[] =>
  Object.values(state.algoPositionsByKey);

export const selectBrokerPositions = (state: UserLiveState): LivePosition[] =>
  Object.values(state.brokerPositionsByKey);
