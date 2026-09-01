/**
 * Orchestrator for the user-portal client-side PnL view (doc §5.1/§5.2 — Phase 2).
 *
 * Data flow:
 *   1. Initial REST load: GET /me/live/state -> store baseline (render immediately
 *      with server-computed values).
 *   2. WS live updates: subscribes ticks/trades/positions/alerts (never `orders` or
 *      `terminal`); ticks feed the derived PnL math; tradeUpdate deltas merge by
 *      tradeID (unknown tradeID -> debounced targeted refetch); position events are
 *      keyed upserts.
 *   3. Reconciliation poll (always on, Q6): adaptive — WS healthy relaxes the interval
 *      toward a 30s ceiling; WS down/just-reconnected snaps to the 15s floor; ±20%
 *      jitter; close code 4001 means market closed for the day (quiet poll-only state,
 *      no reconnect).
 *
 * All PnL/aggregation math lives in pure utils (pnlEngine/positionCompare/riskProfile);
 * this hook only orchestrates and memoizes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useWebSocket } from '@/hooks/useWebSocket';
import { userLiveService } from '@/services/user-portal/userLiveService';
import {
  selectAlgoPositions,
  selectBrokerPositions,
  selectSummaryMixed,
  selectSummaryPaper,
  selectTrades,
  useUserLiveStore,
} from '@/store/userLiveStore';
import type { LivePosition, LiveTrade, PortalWsMessage, TradingModeFilter } from '@/types/user-live';
import {
  aggregatePnl,
  aggregateServerSummary,
  composeSummary,
  strategySummaries,
  type PnlSummary,
  type StrategySummaryRow,
} from '@/utils/pnlEngine';
import { computeMismatches, mismatchCount, type ComputedMismatch } from '@/utils/positionCompare';
import { computeRiskProfile, type RiskProfile } from '@/utils/riskProfile';

const POLL_FLOOR_MS = 15_000;
const POLL_CEILING_MS = 30_000;
const POLL_RELAX_STEP_MS = 5_000;
const JITTER_FRACTION = 0.2;
const UNKNOWN_TRADE_REFETCH_DEBOUNCE_MS = 1_000;
const COMPLETED_PAGE_SIZE = 50;
const CANCELLED_CAP = 200;
const RECONCILE_MS = 60_000; // completed/ids reconciliation backstop

export interface UseUserLiveTerminalOptions {
  /** Restrict to one broker (default: all enabled brokers). */
  broker?: string;
  /** live | paper | mixed — applied in the derived math, the store keeps everything. */
  mode?: TradingModeFilter;
}

export interface UserLiveTerminal {
  trades: LiveTrade[];
  algoPositions: LivePosition[];
  brokerPositions: LivePosition[];
  summary: PnlSummary;
  /** Composed tile summary (server realized + counts + client live unrealized) — mixed. */
  summaryAll: PnlSummary;
  /** Composed tile summary — paper only (UserPnLSummary derives live = all − paper). */
  summaryPaper: PnlSummary;
  /** Load the next page of today's COMPLETED trades (lazy; reset=true reloads page 1). */
  loadCompleted: (reset?: boolean) => Promise<void>;
  /** Load today's CANCELLED trades (lazy). */
  loadCancelled: () => Promise<void>;
  /** True while more completed pages remain (drives a "Load more" affordance). */
  completedHasMore: boolean;
  strategyRows: StrategySummaryRow[];
  mismatches: ComputedMismatch[];
  mismatchBadgeCount: number;
  riskProfile: RiskProfile;
  brokerRiskProfile: RiskProfile;
  /** Broker margin/capital, summed across the (broker-filtered) brokers; 0 for all-paper. */
  marginSummary: { totalMargin: number; utilizedMargin: number; availableMargin: number; usedPercent: number };
  /** Allocated capital summed across the (broker-filtered) brokers — denominator for returns%. */
  capitalTotal: number;
  isConnected: boolean;
  /** Market done for the user's exchanges (WS 4001) — quiet poll-only state. */
  marketClosed: boolean;
  /** Force an immediate reconciliation poll. */
  refresh: () => Promise<void>;
}

export function useUserLiveTerminal(options: UseUserLiveTerminalOptions = {}): UserLiveTerminal {
  const { broker, mode = 'mixed' } = options;

  const tradesById = useUserLiveStore((s) => s.tradesById);
  const algoPositionsByKey = useUserLiveStore((s) => s.algoPositionsByKey);
  const brokerPositionsByKey = useUserLiveStore((s) => s.brokerPositionsByKey);
  const ticks = useUserLiveStore((s) => s.ticks);
  const margins = useUserLiveStore((s) => s.margins);
  const capital = useUserLiveStore((s) => s.capital);
  const summaryMixedBrokers = useUserLiveStore(selectSummaryMixed);
  const summaryPaperBrokers = useUserLiveStore(selectSummaryPaper);

  const applySummarySnapshot = useUserLiveStore((s) => s.applySummarySnapshot);
  const applyActiveSnapshot = useUserLiveStore((s) => s.applyActiveSnapshot);
  const applyPositionsSnapshot = useUserLiveStore((s) => s.applyPositionsSnapshot);
  const appendCompletedPage = useUserLiveStore((s) => s.appendCompletedPage);
  const setCancelled = useUserLiveStore((s) => s.setCancelled);
  const applyTicks = useUserLiveStore((s) => s.applyTicks);
  const applyTradeUpdate = useUserLiveStore((s) => s.applyTradeUpdate);
  const applyAlgoPositionUpdate = useUserLiveStore((s) => s.applyAlgoPositionUpdate);
  const applyBrokerPositionUpdate = useUserLiveStore((s) => s.applyBrokerPositionUpdate);
  const setWsHealthy = useUserLiveStore((s) => s.setWsHealthy);

  const brokerRef = useRef(broker);
  brokerRef.current = broker;

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalRef = useRef(POLL_FLOOR_MS);
  const wsHealthyRef = useRef(false);
  const unknownTradeRefetchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconcileTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const completedCursorRef = useRef<{ cursor: number | null; cursorId: string | null } | null>(null);
  const completedLoadedRef = useRef(false);
  const mountedRef = useRef(true);
  const [completedHasMore, setCompletedHasMore] = useState(false);

  // Core live poll: the tiny split feeds that replaced the single fat /state call.
  // summary (mixed + paper) → tiles/counts/capital/margins; active → live-tracked set;
  // positions → compare/risk tabs (in-memory, same cost as the old /state positions block).
  // COMPLETED / CANCELLED are NOT here — they load lazily per tab (the perf win).
  const pollOnce = useCallback(async () => {
    const b = brokerRef.current;
    const [summaryMixed, summaryPaper, active, positions] = await Promise.allSettled([
      userLiveService.getLiveSummary({ broker: b, mode: 'mixed' }),
      userLiveService.getLiveSummary({ broker: b, mode: 'paper' }),
      userLiveService.getLiveActive({ broker: b }),
      userLiveService.getLivePositions({ broker: b }),
    ]);
    if (summaryMixed.status === 'fulfilled') applySummarySnapshot('mixed', summaryMixed.value);
    if (summaryPaper.status === 'fulfilled') applySummarySnapshot('paper', summaryPaper.value);
    if (active.status === 'fulfilled') applyActiveSnapshot(active.value);
    if (positions.status === 'fulfilled') applyPositionsSnapshot(positions.value);
    // Failures are tolerated — the next cycle retries; WS may still be live.
  }, [applySummarySnapshot, applyActiveSnapshot, applyPositionsSnapshot]);

  // Lazy: load a page of today's COMPLETED trades (history tab / scroll). reset reloads page 1.
  const loadCompleted = useCallback(
    async (reset = false) => {
      const c = reset ? null : completedCursorRef.current;
      try {
        const page = await userLiveService.getLiveCompletedPage({
          broker: brokerRef.current,
          cursor: c?.cursor ?? null,
          cursorId: c?.cursorId ?? null,
          limit: COMPLETED_PAGE_SIZE,
        });
        appendCompletedPage(page);
        completedCursorRef.current =
          page.nextCursor != null ? { cursor: page.nextCursor, cursorId: page.nextCursorId ?? null } : null;
        completedLoadedRef.current = true;
        setCompletedHasMore(page.nextCursor != null);
      } catch (e) {
        console.warn('[useUserLiveTerminal] completed load failed:', e);
      }
    },
    [appendCompletedPage],
  );

  // Lazy: load today's CANCELLED trades (cancelled tab).
  const loadCancelled = useCallback(async () => {
    try {
      const page = await userLiveService.getLiveCancelled({ broker: brokerRef.current, limit: CANCELLED_CAP });
      setCancelled(page);
    } catch (e) {
      console.warn('[useUserLiveTerminal] cancelled load failed:', e);
    }
  }, [setCancelled]);

  // Adaptive, jittered, self-rescheduling poll loop (Q6). Never stops while mounted.
  const scheduleNextPoll = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsHealthyRef.current) {
      pollIntervalRef.current = Math.min(POLL_CEILING_MS, pollIntervalRef.current + POLL_RELAX_STEP_MS);
    } else {
      pollIntervalRef.current = POLL_FLOOR_MS;
    }
    const jitter = pollIntervalRef.current * JITTER_FRACTION;
    const delay = pollIntervalRef.current - jitter + Math.random() * 2 * jitter;
    pollTimerRef.current = setTimeout(async () => {
      await pollOnce();
      scheduleNextPoll();
    }, delay);
  }, [pollOnce]);

  const scheduleUnknownTradeRefetch = useCallback(() => {
    if (unknownTradeRefetchRef.current) return; // already scheduled — coalesce bursts
    unknownTradeRefetchRef.current = setTimeout(async () => {
      unknownTradeRefetchRef.current = null;
      try {
        // A brand-new trade is active — refetch the live set only (never the wholesale
        // all-trades read, which would drop lazily-loaded completed/cancelled rows).
        const active = await userLiveService.getLiveActive({ broker: brokerRef.current });
        applyActiveSnapshot(active);
      } catch (e) {
        console.warn('[useUserLiveTerminal] unknown-trade refetch failed:', e);
      }
    }, UNKNOWN_TRADE_REFETCH_DEBOUNCE_MS);
  }, [applyActiveSnapshot]);

  const onWsMessage = useCallback(
    (data: unknown) => {
      const message = data as PortalWsMessage;
      if (!message || typeof message !== 'object') return;
      if (message.ticks) {
        applyTicks(message.ticks);
      }
      if (message.tradeUpdate) {
        const known = applyTradeUpdate(message.tradeUpdate);
        if (!known) {
          scheduleUnknownTradeRefetch(); // brand-new trade — fetch its full row
        }
      }
      if (message.algoPositionUpdate) {
        applyAlgoPositionUpdate(message.algoPositionUpdate);
      }
      if (message.brokerPositionUpdate) {
        applyBrokerPositionUpdate(message.brokerPositionUpdate);
      }
    },
    [applyTicks, applyTradeUpdate, applyAlgoPositionUpdate, applyBrokerPositionUpdate, scheduleUnknownTradeRefetch],
  );

  const ws = useWebSocket({
    // Never `orders` (replaced by tradeUpdate) and never `terminal` (no summaries,
    // alerts ride their own channel) — doc §5.5.
    subscriptions: ['ticks', 'trades', 'positions', 'alerts'],
    onMessage: onWsMessage,
    onConnect: () => {
      wsHealthyRef.current = true;
      setWsHealthy(true);
    },
    onDisconnect: () => {
      wsHealthyRef.current = false;
      setWsHealthy(false);
      pollIntervalRef.current = POLL_FLOOR_MS; // snap to the floor while WS is down
    },
  });

  // Initial load + poll loop lifecycle.
  useEffect(() => {
    mountedRef.current = true;
    pollIntervalRef.current = POLL_FLOOR_MS;
    // Fresh broker scope — lazily-loaded completed pagination restarts on demand.
    completedCursorRef.current = null;
    completedLoadedRef.current = false;
    setCompletedHasMore(false);
    void pollOnce().then(() => scheduleNextPoll());

    // Reconciliation backstop (doc §4.3): every 60s diff the server's completed-id set against
    // what we've loaded; if a completion was missed (WS drop), reload the newest completed page.
    reconcileTimerRef.current = setInterval(async () => {
      if (!completedLoadedRef.current) return; // nothing loaded yet — nothing to reconcile
      try {
        const resp = await userLiveService.getLiveCompletedIds({ broker: brokerRef.current });
        const known = useUserLiveStore.getState().tradesById;
        if ((resp.ids ?? []).some((id) => !known[id])) {
          completedCursorRef.current = null;
          await loadCompleted(true);
        }
      } catch (e) {
        console.warn('[useUserLiveTerminal] completed/ids reconcile failed:', e);
      }
    }, RECONCILE_MS);

    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (unknownTradeRefetchRef.current) clearTimeout(unknownTradeRefetchRef.current);
      if (reconcileTimerRef.current) clearInterval(reconcileTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broker]);

  // ==================== derived views (pure math, memoized) ====================

  const trades = useMemo(() => {
    const all = selectTrades({ tradesById } as never);
    return brokerRef.current ? all.filter((t) => t.broker === brokerRef.current) : all;
  }, [tradesById]);

  const algoPositions = useMemo(() => {
    const all = selectAlgoPositions({ algoPositionsByKey } as never);
    return brokerRef.current ? all.filter((p) => p.broker === brokerRef.current || !p.broker) : all;
  }, [algoPositionsByKey]);

  const brokerPositions = useMemo(() => {
    const all = selectBrokerPositions({ brokerPositionsByKey } as never);
    return brokerRef.current ? all.filter((p) => p.broker === brokerRef.current || !p.broker) : all;
  }, [brokerPositionsByKey]);

  // Tile summaries: client computes UNREALIZED + open/active counts over the active/open set only
  // (no terminal rows, so the server realized is never double-counted against lazily-loaded
  // completed); REALIZED + completed/cancelled counts + realized-charges come from the server roll-up.
  const activeOpenTrades = useMemo(
    () => trades.filter((t) => t.state === 'ACTIVE' || t.state === 'OPEN'),
    [trades],
  );
  const summaryAll = useMemo(
    () =>
      composeSummary(
        aggregatePnl(activeOpenTrades, ticks, 'mixed'),
        aggregateServerSummary(summaryMixedBrokers, brokerRef.current),
      ),
    [activeOpenTrades, ticks, summaryMixedBrokers],
  );
  const summaryPaper = useMemo(
    () =>
      composeSummary(
        aggregatePnl(activeOpenTrades, ticks, 'paper'),
        aggregateServerSummary(summaryPaperBrokers, brokerRef.current),
      ),
    [activeOpenTrades, ticks, summaryPaperBrokers],
  );
  const summary = mode === 'paper' ? summaryPaper : summaryAll;

  const strategyRows = useMemo(() => strategySummaries(trades, ticks, mode), [trades, ticks, mode]);

  const mismatches = useMemo(
    () => computeMismatches(algoPositions, brokerPositions),
    [algoPositions, brokerPositions],
  );

  const riskProfile = useMemo(() => computeRiskProfile(algoPositions, ticks), [algoPositions, ticks]);
  const brokerRiskProfile = useMemo(
    () => computeRiskProfile(brokerPositions, ticks),
    [brokerPositions, ticks],
  );

  // Broker margin/capital, summed across the user's (broker-filtered) brokers. Real-broker
  // funds only — paper trading has none, so this is naturally 0 for an all-paper user.
  const marginSummary = useMemo(() => {
    let totalMargin = 0;
    let utilizedMargin = 0;
    let availableMargin = 0;
    for (const [broker, funds] of Object.entries(margins)) {
      if (brokerRef.current && broker !== brokerRef.current) continue;
      if (!funds) continue;
      totalMargin += funds.totalMargin ?? 0;
      utilizedMargin += funds.utilizedMargin ?? 0;
      availableMargin += funds.availableMargin ?? 0;
    }
    const usedPercent = totalMargin > 0 ? (utilizedMargin / totalMargin) * 100 : 0;
    return { totalMargin, utilizedMargin, availableMargin, usedPercent };
  }, [margins]);

  // Allocated capital summed across the (broker-filtered) brokers — the returns% denominator.
  const capitalTotal = useMemo(() => {
    let total = 0;
    for (const [broker, value] of Object.entries(capital)) {
      if (brokerRef.current && broker !== brokerRef.current) continue;
      total += value ?? 0;
    }
    return total;
  }, [capital]);

  return {
    trades,
    algoPositions,
    brokerPositions,
    summary,
    summaryAll,
    summaryPaper,
    loadCompleted,
    loadCancelled,
    completedHasMore,
    strategyRows,
    mismatches,
    mismatchBadgeCount: mismatchCount(mismatches),
    riskProfile,
    brokerRiskProfile,
    marginSummary,
    capitalTotal,
    isConnected: ws.isConnected,
    marketClosed: ws.marketClosed,
    refresh: pollOnce,
  };
}
