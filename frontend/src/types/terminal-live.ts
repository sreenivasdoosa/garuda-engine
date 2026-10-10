/**
 * The Terminal, as garuda serves it: each account as the engine believes it
 * stands. Money arrives as strings — the engine's P&L is an exact decimal and
 * JSON has only floats — so the page formats and never computes.
 */

export interface TradeCounts {
  open: number;
  active: number;
  completed: number;
  cancelled: number;
  failed: number;
}

export interface PnlFigures {
  realised: string;
  unrealised: string;
  total: string;
  /** Active positions with no tick yet; they are not in `unrealised`. */
  unpriced: number;
}

export interface AccountSummary {
  tradingClientId: string;
  displayName: string;
  broker: string;
  clientId: string;
  isTrading: boolean;
  unavailableBecause: string | null;
  counts: TradeCounts;
  paperCounts: TradeCounts;
  pnl: PnlFigures;
  paperPnl: PnlFigures;
  positions: number;
  paperPositions: number;
  asOf: string | null;
}

export interface TerminalTrade {
  tradeId: string;
  instrument: string;
  tradingSymbol: string;
  strategy: string;
  group: string;
  direction: 'LONG' | 'SHORT';
  product: string;
  state: 'OPEN' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  quantity: number;
  filledQuantity: number;
  entry: string | null;
  exit: string | null;
  exitReason: string | null;
  exitingFor: string | null;
  failureReason: string | null;
  realisedPnl: string | null;
  stopLoss: string | null;
  target: string | null;
  isPaper: boolean;
  isHedge: boolean;
  startedAt: string | null;
  endedAt: string | null;
  remarks: string | null;
}

export interface TerminalTradeGroups {
  open: TerminalTrade[];
  active: TerminalTrade[];
  completed: TerminalTrade[];
  cancelled: TerminalTrade[];
  failed: TerminalTrade[];
}

export interface EnginePosition {
  instrument: string;
  tradingSymbol: string;
  exchange: string;
  product: string;
  isPaper: boolean;
  buyQuantity: number;
  sellQuantity: number;
  netQuantity: number;
  buyAverage: string | null;
  sellAverage: string | null;
  lastPrice: string | null;
  realised: string;
  unrealised: string | null;
  tradeIds: string[];
}

export interface AccountDetails {
  summary: AccountSummary;
  /** Null when the account is not trading. */
  trades: TerminalTradeGroups | null;
  positions: EnginePosition[];
}

export interface BrokerPositionRow {
  instrument: string;
  tradingSymbol: string;
  exchange: string;
  quantity: number;
  averagePrice: string;
  product: string;
  multiplier: string;
}

export interface MarginsRow {
  available: string;
  used: string;
  total: string;
}

export interface TerminalAlert {
  timestamp: string;
  alertLevel: 'CRITICAL' | 'WARNING' | 'INFO';
  entityType: string;
  entityName: string;
  operation: string;
  alertMessage: string;
  occurrences: number;
  key: string | null;
}

export interface SquareOffOutcome {
  requested: string[];
  skipped: Record<string, string>;
}

export type SquareOffScope = 'ALL' | 'INTRADAY' | 'POSITIONAL';

/** What the `terminal` channel sends over the one socket. */
export interface TerminalSocketMessage {
  type: 'full' | 'delta' | 'alert' | 'tick' | 'connected' | 'disconnected';
  terminalSummaries?: AccountSummary[];
  alert?: TerminalAlert;
}
