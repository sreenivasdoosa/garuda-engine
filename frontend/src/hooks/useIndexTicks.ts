/**
 * useIndexTicks — surface NIFTY 50 + SENSEX ticks to the app header.
 *
 * Data flow:
 *   1. On mount, fetch initial quotes via REST (/api/v2/market-data/quotes)
 *      so the cards have prices before the first WebSocket tick — and so
 *      they stay populated when markets are closed / on holidays (no WS
 *      pushes arrive, REST snapshot keeps the previous-close visible).
 *   2. Subscribe to the always-on terminal WebSocket ("ticks" channel) via
 *      WebSocketContext. Payload shape (per WebSocketService.java in
 *      engine backend):
 *        { ticks: { "EXCH:SYMBOL": { ltp, close, change }, ... } }
 *      That channel works in BOTH standalone and distributed deployment
 *      modes — algo-trade-core's TradeManager populates liveTicksCacheMap
 *      either from the embedded market-data (standalone) or via
 *      a socket against a remote market-data service.
 *   3. We compute change / changePct on the client from ltp + close. We
 *      do not trust the bare backend `change` field because for indices
 *      it's absolute while for tradables it's percent — recomputing from
 *      (ltp, close) gives one consistent semantic across symbol types.
 */
import { useEffect, useRef, useState } from 'react';
import { useWebSocketContext } from '@/context/WebSocketContext';
import { mdQuotesApi } from '@/api/marketDataApi';

export interface HeaderIndexConfig {
  /** Full key used both as cache key and on the WebSocket payload. */
  key: string;
  /** Trading symbol as known to the broker / market-data feed. */
  symbol: string;
  /** Exchange code. */
  exchange: string;
  /** Short label shown on the card. */
  label: string;
}

export const HEADER_INDICES: readonly HeaderIndexConfig[] = [
  { key: 'NSE:NIFTY 50', symbol: 'NIFTY 50', exchange: 'NSE', label: 'NIFTY' },
  { key: 'BSE:SENSEX',   symbol: 'SENSEX',   exchange: 'BSE', label: 'SENSEX' },
] as const;

interface IndexState {
  lastPrice: number;
  close: number;     // previous-day close; stable for the trading day
  timestamp: number;
}

export interface IndexTick {
  key: string;
  symbol: string;
  exchange: string;
  label: string;
  /** False until either REST or WS has produced a price for this symbol. */
  hasData: boolean;
  lastPrice?: number;
  close?: number;
  change?: number;
  changePct?: number;
  timestamp?: number;
  /** True once WebSocket has delivered at least one update for this symbol. */
  isLive?: boolean;
}

const SUB_ID = 'header-index-ticks';

export function useIndexTicks(): IndexTick[] {
  const { subscribe, unsubscribe, isConnected } = useWebSocketContext();
  const [state, setState] = useState<Record<string, IndexState>>({});
  // Track which symbols have ever received a live WS tick this session.
  // Used purely for the green "live" dot; doesn't gate rendering.
  const liveSeenRef = useRef<Set<string>>(new Set());
  const [liveKeys, setLiveKeys] = useState<Set<string>>(new Set());

  // 1) REST seed on mount — fills `close` (which the WS payload also has
  //    but won't deliver until the next 500ms fan-out tick) plus an
  //    initial `lastPrice` for the holiday / pre-open case.
  useEffect(() => {
    mdQuotesApi.getQuotes(HEADER_INDICES.map((i) => i.key))
      .then((quotes) => {
        if (!Array.isArray(quotes)) return;
        const seed: Record<string, IndexState> = {};
        quotes.forEach((q) => {
          if (!q || !q.exchange || !q.tradingSymbol) return;
          const k = `${q.exchange}:${q.tradingSymbol}`;
          seed[k] = {
            lastPrice: q.lastTradedPrice ?? q.close ?? 0,
            close: q.close ?? 0,
            timestamp: q.lastTradedTimestamp ? Date.parse(q.lastTradedTimestamp) : Date.now(),
          };
        });
        // Merge under existing WS values — never let a slow REST response
        // overwrite a live tick that arrived first.
        setState((prev) => {
          const next: Record<string, IndexState> = { ...seed };
          Object.entries(prev).forEach(([k, v]) => {
            next[k] = v.lastPrice > 0 ? v : { ...seed[k], ...v };
          });
          return next;
        });
      })
      .catch(() => {
        // Non-fatal: cards stay empty until the WS produces a tick.
      });
  }, []);

  // 2) WS subscription — bound to the "ticks" channel of the
  //    algo-trade-core terminal WebSocket (always-on, both deployment modes).
  useEffect(() => {
    subscribe(SUB_ID, ['ticks'], {
      onMessage: (data: unknown) => {
        const msg = data as { ticks?: Record<string, { ltp?: number; close?: number; change?: number } | number> } | null;
        if (!msg?.ticks) return;

        const updates: Record<string, IndexState> = {};
        let liveChanged = false;

        HEADER_INDICES.forEach((idx) => {
          const raw = msg.ticks?.[idx.key];
          if (raw == null) return;

          // Tolerate both shapes during deploy window:
          //   - new:    { ltp, close, change }
          //   - legacy: bare number (just ltp). If we ever see this we
          //     keep the previously-seeded close.
          let ltp: number | undefined;
          let close: number | undefined;
          if (typeof raw === 'number') {
            ltp = raw;
          } else if (typeof raw === 'object') {
            ltp = typeof raw.ltp === 'number' ? raw.ltp : undefined;
            close = typeof raw.close === 'number' ? raw.close : undefined;
          }
          if (typeof ltp !== 'number' || ltp <= 0) return;

          updates[idx.key] = {
            lastPrice: ltp,
            // WS-supplied close wins when present; otherwise hold whatever
            // REST seeded. close > 0 guard avoids clobbering with a zero
            // from a market-data race during pre-open.
            close: typeof close === 'number' && close > 0 ? close : 0,
            timestamp: Date.now(),
          };

          if (!liveSeenRef.current.has(idx.key)) {
            liveSeenRef.current.add(idx.key);
            liveChanged = true;
          }
        });

        if (Object.keys(updates).length > 0) {
          setState((prev) => {
            const next: Record<string, IndexState> = { ...prev };
            Object.entries(updates).forEach(([k, u]) => {
              const prior = prev[k];
              next[k] = {
                lastPrice: u.lastPrice,
                // Preserve prior.close when this WS frame didn't carry one
                // (legacy / partial payload).
                close: u.close > 0 ? u.close : prior?.close ?? 0,
                timestamp: u.timestamp,
              };
            });
            return next;
          });
        }

        if (liveChanged) {
          setLiveKeys(new Set(liveSeenRef.current));
        }
      },
    });
    return () => unsubscribe(SUB_ID);
  }, [subscribe, unsubscribe]);

  return HEADER_INDICES.map<IndexTick>((idx) => {
    const s = state[idx.key];
    if (!s || s.lastPrice <= 0) {
      return { ...idx, hasData: false };
    }
    const close = s.close;
    const change = close > 0 ? s.lastPrice - close : 0;
    const changePct = close > 0 ? (change / close) * 100 : 0;
    return {
      ...idx,
      hasData: true,
      lastPrice: s.lastPrice,
      close,
      change,
      changePct,
      timestamp: s.timestamp,
      isLive: liveKeys.has(idx.key) && isConnected,
    };
  });
}
