/**
 * Live market data, over the one socket.
 *
 * There is a single WebSocket for the whole Console (`/socket`, owned by
 * WebSocketContext) and this reads ticks off it. It used to open a second
 * connection of its own, which meant two sockets per browser authenticating,
 * reconnecting and backing off independently against the same engine.
 *
 * **The engine sends every tick down one channel, synthetic ones included.**
 * A rolling straddle is an instrument here, addressed `SYNTH:STRADDLE-NIFTY`,
 * so it arrives as an ordinary tick and is bucketed by series below rather
 * than needing a stream of its own.
 *
 * **Prices arrive as strings and are parsed once, here.** The engine holds
 * them as exact decimals and JSON has only floats, so the string is the wire
 * format; converting at the edge keeps the imprecision in one place instead
 * of at every call site that formats a number.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';

/** The series the engine prices for itself. The name is the middle segment of
 *  `SYNTH:<series>-<underlying>`. */
export type SeriesKind = 'STRADDLE' | 'PCR' | 'IV' | 'IVSKEW' | 'SYNFUT';

export interface LiveTick {
  /** The engine's own id, e.g. `NSE:NIFTY_50` or `SYNTH:STRADDLE-NIFTY`. */
  instrument: string;
  exchange: string;
  /** The part after the colon. For a synthetic this is `STRADDLE-NIFTY`. */
  symbol: string;
  lastPrice: number;
  timestamp: string;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  volume: number | null;
  openInterest: number | null;
  isSynthetic: boolean;
  /** Last close to last price, when there is a previous close to compare. */
  change: number | null;
  changePercent: number | null;
}

interface WireTick {
  instrument: string;
  lastPrice: string;
  timestamp: string;
  open: string | null;
  high: string | null;
  low: string | null;
  previousClose: string | null;
  volume: number | null;
  openInterest: number | null;
  isSynthetic: boolean;
}

interface MarketDataContextType {
  isConnected: boolean;
  /** Real instruments, keyed by their engine id. */
  ticks: Map<string, LiveTick>;
  /** One map per derived series, keyed by underlying. */
  series: Map<SeriesKind, Map<string, LiveTick>>;
  lastTickAt: Date | null;
  seriesFor: (kind: SeriesKind) => Map<string, LiveTick>;
}

const MarketDataContext = createContext<MarketDataContextType | null>(null);

const NO_SERIES: Map<string, LiveTick> = new Map();

function num(value: string | null): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `SYNTH:STRADDLE-NIFTY` -> `['STRADDLE', 'NIFTY']`, else null. */
export function splitSeries(instrument: string): [SeriesKind, string] | null {
  const [prefix, rest] = instrument.split(':', 2);
  if (prefix !== 'SYNTH' || !rest) return null;
  const dash = rest.indexOf('-');
  if (dash <= 0) return null;
  return [rest.slice(0, dash) as SeriesKind, rest.slice(dash + 1)];
}

function toTick(wire: WireTick): LiveTick {
  const [exchange, symbol] = wire.instrument.includes(':')
    ? [wire.instrument.split(':', 1)[0], wire.instrument.slice(wire.instrument.indexOf(':') + 1)]
    : ['', wire.instrument];
  const lastPrice = num(wire.lastPrice) ?? 0;
  const previousClose = num(wire.previousClose);
  // A zero previous close is a real state for a synthetic on its first day,
  // and dividing by it would render Infinity in a card.
  const change = previousClose === null ? null : lastPrice - previousClose;
  return {
    instrument: wire.instrument,
    exchange,
    symbol,
    lastPrice,
    timestamp: wire.timestamp,
    open: num(wire.open),
    high: num(wire.high),
    low: num(wire.low),
    previousClose,
    volume: wire.volume ?? null,
    openInterest: wire.openInterest ?? null,
    isSynthetic: wire.isSynthetic,
    change,
    changePercent:
      change === null || previousClose === null || previousClose === 0
        ? null
        : (change / previousClose) * 100,
  };
}

export function MarketDataProvider({ children }: { children: ReactNode }) {
  const [ticks, setTicks] = useState<Map<string, LiveTick>>(new Map());
  const [series, setSeries] = useState<Map<SeriesKind, Map<string, LiveTick>>>(new Map());
  const [lastTickAt, setLastTickAt] = useState<Date | null>(null);

  const handleMessage = useCallback((data: unknown) => {
    const message = data as { type?: string; tick?: WireTick };
    if (message.type !== 'tick' || !message.tick) return;

    const tick = toTick(message.tick);
    setLastTickAt(new Date());

    const derived = splitSeries(tick.instrument);
    if (derived === null) {
      setTicks((prev) => new Map(prev).set(tick.instrument, tick));
      return;
    }
    const [kind, underlying] = derived;
    setSeries((prev) => {
      const next = new Map(prev);
      const bucket = new Map(next.get(kind) ?? NO_SERIES);
      bucket.set(underlying, tick);
      next.set(kind, bucket);
      return next;
    });
  }, []);

  const ws = useWebSocket({
    subscriptions: ['ticks'],
    autoReconnect: true,
    onMessage: handleMessage,
  });

  useEffect(() => {
    ws.connect();
    // Deliberately not cleaning up on unmount: the socket is shared with the
    // Terminal and alerts, and closing it here would take their stream too.
    // WebSocketContext drops it when its last subscriber goes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seriesFor = useCallback(
    (kind: SeriesKind) => series.get(kind) ?? NO_SERIES,
    [series],
  );

  const value = useMemo(
    () => ({ isConnected: ws.isConnected, ticks, series, lastTickAt, seriesFor }),
    [ws.isConnected, ticks, series, lastTickAt, seriesFor],
  );

  return <MarketDataContext.Provider value={value}>{children}</MarketDataContext.Provider>;
}

export function useMarketData() {
  const found = useContext(MarketDataContext);
  if (!found) {
    throw new Error('useMarketData must be used within a MarketDataProvider');
  }
  return found;
}
