/**
 * User Terminal Hook
 * React Query hooks and WebSocket integration for user's live terminal data
 * Services use JWT token for authentication - no username parameter needed
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuthStore } from '@/store/authStore';
import { userTerminalService } from '@/services/user-portal';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { UserTradeSummary, TerminalWebSocketMessage } from '@/types/terminal';
import type { UserTerminalSummary } from '@/types/user-portal';

// Auto-refresh interval for terminal details (15 seconds)
const TERMINAL_DETAILS_REFRESH_INTERVAL = 15000;

/**
 * Hook to get user's terminal summary (REST - initial load only)
 * WebSocket handles live updates, so we use long staleTime
 */
export const useUserTerminalSummary = () => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'terminal-summary', username],
    queryFn: () => userTerminalService.getAggregatedSummary(),
    enabled: !!username,
    staleTime: Infinity, // WebSocket provides live updates
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });
};

/**
 * Hook to get user's broker-wise terminal summaries (REST - initial load only)
 * WebSocket handles live updates
 */
export const useUserBrokerSummaries = () => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'broker-summaries', username],
    queryFn: () => userTerminalService.getSummary(),
    enabled: !!username,
    staleTime: Infinity, // WebSocket provides live updates
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });
};

/**
 * Hook to get user's positions
 * Only refetched on order/position updates via WebSocket
 */
export const useUserPositions = () => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'positions', username],
    queryFn: () => userTerminalService.getPositions(),
    enabled: !!username,
    staleTime: 60000, // 1 minute - only refetch on explicit invalidation
    refetchOnWindowFocus: false,
  });
};

/**
 * Hook to get user's active trades
 * Only refetched on order/position updates via WebSocket
 */
export const useUserActiveTrades = () => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'active-trades', username],
    queryFn: () => userTerminalService.getActiveTrades(),
    enabled: !!username,
    staleTime: 60000, // 1 minute - only refetch on explicit invalidation
    refetchOnWindowFocus: false,
  });
};

/**
 * Hook for real-time terminal data with WebSocket
 */
export const useUserTerminalLive = () => {
  const { user, isAuthenticated } = useAuthStore();
  const username = user?.username || '';
  const queryClient = useQueryClient();

  const [liveSummary, setLiveSummary] = useState<UserTerminalSummary | null>(null);
  const [brokerSummaries, setBrokerSummaries] = useState<UserTradeSummary[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const lastUpdateRef = useRef<number>(0);

  // Get initial data from REST
  const { data: initialSummary, isLoading } = useUserTerminalSummary();
  const { data: initialBrokerSummaries } = useUserBrokerSummaries();

  // Initialize from REST data
  useEffect(() => {
    if (initialSummary && !liveSummary) {
      setLiveSummary(initialSummary);
    }
  }, [initialSummary, liveSummary]);

  useEffect(() => {
    if (initialBrokerSummaries && brokerSummaries.length === 0) {
      setBrokerSummaries(initialBrokerSummaries);
    }
  }, [initialBrokerSummaries, brokerSummaries.length]);

  // WebSocket message handler
  const handleMessage = useCallback(
    (message: TerminalWebSocketMessage) => {
      if (!username) return;

      // Terminal summaries over WebSocket are ADMIN-only now (demand-scoped). The
      // user portal gets its summary via periodic REST (already implemented) and the
      // order/position update nudges below; it no longer consumes terminalSummaries
      // off the WS, nor subscribes to the "terminal" channel.

      // Handle order/position update notifications - refresh all trade data on changes
      if (message.orderUpdate || message.positionUpdate) {
        const notification = message.orderUpdate || message.positionUpdate;
        if (notification?.username === username) {
          // Refresh all detailed data when there's an order/position change
          queryClient.invalidateQueries({ queryKey: ['user-portal', 'positions'] });
          queryClient.invalidateQueries({ queryKey: ['user-portal', 'active-trades'] });
          queryClient.invalidateQueries({ queryKey: ['user-portal', 'terminal-details'] });
          console.log('[UserTerminal] Order/position update received, refreshing trade details');
        }
      }
    },
    [username, queryClient]
  );

  // Store callbacks in refs to avoid re-creating WebSocket on every render
  const handleMessageRef = useRef(handleMessage);
  handleMessageRef.current = handleMessage;

  // WebSocket connection — orders/positions nudges only (terminal summaries over WS
  // are admin-only now; the portal summary comes from periodic REST).
  const { connect, disconnect, reconnect, isConnected: wsConnected } = useWebSocket({
    onMessage: (data: unknown) => handleMessageRef.current(data as TerminalWebSocketMessage),
    onConnect: () => setIsConnected(true),
    onDisconnect: () => setIsConnected(false),
    subscriptions: ['orders', 'positions'],
    autoReconnect: true,
  });

  // Update isConnected from WebSocket state
  useEffect(() => {
    setIsConnected(wsConnected);
  }, [wsConnected]);

  // Connect on mount when authenticated
  // Use isAuthenticated (which is persisted) instead of username (which is not)
  // This ensures WebSocket connects immediately on page refresh
  useEffect(() => {
    if (isAuthenticated) {
      connect();
    }
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  return {
    summary: liveSummary,
    brokerSummaries,
    isLoading,
    isConnected,
    reconnect,
    lastUpdate: lastUpdateRef.current,
    refresh: () => {
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'terminal-summary'] });
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-summaries'] });
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'terminal-details'] });
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'positions'] });
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'active-trades'] });
    },
  };
};

/**
 * Hook to get detailed trade data for a specific broker
 * Includes all trades (active, completed, open, cancelled), positions, and mismatches
 * Auto-refreshes every 15 seconds and on order/position WebSocket updates
 */
export const useUserTerminalDetails = (broker: string) => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'terminal-details', username, broker],
    queryFn: () =>
      userTerminalService.getDetails(broker, {
        fetchBrokerPositions: true,
        fetchMargins: true,
      }),
    enabled: !!username && !!broker,
    staleTime: 10000, // 10 seconds - consider data stale faster
    refetchInterval: TERMINAL_DETAILS_REFRESH_INTERVAL, // Auto-refresh every 15 seconds
    refetchOnWindowFocus: false,
  });
};

/**
 * Hook for P&L chart data (intraday)
 * Accepts brokerSummaries from parent to avoid creating duplicate WebSocket connections
 */
export const useUserIntradayPnL = (brokerSummaries: UserTradeSummary[]) => {
  const [pnlHistory, setPnlHistory] = useState<{ time: number; pnl: number }[]>([]);

  useEffect(() => {
    if (brokerSummaries.length > 0) {
      const totalPnl = brokerSummaries.reduce((sum, s) => sum + s.netPnl, 0);
      const now = Date.now();

      setPnlHistory((prev) => {
        // Keep last 8 hours of data (assuming 5s intervals)
        const maxPoints = (8 * 60 * 60 * 1000) / 5000; // ~5760 points
        const newHistory = [...prev, { time: now, pnl: totalPnl }];
        return newHistory.slice(-maxPoints);
      });
    }
  }, [brokerSummaries]);

  return pnlHistory;
};
