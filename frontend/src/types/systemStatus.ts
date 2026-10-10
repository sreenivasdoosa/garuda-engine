/**
 * System Status: the engine read end to end, as /api/system-status serves it.
 *
 * Panels the engine answers are null when the API runs without one
 * (`engineAttached` says so); the panels the tables answer are always there.
 * A panel that could not be built carries `error` instead of its fields.
 */

export interface PanelError {
  error: string;
}

export interface RuntimeStatus {
  version: string;
  python: string;
  startedAt: string | null;
  uptimeSeconds: number | null;
  cpuCount: number | null;
  loadAverage: number[] | null;
  processRssMb: number | null;
  systemMemoryTotalMb: number | null;
  systemMemoryAvailableMb: number | null;
  systemMemoryUsedMb: number | null;
  openFileDescriptors: number | null;
  maxFileDescriptors: number | null;
  threads: number;
  asyncioTasks: number;
}

export type FeedState = 'UP' | 'DOWN' | 'INACTIVE';

export interface FeedStatus {
  provider: string | null;
  status: 'connected' | 'disconnected' | 'stopped';
  isRunning: boolean;
  nominated: boolean;
  connectedSince: string | null;
  lastTickAt: string | null;
  lastDisconnectReason: string | null;
  subscriptions: number;
  quoting: number;
  ticksPublished: number;
  reconnects: number;
  consecutiveFailures: number;
  lastAttemptAt: string | null;
  /** UP when connected; INACTIVE outside market hours; DOWN while a market is open. */
  state: FeedState;
  marketOpen: boolean;
  historyProvider: string | null;
}

export interface StrategyLoopStatus {
  running: boolean;
  intervalSeconds: number | null;
  tradingDay: string;
  strategiesLoaded: number;
  subscriptions: number;
  refused: Record<string, string>;
  tranchesOpen: number;
  tranchesToday: number;
}

export interface LoopsStatus {
  runnerRunning: boolean;
  tradeLoopsStarted: boolean;
  accountsCycling: string[];
  strategyLoop: StrategyLoopStatus | null;
}

export type SessionState = 'LOGGED_IN' | 'FAILED' | 'LOGGED_OUT' | 'NONE';

export interface AccountRow {
  tradingClientId: string;
  displayName: string;
  broker: string;
  clientId: string;
  enabled: boolean;
  session: SessionState;
  loginError: string | null;
  sessionCreatedOn: string | null;
  isTrading: boolean;
  unavailableBecause: string | null;
  isCycling: boolean;
}

export interface AccountsStatus {
  configured: number;
  loggedIn: number;
  failed: number;
  loggedOut: number;
  trading: number;
  rows: AccountRow[];
}

export interface BrokerRow {
  name: string;
  enabled: boolean;
  stopped: boolean;
  accounts: number;
  loggedIn: number;
  trading: number;
}

export interface BrokersStatus {
  total: number;
  enabled: number;
  stopped: number;
  rows: BrokerRow[];
}

export interface VenueRow {
  code: string;
  name: string;
  timezone: string;
  tradingDay: string;
  isTradingDay: boolean;
  isOpen: boolean;
  sessions: { opens: string; closes: string }[];
  nextPhase: { phase: string; at: string } | null;
}

export interface VenuesStatus {
  anyMarketOpen: boolean;
  rows: VenueRow[];
}

export interface StrategiesStatus {
  definitions: {
    total: number;
    active: number;
    windDown: number;
    inactive: number;
    tickEnabled: number;
    scheduledEnabled: number;
    signalEnabled: number;
    periodicEnabled: number;
  };
  subscriptions: {
    total: number;
    active: number;
    inactive: number;
    paper: number;
    live: number;
  };
}

export interface KillSwitchRow {
  scope: string;
  tradingClient: string | null;
  exchange: string | null;
  symbol: string | null;
  reason: string | null;
  source: string;
}

export interface RiskStatus {
  enabled: boolean;
  activeKillSwitches: number;
  killSwitches: KillSwitchRow[];
  killSwitchTypes: Record<string, boolean>;
  breachesToday: number;
  limitRows: number | null;
}

export interface InstrumentFileRow {
  name: string;
  kind: string;
  provider: string;
  loaded: boolean;
  count: number;
  cachedAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastDownloaded: boolean;
  inProgress: boolean;
  isFromToday: boolean;
  isStale: boolean;
  skippedBecause: string | null;
}

export interface SystemStatus {
  generatedAt: string;
  engineAttached: boolean;
  tradingDay: string;
  runtime: RuntimeStatus | PanelError | null;
  feed: FeedStatus | PanelError | null;
  loops: LoopsStatus | PanelError | null;
  venues: VenuesStatus | PanelError | null;
  instrumentFiles: InstrumentFileRow[] | PanelError | null;
  accounts: AccountsStatus;
  brokers: BrokersStatus;
  strategies: StrategiesStatus;
  risk: RiskStatus;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error: string | null;
  lastPrice: string | null;
  at: string | null;
  candles: number | null;
  interval: string | null;
}

export interface HealthCheck {
  instrument: string;
  tick: ProbeResult;
  history: ProbeResult;
}

export interface TimelineEvent {
  timestamp: string;
  message: string;
}

export interface InitTimeline {
  startup: TimelineEvent[];
  day: TimelineEvent[];
  engineAttached: boolean;
}

/** Narrow a panel to its fields, or null when it is absent or errored. */
export const panel = <T extends object>(value: T | PanelError | null | undefined): T | null =>
  value && !('error' in value) ? (value as T) : null;

export const panelError = (value: object | null | undefined): string | null =>
  value && 'error' in value ? String((value as PanelError).error) : null;
