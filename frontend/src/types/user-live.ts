/**
 * Types for the user-portal client-side PnL engine (Phase 2 of
 * docs/USER_PORTAL_CLIENT_SIDE_PNL_DESIGN.md): the /api/v2/me/live/* REST shapes and
 * the tradeUpdate / algoPositionUpdate / brokerPositionUpdate WS events.
 */

/** Backend Trade row as served by /me/live/trades (subset the portal renders). */
export interface LiveTrade {
  tradeID: string;
  username: string;
  broker: string;
  strategy: string;
  tradingSymbol: string;
  exchange: string;
  direction: 'LONG' | 'SHORT';
  product?: string;
  productType?: string;
  state: 'OPEN' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | string;
  quantity: number;
  filledQuantity: number;
  entry: number;
  exit: number;
  stopLoss?: number;
  target?: number;
  cmp?: number;
  profitLoss: number;
  charges: number;
  netProfitLoss: number;
  plPercentage?: number;
  exitReason?: string | null;
  startTimestamp?: string | number | null;
  endTimestamp?: string | number | null;
  isPaperTrading: boolean;
  /** Per-symbol PnL factor (Q15): pnl = qty x (cmp - avg) x contractMultiplier. */
  contractMultiplier: number;
}

/** Backend Position row as served by /me/live/positions and the position events. */
export interface LivePosition {
  username?: string;
  broker?: string;
  productType: string; // MIS | NRML | CNC
  tradingSymbol: string;
  exchange: string;
  segment?: string;
  buyAvgPrice: number;
  sellAvgPrice: number;
  netAvgPrice: number;
  buyQty: number;
  sellQty: number;
  netQty: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  realizedPnlByEOD?: number;
  unrealizedPnlByEOD?: number;
  totalPnlByEOD?: number;
  strike?: number;
  spotCMP?: number;
  cmp?: number;
  /** Per-symbol PnL factor (Q15). */
  contractMultiplier: number;
  /** Index this symbol belongs to (risk-profile grouping, Q17); null for equity. */
  indexSymbol?: string | null;
  /** Signed residual qty of system-completed worthless legs (Q18); algo rows only. */
  worthlessQty?: number;
  isPaperTrading: boolean;
}

export interface LiveBrokerTrades {
  broker: string;
  trades: LiveTrade[];
}

export interface LiveTradesResponse {
  asOf: number;
  brokers: LiveBrokerTrades[];
}

export interface LiveBrokerPositions {
  broker: string;
  /** Last successful broker-position cache refresh (epoch ms); null if never fetched. */
  brokerPositionsAsOf?: number | null;
  algoPositions: LivePosition[];
  brokerPositions: LivePosition[];
}

export interface LivePositionsResponse {
  asOf: number;
  brokers: LiveBrokerPositions[];
}

/** Per-broker cached funds/margin (server Funds DTO) — only the fields the terminal uses. */
export interface BrokerFunds {
  totalMargin: number;
  utilizedMargin: number;
  availableMargin: number;
}

export interface LiveStateResponse {
  asOf: number;
  trades?: LiveTradesResponse;
  positions?: LivePositionsResponse;
  /** Keyed by broker; present only when the request includes `margins`. */
  margins?: Record<string, BrokerFunds>;
  /** Allocated capital per broker (with `margins`) — feeds the client-side returns% tile. */
  capital?: Record<string, number>;
}

// ==================== Phase 1+2+4 split-read shapes ====================

/** One broker's realized/unrealized roll-up from GET /me/live/summary (mode-scoped). */
export interface BrokerSummary {
  broker: string;
  realizedPnl: number;        // gross realized (sum of completed profitLoss)
  realizedCharges: number;
  realizedNetPnl: number;
  unrealizedPnl: number;      // server snapshot (client refines live from ticks)
  unrealizedCharges: number;
  unrealizedNetPnl: number;
  totalNetPnl: number;
  activeCount: number;
  completedCount: number;
  cancelledCount: number;
  capital?: number | null;
  returnsPct?: number | null;
  margins?: BrokerFunds | null;
}

/** GET /me/live/summary — O(1) per-broker roll-up, NO trade rows. */
export interface LiveSummaryResponse {
  asOf: number;
  brokers: BrokerSummary[];
}

/** GET /me/live/completed (keyset page) / /me/live/cancelled (capped) — flat, newest-first. */
export interface LiveTradePageResponse {
  asOf: number;
  trades: LiveTrade[];
  /** Compound keyset cursor for the next page (END_TIMESTAMP millis); null = no more. */
  nextCursor?: number | null;
  /** Tiebreak half of the cursor (TRADE_ID) — pass back with nextCursor. */
  nextCursorId?: string | null;
  count: number;
}

/** GET /me/live/completed/ids — index-only id list for delta-sync reconciliation. */
export interface LiveCompletedIdsResponse {
  asOf: number;
  ids: string[];
  count: number;
}

// ==================== WS messages ====================

/** One symbol's tick on the "ticks" channel; keyed by "EXCHANGE:SYMBOL". */
export interface TickEntry {
  ltp: number;
  close: number;
  change: number;
}

export type TickMap = Record<string, TickEntry>;

/** tradeUpdate delta (doc §4.3.2, Q7): tradeID is the upsert key. */
export interface TradeUpdateEvent {
  username: string;
  broker: string;
  tradeID: string;
  strategy?: string;
  tradingSymbol?: string;
  exchange?: string;
  direction?: string;
  state?: string;
  filledQuantity?: number;
  entryAvgPrice?: number | null;
  exitAvgPrice?: number | null;
  exitReason?: string | null;
  /** Money fields — populated on terminal-state events only (Q9). */
  charges?: number | null;
  profitLoss?: number | null;
  netProfitLoss?: number | null;
  orderType?: 'ENTRY' | 'SL' | 'TARGET' | 'EXIT' | null;
  orderStatus?: string | null;
  contractMultiplier?: number;
  isPaperTrading?: boolean;
  ts: number;
}

/** algoPositionUpdate / brokerPositionUpdate payload: full single-symbol row upsert. */
export interface PositionUpdateEventMsg {
  username: string;
  broker: string;
  position: LivePosition;
  ts: number;
}

/** Union shape of messages arriving on the portal WS connection. */
export interface PortalWsMessage {
  ticks?: TickMap;
  tradeUpdate?: TradeUpdateEvent;
  algoPositionUpdate?: PositionUpdateEventMsg;
  brokerPositionUpdate?: PositionUpdateEventMsg;
  alert?: unknown;
}

export type TradingModeFilter = 'live' | 'paper' | 'mixed';

export const symbolKeyOf = (exchange: string, tradingSymbol: string): string =>
  `${exchange}:${tradingSymbol}`;
