/**
 * useTerminal Hook
 * Combines REST API + WebSocket for real-time terminal data
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { useWebSocket } from './useWebSocket';
import { usePermissions } from './usePermissions';
import { terminalService } from '@/services/terminal/terminalService';
import { userBrokerService } from '@/services/admin/v2AdminService';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '@/types/pagination';
import type { PaginationMeta } from '@/types/pagination';
import type {
  UserTradeSummary,
  UserTradeDetails,
  TerminalFilters,
  TerminalWebSocketMessage,
  TerminalSquareOffRequest,
  AlterTradeRequest,
  ExitPositionRequest,
  ExitPositionsResponse,
  BulkCompleteTradeItem,
  BulkCompleteTradeResult,
  SquareOffStartResponse,
  SquareOffJobStatus,
} from '@/types/terminal';
import type { SquareOffProduct } from '@/types/product';

interface UseTerminalOptions {
  /** Enable WebSocket for real-time updates */
  enableRealtime?: boolean;
  /** Initial filters */
  filters?: TerminalFilters;
}

interface UseTerminalReturn {
  // Data
  summaries: UserTradeSummary[];
  filteredSummaries: UserTradeSummary[];
  isLoading: boolean;
  error: string | null;

  // WebSocket state
  isConnected: boolean;
  isConnecting: boolean;
  reconnectAttempts: number;

  // Filters
  filters: TerminalFilters;
  setFilters: (filters: TerminalFilters) => void;

  // Server-side pagination (REST + WS share the same page window)
  page: number;
  pageSize: number;
  pagination: PaginationMeta | null;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;

  // Async bulk square-off job status — drives the persistent (manually-dismissed)
  // status banner above the terminal table. null when no job is being tracked.
  squareOffJob: SquareOffJobStatus | null;
  dismissSquareOffJob: () => void;

  // Actions
  connect: () => void;
  disconnect: () => void;
  reconnect: () => void;
  refreshSummary: (username: string, broker: string) => void;
  /** Refresh and return details - for use when row is expanded */
  refreshAndGetDetails: (username: string, broker: string) => Promise<UserTradeDetails>;

  // Details (on-demand)
  getDetails: (username: string, broker: string) => Promise<UserTradeDetails>;

  // Trade actions
  squareOff: (request: TerminalSquareOffRequest) => void;
  squareOffAsync: (request: TerminalSquareOffRequest) => Promise<SquareOffStartResponse>;
  squareOffAll: (product: SquareOffProduct, broker: string) => void;
  squareOffAllAsync: (product: SquareOffProduct, broker: string) => Promise<SquareOffStartResponse>;
  squareOffByStrategies: (strategies: string[]) => void;
  squareOffByStrategiesAsync: (strategies: string[]) => Promise<SquareOffStartResponse>;
  alterTrades: (request: AlterTradeRequest) => void;
  exitPositions: (request: ExitPositionRequest) => void;
  exitPositionsAsync: (request: ExitPositionRequest) => Promise<ExitPositionsResponse>;

  // Single trade actions
  completeTrade: (username: string, broker: string, tradeID: string, exitPrice: number, exitDate?: string) => void;
  completeTradeAsync: (username: string, broker: string, tradeID: string, exitPrice: number, exitDate?: string) => Promise<import('@/types/terminal').TerminalActionResult>;
  completeTradesBulkAsync: (username: string, broker: string, trades: BulkCompleteTradeItem[]) => Promise<BulkCompleteTradeResult[]>;
  squareOffTrade: (username: string, broker: string, tradeID: string, product?: SquareOffProduct) => void;
  squareOffTradeAsync: (username: string, broker: string, tradeID: string, product?: SquareOffProduct) => Promise<import('@/types/terminal').TerminalActionResult>;
  cancelTrade: (username: string, broker: string, tradeID: string) => void;
  cancelTradeAsync: (username: string, broker: string, tradeID: string) => Promise<import('@/types/terminal').TerminalActionResult>;

  // Action states
  isSquaringOff: boolean;
  isAltering: boolean;
  isExiting: boolean;
  isRefreshing: boolean;

  // Expanded row tracking - for WebSocket refresh filtering
  setExpandedRowKey: (key: string | null) => void;

  // Expanded row details - updated by periodic refresh
  expandedRowDetails: UserTradeDetails | null;
  expandedRowKey: string | null;
  // Key (`username-broker`) of the expanded row whose periodic refresh is in-flight.
  refreshingExpandedKey: string | null;
}

// Persist the terminal Sort-By dropdown choice across reloads / re-logins.
const TERMINAL_SORT_BY_STORAGE_KEY = 'terminal.sortBy';
const VALID_SORT_BY: ReadonlyArray<string> = [
  'username', 'algoPnl', 'algoPercent', 'brokerPnl', 'brokerPercent', 'mismatchSeverity', 'activeTradesCount', 'capital',
];
const readSavedSortBy = (): TerminalFilters['sortBy'] | undefined => {
  try {
    const saved = localStorage.getItem(TERMINAL_SORT_BY_STORAGE_KEY);
    return saved && VALID_SORT_BY.includes(saved) ? (saved as TerminalFilters['sortBy']) : undefined;
  } catch {
    return undefined; // localStorage unavailable (private mode etc.) — fall back to default.
  }
};

// Persist the terminal page-size choice across reloads / re-logins (same pattern as sortBy).
const TERMINAL_PAGE_SIZE_STORAGE_KEY = 'terminal.pageSize';
const readSavedPageSize = (): number | undefined => {
  try {
    const saved = localStorage.getItem(TERMINAL_PAGE_SIZE_STORAGE_KEY);
    const n = saved ? Number(saved) : NaN;
    return PAGE_SIZE_OPTIONS.includes(n) ? n : undefined; // ignore stale/invalid sizes
  } catch {
    return undefined; // localStorage unavailable (private mode etc.) — fall back to default.
  }
};

// Async bulk square-off polling: the POST returns immediately with a jobId and
// the server runs the work on a background thread. We poll the status endpoint
// every ~2s until the job finishes, capped at ~3 minutes, surfacing progress and
// the final COMPLETED / FAILED outcome via toasts.
const SQUAREOFF_POLL_INTERVAL_MS = 2_000;
const SQUAREOFF_POLL_MAX_MS = 180_000;

const trackSquareOffJob = (
  start: SquareOffStartResponse,
  refresh: () => void,
  onStatus: (status: SquareOffJobStatus | null) => void,
): void => {
  const usersTotal = start.usersTotal ?? 0;
  toast.info(
    start.message ||
      `Requesting square-off for ${usersTotal} user(s)…`,
    { toastId: `squareoff-${start.jobId}` },
  );

  // Seed the banner immediately (before the first poll) so the operator sees the
  // job right away. The first poll fills in scope / requestedBy from the server.
  onStatus({
    jobId: start.jobId,
    status: 'QUEUED',
    usersTotal,
    usersProcessed: 0,
    usersFailed: 0,
    tradesEnqueued: 0,
    createdAt: Date.now(),
  });

  const deadline = Date.now() + SQUAREOFF_POLL_MAX_MS;
  let lastProcessed = -1;

  const poll = async (): Promise<void> => {
    try {
      const status: SquareOffJobStatus = await terminalService.getSquareOffStatus(start.jobId);

      // Push every poll to the banner so it tracks QUEUED -> RUNNING -> terminal.
      onStatus(status);

      // Update the progress indicator only when the count advances.
      if (status.usersProcessed !== lastProcessed && status.status === 'RUNNING') {
        lastProcessed = status.usersProcessed;
        toast.update(`squareoff-${start.jobId}`, {
          render: `Requesting square-off… ${status.usersProcessed}/${status.usersTotal} user(s)`,
          type: 'info',
        });
      }

      if (status.status === 'COMPLETED') {
        // The job only ENQUEUES exits — the actual square-off runs in the background
        // dispatcher afterward. So this is "requested", not "completed/closed".
        const failedSuffix = status.usersFailed > 0 ? `, ${status.usersFailed} failed` : '';
        toast.update(`squareoff-${start.jobId}`, {
          render: `Square-off requested: ${status.tradesEnqueued} trade(s) enqueued for ${status.usersProcessed}/${status.usersTotal} user(s)${failedSuffix} — exits processing in background`,
          type: status.usersFailed > 0 ? 'warning' : 'success',
          autoClose: 6000,
        });
        refresh();
        return;
      }

      if (status.status === 'FAILED') {
        toast.update(`squareoff-${start.jobId}`, {
          render: `Square-off failed: ${status.error ? String(status.error).split('\n')[0] : 'unknown error'}`,
          type: 'error',
          autoClose: 8000,
        });
        refresh();
        return;
      }

      // Still QUEUED / RUNNING — keep polling until the deadline.
      if (Date.now() < deadline) {
        setTimeout(() => { void poll(); }, SQUAREOFF_POLL_INTERVAL_MS);
      } else {
        toast.update(`squareoff-${start.jobId}`, {
          render: `Square-off still running (${status.usersProcessed}/${status.usersTotal}); check status later`,
          type: 'warning',
          autoClose: 6000,
        });
        refresh();
      }
    } catch {
      // Transient polling error — retry until the deadline, then give up quietly.
      if (Date.now() < deadline) {
        setTimeout(() => { void poll(); }, SQUAREOFF_POLL_INTERVAL_MS);
      }
    }
  };

  setTimeout(() => { void poll(); }, SQUAREOFF_POLL_INTERVAL_MS);
};

export const useTerminal = (options: UseTerminalOptions = {}): UseTerminalReturn => {
  const { enableRealtime = true, filters: initialFilters = {} } = options;

  const queryClient = useQueryClient();

  // Local state for summaries (updated via WebSocket)
  const [summaries, setSummaries] = useState<UserTradeSummary[]>([]);

  // Server-side pagination window (shared by REST + the per-socket WS stream).
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => readSavedPageSize() ?? DEFAULT_PAGE_SIZE);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [filters, setFilters] = useState<TerminalFilters>(() => {
    // Saved Sort-By preference (if any) overrides the caller-provided default.
    const savedSortBy = readSavedSortBy();
    return savedSortBy ? { ...initialFilters, sortBy: savedSortBy } : initialFilters;
  });
  const [wsError, setWsError] = useState<string | null>(null);

  // Async bulk square-off job status for the persistent status banner.
  const [squareOffJob, setSquareOffJob] = useState<SquareOffJobStatus | null>(null);
  const dismissSquareOffJob = useCallback(() => setSquareOffJob(null), []);

  // Persist the Sort-By dropdown choice so a reload / re-login restores it.
  useEffect(() => {
    try {
      if (filters.sortBy) {
        localStorage.setItem(TERMINAL_SORT_BY_STORAGE_KEY, filters.sortBy);
      }
    } catch {
      // ignore persistence failures (private mode / quota)
    }
  }, [filters.sortBy]);

  // ---- Server-side filtering: broker / search / online / active are applied by the server on the
  // FULL enabled user-broker set (then paginated), not client-side over the current page. The search
  // is debounced and gated to >= 2 chars (so a single keystroke doesn't refetch, and blanks clear it).
  const [serverSearch, setServerSearch] = useState('');
  useEffect(() => {
    const raw = (filters.username || '').trim();
    const t = setTimeout(() => setServerSearch(raw.length >= 2 ? raw : ''), 300);
    return () => clearTimeout(t);
  }, [filters.username]);
  const serverBroker = filters.broker || undefined;
  const onlineOnly = !!filters.showOnlyLoggedIn;
  const activeOnly = !!filters.showOnlyWithActiveTrades;
  // Only "capital" sorts SERVER-SIDE (it needs the full set ranked to page correctly);
  // every other sort field stays client-side over the current page, so it must NOT enter
  // the list query key/params (a local sort change must not trigger a refetch). Default DESC.
  const remoteSortBy = filters.sortBy === 'capital' ? 'capital' : undefined;
  const remoteSortOrder = remoteSortBy ? (filters.sortOrder || 'desc') : undefined;
  // Any server-side filter (or page-size, or the remote capital sort) change resets to page 1 —
  // the current page may not exist in the new filtered/ranked result set.
  useEffect(() => {
    setPage(1);
  }, [serverSearch, serverBroker, onlineOnly, activeOnly, pageSize, remoteSortBy, remoteSortOrder]);

  // Persist the page-size choice so a reload / re-login restores it.
  useEffect(() => {
    try {
      localStorage.setItem(TERMINAL_PAGE_SIZE_STORAGE_KEY, String(pageSize));
    } catch {
      // ignore persistence failures (private mode / quota)
    }
  }, [pageSize]);

  // Expanded row state - details updated by periodic refresh
  const [expandedRowKey, setExpandedRowKeyState] = useState<string | null>(null);
  const [expandedRowDetails, setExpandedRowDetails] = useState<UserTradeDetails | null>(null);

  // Debounced refresh state - track pending refresh for expanded row only
  const expandedRowKeyRef = useRef<string | null>(null);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const periodicRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const FALLBACK_REFRESH_MS = 10000; // 10 seconds fallback for brokers without WebSocket updates
  const PERIODIC_REFRESH_MS = 10000; // gap AFTER the previous expanded-row refresh completes (fixed-delay)

  // Single-flight guard for the expanded-row refresh (periodic + manual). The
  // ref is the synchronous source of truth. We track the *key* of the row being
  // refreshed (not a bare boolean) so the disabled state applies only to that
  // one row — other rows' refresh buttons stay clickable.
  const expandedRefreshInFlightRef = useRef(false);
  const [refreshingExpandedKey, setRefreshingExpandedKey] = useState<string | null>(null);
  const refreshExpandedRowRef = useRef<(() => void) | null>(null);

  // The detail panel is fetched as 3 permission-gated calls (trades/positions/margins). Decide
  // which the caller may fetch from their tool rights, and keep it in a ref so the (stable,
  // []-dep) fetch callbacks always read the latest without being re-created.
  const { trades: tradesPerm, positions: positionsPerm, margins: marginsPerm, algoBrokerCompare } = usePermissions();
  const detailsScopeRef = useRef({ trades: false, positions: false, margins: false });
  detailsScopeRef.current = {
    trades: tradesPerm.canView,
    positions: positionsPerm.canView,
    margins: marginsPerm.canView,
  };
  // Without ALGO_BROKER_COMPARE View, don't fetch broker positions at all for the detail panel
  // (the compare columns/exit are hidden anyway). The summary refresh below is NOT gated — that
  // data is shared with full-permission managers/admins viewing the same rows.
  const canCompareRef = useRef(false);
  canCompareRef.current = algoBrokerCompare.canView;

  // Clear all refresh timers
  const clearAllRefreshTimers = useCallback(() => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
      refreshTimeoutRef.current = null;
    }
    if (fallbackRefreshTimeoutRef.current) {
      clearTimeout(fallbackRefreshTimeoutRef.current);
      fallbackRefreshTimeoutRef.current = null;
    }
    if (periodicRefreshTimeoutRef.current) {
      clearTimeout(periodicRefreshTimeoutRef.current);
      periodicRefreshTimeoutRef.current = null;
    }
  }, []);

  // Refresh the expanded row's summary + details, then re-arm the next run
  // PERIODIC_REFRESH_MS *after* this one settles (fixed-delay). Single-flight:
  // skips if a refresh (periodic or manual) is already running, so requests
  // never overlap even when one takes 10-15s on a slow link.
  const refreshExpandedRow = useCallback(async () => {
    const key = expandedRowKeyRef.current;
    if (!key) return;
    if (expandedRefreshInFlightRef.current) return;
    expandedRefreshInFlightRef.current = true;
    setRefreshingExpandedKey(key);
    const [username, broker] = key.split('-');
    try {
      // Periodic refresh uses cached broker positions/margins (force=false) to avoid hitting
      // the broker every tick; only the explicit Refresh button forces.
      const { summary, details } = await terminalService.fullRefresh(
        username, broker, detailsScopeRef.current, { fetchBrokerPositions: canCompareRef.current, force: false });
      // Ignore the result if the row was collapsed/switched while in-flight.
      if (expandedRowKeyRef.current === key) {
        setSummaries(prev => {
          const index = prev.findIndex(s => `${s.username}-${s.broker}` === key);
          if (index >= 0) {
            const updated = [...prev];
            updated[index] = summary;
            return updated;
          }
          return [...prev, summary];
        });
        setExpandedRowDetails(details);
      }
    } catch (error) {
      console.error(`[Terminal] Periodic refresh failed for ${key}:`, error);
    } finally {
      expandedRefreshInFlightRef.current = false;
      setRefreshingExpandedKey(null);
      if (expandedRowKeyRef.current) {
        periodicRefreshTimeoutRef.current = setTimeout(() => {
          refreshExpandedRowRef.current?.();
        }, PERIODIC_REFRESH_MS);
      }
    }
  }, []);
  // Keep a stable ref to the latest runner so the self-rescheduling setTimeout
  // (and the manual refresh) can invoke it without a dependency cycle.
  refreshExpandedRowRef.current = refreshExpandedRow;

  // Set expanded row key - called by component when row is expanded/collapsed
  const setExpandedRowKey = useCallback((key: string | null) => {
    const previousKey = expandedRowKeyRef.current;
    expandedRowKeyRef.current = key;

    // Update state
    setExpandedRowKeyState(key);

    // Clear details when row is collapsed or switched
    if (key === null || key !== previousKey) {
      setExpandedRowDetails(null);
    }

    // Clear any pending refresh timers
    clearAllRefreshTimers();

    // Start the periodic (fixed-delay) refresh if a row is expanded. The first
    // tick fires PERIODIC_REFRESH_MS after expand; each subsequent tick is armed
    // only once the previous refresh has fully settled (see refreshExpandedRow).
    if (key !== null && key !== previousKey) {
      console.log('[Terminal] Starting periodic refresh for expanded row:', key);
      periodicRefreshTimeoutRef.current = setTimeout(() => {
        refreshExpandedRowRef.current?.();
      }, PERIODIC_REFRESH_MS);
    }
  }, [clearAllRefreshTimers]);

  // LIST + pagination: which user-brokers exist on this page (cheap — no summary
  // compute). Demand-driven model: the live summary VALUES + WS scope are derived
  // from these rows (see below).
  const {
    data: userBrokerPage,
    isLoading: ubLoading,
    error: ubError,
    refetch: refetchUserBrokers,
  } = useQuery({
    queryKey: ['terminal', 'user-brokers', page, pageSize, serverSearch, serverBroker ?? '', onlineOnly, activeOnly, remoteSortBy ?? '', remoteSortOrder ?? ''],
    // Terminal lists only ACTIVE user-brokers (ENABLED=1) — these are the rows that
    // actually have computed summaries (computeAllSummaries skips disabled brokers).
    // Other pages (e.g. the user-brokers admin table) call getPaginated without this
    // filter and still see all rows. broker/search/online/active are applied SERVER-SIDE
    // (the server filters the full set then paginates) so totals/pages are correct across pages.
    queryFn: () => userBrokerService.getPaginated({
      page, pageSize, status: 'enabled',
      search: serverSearch || undefined,
      broker: serverBroker,
      onlineOnly,
      activeOnly,
      sortBy: remoteSortBy,
      sortOrder: remoteSortOrder,
    }),
    staleTime: 30000,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  // The (username, broker) rows on the current page — the live-summary scope.
  const pageUserBrokers = useMemo(
    () => (userBrokerPage?.data ?? []).map((ub) => ({ username: ub.username, broker: ub.broker })),
    [userBrokerPage],
  );
  const scopeKey = useMemo(
    () => pageUserBrokers.map((u) => `${u.username}-${u.broker}`).join(','),
    [pageUserBrokers],
  );

  // VALUES: live summaries for ONLY the current page's rows (server computes just these).
  const {
    data: initialSummaries,
    isLoading: sumLoading,
    error: sumError,
    refetch: refetchSummaries,
  } = useQuery({
    queryKey: ['terminal', 'summaries', scopeKey],
    queryFn: () => terminalService.getSummaries(pageUserBrokers),
    enabled: pageUserBrokers.length > 0,
    staleTime: 5000,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const isLoading = ubLoading || sumLoading;
  const queryError = ubError || sumError;
  const refetch = useCallback(() => {
    refetchUserBrokers();
    refetchSummaries();
  }, [refetchUserBrokers, refetchSummaries]);

  // Execute refresh for expanded row
  const executeExpandedRowRefresh = useCallback(async () => {
    refreshTimeoutRef.current = null;

    const key = expandedRowKeyRef.current;
    if (!key) return;

    console.log('[Terminal] Executing debounced refresh for expanded row:', key);

    const [username, broker] = key.split('-');
    try {
      // This path only updates the summary, so POST the refresh alone (no detail calls).
      const summary = await terminalService.refreshSummary({ username, broker, fetchBrokerPositions: true });
      setSummaries(prev => {
        const index = prev.findIndex(s => `${s.username}-${s.broker}` === key);
        if (index >= 0) {
          const updated = [...prev];
          updated[index] = summary;
          return updated;
        }
        return [...prev, summary];
      });
    } catch (error) {
      console.error(`[Terminal] Failed to refresh ${key}:`, error);
    }
  }, []);

  // Schedule a fallback refresh after exit operations (for brokers without WebSocket updates)
  // Only refreshes if the specified user-broker row is still expanded after 10 seconds
  const scheduleFallbackRefresh = useCallback((username: string, broker: string) => {
    const targetKey = `${username}-${broker}`;

    // Clear any existing fallback timeout
    if (fallbackRefreshTimeoutRef.current) {
      clearTimeout(fallbackRefreshTimeoutRef.current);
    }

    fallbackRefreshTimeoutRef.current = setTimeout(() => {
      fallbackRefreshTimeoutRef.current = null;
      const expandedKey = expandedRowKeyRef.current;

      // Only refresh if this user's row is still expanded
      if (expandedKey === targetKey) {
        console.log('[Terminal] Executing fallback refresh for:', targetKey);
        executeExpandedRowRefresh();
      }
    }, FALLBACK_REFRESH_MS);
  }, [executeExpandedRowRefresh]);

  // Handle WebSocket messages
  const handleWebSocketMessage = useCallback((data: unknown) => {
    const message = data as TerminalWebSocketMessage;

    if (message.terminalSummaries) {
      // Scoped stream: a "full" carries the current scope's values (one-time sync on
      // scope change), a "delta" only changed rows within the scope. Pagination is
      // owned by REST (the user-broker list query), NOT the WS payload.
      if (message.type === 'full') {
        setSummaries(message.terminalSummaries);
      } else if (message.type === 'delta') {
        // Delta update - merge changed summaries by (username, broker).
        const summariesToMerge = message.terminalSummaries;
        setSummaries(prev => {
          const updated = [...prev];
          for (const newSummary of summariesToMerge) {
            const key = `${newSummary.username}-${newSummary.broker}`;
            const existingIndex = updated.findIndex(
              s => `${s.username}-${s.broker}` === key
            );

            if (existingIndex >= 0) {
              updated[existingIndex] = newSummary;
            } else {
              updated.push(newSummary);
            }
          }
          return updated;
        });
      }
    }
    // Order/position WS nudges are gone (admin no longer subscribes to those
    // channels): the scoped summary delta carries the change, and the expanded-row
    // drill-down refreshes via the periodic REST poll.
  }, []);

  // Cleanup all refresh timers on unmount
  useEffect(() => {
    return () => {
      clearAllRefreshTimers();
    };
  }, [clearAllRefreshTimers]);

  // WebSocket connection — ticks + terminal (scoped summary deltas) only. Orders/
  // positions nudges are gone; the scoped summary delta already carries changes, and
  // the expanded-row drill-down refreshes via periodic REST.
  const ws = useWebSocket({
    subscriptions: ['ticks', 'terminal'],
    autoReconnect: true,
    reconnectDelay: 3000,
    maxReconnectAttempts: 10,
    onMessage: handleWebSocketMessage,
    onConnect: () => {
      setWsError(null);
      console.log('[Terminal] WebSocket connected, requesting full summaries');
    },
    onDisconnect: () => {
      console.log('[Terminal] WebSocket disconnected');
    },
    onError: () => {
      setWsError('WebSocket connection error');
    },
  });

  // Summaries (VALUES) come from the scoped getSummaries; pagination from the
  // user-broker LIST query.
  useEffect(() => {
    if (initialSummaries) {
      setSummaries(initialSummaries);
    }
  }, [initialSummaries]);

  useEffect(() => {
    if (userBrokerPage?.pagination) {
      setPagination(userBrokerPage.pagination);
    }
  }, [userBrokerPage]);

  // Tell the server the EXACT (username,broker) rows this admin is viewing, so it
  // computes + streams live deltas for ONLY those. Re-sent on page change and on
  // (re)connect. Replaces the old per-socket page window.
  useEffect(() => {
    if (ws.isConnected && pageUserBrokers.length > 0) {
      ws.send({ method: 'setSummaryScope', summaryUsers: pageUserBrokers });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, ws.isConnected]);

  // Auto-connect WebSocket when enabled
  useEffect(() => {
    if (enableRealtime) {
      ws.connect();
    }
    return () => {
      if (enableRealtime) {
        ws.disconnect();
      }
    };
  }, [enableRealtime]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter and sort summaries.
  // NOTE: username (search), broker, "active" and "online" are applied SERVER-SIDE on the full set
  // before pagination (see the user-brokers list query above), so we must NOT re-filter them here —
  // doing so would wrongly drop rows from the already-correct server page. Only the filters the server
  // can't cheaply do (mismatch — needs live position comparison; allocationModel) stay client-side,
  // plus sorting of the current page.
  const filteredSummaries = useMemo(() => {
    let result = [...summaries];

    if (filters.allocationModel) {
      result = result.filter(s => s.allocationModel === filters.allocationModel);
    }

    if (filters.showOnlyWithMismatch) {
      result = result.filter(s => s.mismatchSeverity !== 'NONE');
    }

    // LOCAL-only (never sent to the server): rows with any cancelled trades.
    if (filters.showOnlyCancelled) {
      result = result.filter(s => (s.cancelledTradesCount || 0) > 0 || (s.paperCancelledTradesCount || 0) > 0);
    }

    // showOnlyWithActiveTrades ("active") and showOnlyLoggedIn ("online") are applied server-side
    // (see the list query) — not re-filtered here.

    // Apply sorting
    const sortBy = filters.sortBy || 'username';
    // Capital defaults to DESC (largest first) so the client's page order matches the
    // server's default capital ranking; every other field keeps its ASC default.
    const sortOrder = filters.sortOrder || (sortBy === 'capital' ? 'desc' : 'asc');
    const multiplier = sortOrder === 'asc' ? 1 : -1;

    result.sort((a, b) => {
      switch (sortBy) {
        case 'algoPnl':
          return (a.algoPnl - b.algoPnl) * multiplier;
        case 'algoPercent': {
          // Matches the Algo % column: algoPnl / totalCapital * 100.
          const aPct = a.totalCapital > 0 ? (a.algoPnl / a.totalCapital) * 100 : 0;
          const bPct = b.totalCapital > 0 ? (b.algoPnl / b.totalCapital) * 100 : 0;
          return (aPct - bPct) * multiplier;
        }
        case 'brokerPnl':
          return (a.brokerPnl - b.brokerPnl) * multiplier;
        case 'brokerPercent': {
          // Matches the Broker % column: brokerPnl / (totalCapital + externalCapital) * 100.
          const aCap = (a.totalCapital || 0) + (a.externalCapital || 0);
          const bCap = (b.totalCapital || 0) + (b.externalCapital || 0);
          const aPct = aCap > 0 ? (a.brokerPnl / aCap) * 100 : 0;
          const bPct = bCap > 0 ? (b.brokerPnl / bCap) * 100 : 0;
          return (aPct - bPct) * multiplier;
        }
        case 'capital': {
          // Server already ranked the full set by capital to decide page membership; we
          // re-sort the visible page by the SAME formula (algo + external) so the on-screen
          // order is correct regardless of the order the summaries arrived in.
          const aCap = (a.totalCapital || 0) + (a.externalCapital || 0);
          const bCap = (b.totalCapital || 0) + (b.externalCapital || 0);
          return (aCap - bCap) * multiplier;
        }
        case 'activeTradesCount':
          return (a.activeTradesCount - b.activeTradesCount) * multiplier;
        case 'mismatchSeverity': {
          const severityOrder = { CRITICAL: 3, WARNING: 2, NONE: 1 };
          return (severityOrder[a.mismatchSeverity] - severityOrder[b.mismatchSeverity]) * multiplier;
        }
        case 'username':
        default:
          return a.username.localeCompare(b.username) * multiplier;
      }
    });

    return result;
  }, [summaries, filters]);

  // Summary-only refresh mutation (exposed as refreshSummary) — POSTs the refresh and uses the
  // returned summary; it doesn't need the detail sections, so it skips the 3 detail calls.
  const refreshMutation = useMutation({
    mutationFn: ({ username, broker }: { username: string; broker: string }) =>
      terminalService.refreshSummary({ username, broker, fetchBrokerPositions: true }),
    onSuccess: (updatedSummary) => {
      setSummaries(prev => {
        const key = `${updatedSummary.username}-${updatedSummary.broker}`;
        const index = prev.findIndex(s => `${s.username}-${s.broker}` === key);
        if (index >= 0) {
          const updated = [...prev];
          updated[index] = updatedSummary;
          return updated;
        }
        return [...prev, updatedSummary];
      });
      toast.success(`Refreshed ${updatedSummary.username}`);
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to refresh summary');
    },
  });

  // Refresh helper used when an async square-off job finishes.
  const refreshAfterSquareOff = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['terminal'] });
    refetch();
  }, [queryClient, refetch]);

  // Square off mutation (bulk, async). The POST returns immediately with a jobId;
  // we poll the status endpoint until the background job completes.
  const squareOffMutation = useMutation({
    mutationFn: terminalService.squareOff,
    onSuccess: (result) => {
      trackSquareOffJob(result, refreshAfterSquareOff, setSquareOffJob);
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to square off positions');
    },
  });

  // Square off ALL users mutation (bulk, async).
  const squareOffAllMutation = useMutation({
    mutationFn: ({ product, broker }: { product: SquareOffProduct; broker: string }) =>
      terminalService.squareOffAll(product, broker),
    onSuccess: (result) => {
      trackSquareOffJob(result, refreshAfterSquareOff, setSquareOffJob);
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to square off positions for all users');
    },
  });

  // Square off by strategies mutation (all users, bulk, async).
  const squareOffByStrategiesMutation = useMutation({
    mutationFn: (strategies: string[]) =>
      terminalService.squareOffByStrategies(strategies),
    onSuccess: (result) => {
      trackSquareOffJob(result, refreshAfterSquareOff, setSquareOffJob);
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to square off by strategies');
    },
  });

  // Alter trades mutation
  const alterMutation = useMutation({
    mutationFn: terminalService.alterTrades,
    onSuccess: (_result, request) => {
      queryClient.invalidateQueries({ queryKey: ['terminal'] });
      refetch();
      toast.success(`${request.action} completed for ${request.username}`);
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to alter trades');
    },
  });

  // Exit positions mutation
  const exitMutation = useMutation({
    mutationFn: terminalService.exitPositions,
    onSuccess: (results, request) => {
      queryClient.invalidateQueries({ queryKey: ['terminal'] });
      refetch();

      // Count successes, errors, and partials
      const successCount = results.filter(r => r.status === 'success').length;
      const errorCount = results.filter(r => r.status === 'error').length;
      const partialCount = results.filter(r => r.status === 'partial').length;

      if (errorCount === 0 && partialCount === 0) {
        // All succeeded
        const totalOrders = results.reduce((sum, r) => sum + (r.orderIds?.length || 0), 0);
        toast.success(`Exited ${totalOrders} order(s) for ${results.length} position(s) - ${request.username}`);
      } else if (successCount === 0 && partialCount === 0) {
        // All failed
        const errors = results.map(r => `${r.tradingSymbol}: ${r.message}`).join('\n');
        toast.error(`All exit orders failed:\n${errors}`);
      } else {
        // Mixed results
        const messages: string[] = [];
        if (successCount > 0) messages.push(`${successCount} succeeded`);
        if (partialCount > 0) messages.push(`${partialCount} partial`);
        if (errorCount > 0) messages.push(`${errorCount} failed`);
        toast.warning(`Exit positions for ${request.username}: ${messages.join(', ')}`);

        // Show errors in separate toasts
        results.filter(r => r.status === 'error' || r.status === 'partial')
          .forEach(r => {
            toast.error(`${r.tradingSymbol}: ${r.message}`);
          });
      }

      // Schedule fallback refresh after 10 seconds for brokers without WebSocket updates
      // This ensures UI gets updated even if broker doesn't send order/position updates via WebSocket
      if (successCount > 0 || partialCount > 0) {
        scheduleFallbackRefresh(request.username, request.broker);
      }
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to exit positions');
    },
  });

  // Complete single trade mutation
  const completeTradeMutation = useMutation({
    mutationFn: ({ username, broker, tradeID, exitPrice, exitDate }: {
      username: string;
      broker: string;
      tradeID: string;
      exitPrice: number;
      exitDate?: string;
    }) => terminalService.completeTrade(username, broker, tradeID, exitPrice, exitDate),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['terminal'] });
      refetch();
      toast.success(result.message || 'Trade marked as complete');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to complete trade');
    },
  });

  // Complete multiple trades mutation
  const completeTradesBulkMutation = useMutation({
    mutationFn: ({ username, broker, trades }: {
      username: string;
      broker: string;
      trades: BulkCompleteTradeItem[];
    }) => terminalService.completeTradesBulk(username, broker, trades),
    onSuccess: (results) => {
      queryClient.invalidateQueries({ queryKey: ['terminal'] });
      refetch();

      const successCount = results.filter(r => r.status === 'success').length;
      const errorResults = results.filter(r => r.status === 'error');

      if (successCount > 0) {
        toast.success(`Set ${successCount} trade${successCount === 1 ? '' : 's'} as complete`);
      }
      if (errorResults.length > 0) {
        toast.warning(`${errorResults.length} trade${errorResults.length === 1 ? '' : 's'} failed to set as complete`);
        errorResults.forEach(result => {
          toast.error(`${result.tradeID}: ${result.message || 'Failed to set as complete'}`);
        });
      }
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to complete selected trades');
    },
  });

  // Square off single trade mutation
  const squareOffTradeMutation = useMutation({
    mutationFn: ({ username, broker, tradeID, product }: {
      username: string;
      broker: string;
      tradeID: string;
      product?: SquareOffProduct;
    }) => terminalService.squareOffTrade(username, broker, tradeID, product),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['terminal'] });
      refetch();
      // result.status contains the server message (from data.data.status)
      toast.success(result.status || result.message || 'Trade square off initiated');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to square off trade');
    },
  });

  // Cancel open trade mutation
  const cancelTradeMutation = useMutation({
    mutationFn: ({ username, broker, tradeID }: {
      username: string;
      broker: string;
      tradeID: string;
    }) => terminalService.cancelTrade(username, broker, tradeID),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['terminal'] });
      refetch();
      toast.success(result.message || 'Trade cancelled successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to cancel trade');
    },
  });

  // Get details (on-demand)
  const getDetails = useCallback(async (username: string, broker: string) => {
    // On expand, fetch only permitted sections; use cached broker positions/margins
    // (force=false) so opening a row doesn't hit the broker — the Refresh button forces.
    return terminalService.getScopedDetails(username, broker, detailsScopeRef.current, {
      fetchBrokerPositions: canCompareRef.current,
      force: false,
    });
  }, []);

  // Manual refresh (refresh button) - calls both APIs and returns details for
  // the row to update. Fires immediately, but first cancels the pending periodic
  // tick so it can't run concurrently, and re-arms the fixed-delay cycle once
  // done — so a manual refresh resets the 10s clock.
  const refreshAndGetDetails = useCallback(async (username: string, broker: string): Promise<UserTradeDetails> => {
    const key = `${username}-${broker}`;
    // Only coordinate with the periodic machinery when the manual refresh is for
    // the currently-expanded row. A refresh on any OTHER row must not disturb the
    // expanded row's periodic timer or single-flight latch. (The per-row button's
    // own disabled state is handled by `refreshingUsers`, keyed per user+broker.)
    const isExpandedRow = expandedRowKeyRef.current === key;
    if (isExpandedRow) {
      if (periodicRefreshTimeoutRef.current) {
        clearTimeout(periodicRefreshTimeoutRef.current);
        periodicRefreshTimeoutRef.current = null;
      }
      expandedRefreshInFlightRef.current = true;
    }
    try {
      // Manual refresh forces a fresh broker fetch (force=true) for the permitted sections.
      const { summary, details } = await terminalService.fullRefresh(
        username, broker, detailsScopeRef.current, { fetchBrokerPositions: canCompareRef.current, force: true });

      // Update the summaries state
      setSummaries(prev => {
        const summaryKey = `${summary.username}-${summary.broker}`;
        const index = prev.findIndex(s => `${s.username}-${s.broker}` === summaryKey);
        if (index >= 0) {
          const updated = [...prev];
          updated[index] = summary;
          return updated;
        }
        return [...prev, summary];
      });

      toast.success(`Refreshed ${username}`);
      return details;
    } finally {
      if (isExpandedRow) {
        expandedRefreshInFlightRef.current = false;
        // Re-arm the periodic cycle if this row is still the expanded one.
        if (expandedRowKeyRef.current === key) {
          periodicRefreshTimeoutRef.current = setTimeout(() => {
            refreshExpandedRowRef.current?.();
          }, PERIODIC_REFRESH_MS);
        }
      }
    }
  }, []);

  return {
    // Data
    summaries,
    filteredSummaries,
    isLoading,
    error: queryError?.message || wsError,

    // WebSocket state
    isConnected: ws.isConnected,
    isConnecting: ws.isConnecting,
    reconnectAttempts: ws.reconnectAttempts,

    // Filters
    filters,
    setFilters,

    // Server-side pagination
    page,
    pageSize,
    pagination,
    setPage,
    setPageSize,

    // Async square-off job status (persistent banner)
    squareOffJob,
    dismissSquareOffJob,

    // Actions
    connect: ws.connect,
    disconnect: ws.disconnect,
    reconnect: ws.reconnect,
    refreshSummary: (username: string, broker: string) => refreshMutation.mutate({ username, broker }),
    refreshAndGetDetails,

    // Details
    getDetails,

    // Trade actions
    squareOff: squareOffMutation.mutate,
    squareOffAsync: squareOffMutation.mutateAsync,
    squareOffAll: (product: SquareOffProduct, broker: string) =>
      squareOffAllMutation.mutate({ product, broker }),
    squareOffAllAsync: (product: SquareOffProduct, broker: string) =>
      squareOffAllMutation.mutateAsync({ product, broker }),
    squareOffByStrategies: squareOffByStrategiesMutation.mutate,
    squareOffByStrategiesAsync: squareOffByStrategiesMutation.mutateAsync,
    alterTrades: alterMutation.mutate,
    exitPositions: exitMutation.mutate,
    exitPositionsAsync: exitMutation.mutateAsync,

    // Single trade actions
    completeTrade: (username: string, broker: string, tradeID: string, exitPrice: number, exitDate?: string) =>
      completeTradeMutation.mutate({ username, broker, tradeID, exitPrice, exitDate }),
    completeTradeAsync: (username: string, broker: string, tradeID: string, exitPrice: number, exitDate?: string) =>
      completeTradeMutation.mutateAsync({ username, broker, tradeID, exitPrice, exitDate }),
    completeTradesBulkAsync: (username: string, broker: string, trades: BulkCompleteTradeItem[]) =>
      completeTradesBulkMutation.mutateAsync({ username, broker, trades }),
    squareOffTrade: (username: string, broker: string, tradeID: string, product?: SquareOffProduct) =>
      squareOffTradeMutation.mutate({ username, broker, tradeID, product }),
    squareOffTradeAsync: (username: string, broker: string, tradeID: string, product?: SquareOffProduct) =>
      squareOffTradeMutation.mutateAsync({ username, broker, tradeID, product }),
    cancelTrade: (username: string, broker: string, tradeID: string) =>
      cancelTradeMutation.mutate({ username, broker, tradeID }),
    cancelTradeAsync: (username: string, broker: string, tradeID: string) =>
      cancelTradeMutation.mutateAsync({ username, broker, tradeID }),

    // Action states
    isSquaringOff: squareOffMutation.isPending,
    isAltering: alterMutation.isPending,
    isExiting: exitMutation.isPending,
    isRefreshing: refreshMutation.isPending,

    // Expanded row tracking - for WebSocket refresh filtering
    setExpandedRowKey,

    // Expanded row details - updated by periodic refresh
    expandedRowDetails,
    expandedRowKey,
    refreshingExpandedKey,
  };
};

export default useTerminal;
