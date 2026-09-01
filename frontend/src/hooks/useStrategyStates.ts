/**
 * useStrategyStates Hook
 * Manages strategy state monitoring with auto-refresh
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { strategyStateService, breakoutWatchService } from '@/services/admin/strategyEngineService';
import type {
  StrategyStateSnapshot,
  StrategyStateSummary,
  StrategyStateFilters,
  BreakoutWatch,
} from '@/types/strategy-engine';

// Auto-refresh interval: 1 minute
const AUTO_REFRESH_INTERVAL = 60 * 1000;

interface UseStrategyStatesOptions {
  /** Enable auto-refresh (default: true) */
  autoRefresh?: boolean;
  /** Initial filters */
  filters?: StrategyStateFilters;
}

interface UseStrategyStatesReturn {
  // Data
  states: StrategyStateSnapshot[];
  summary: StrategyStateSummary | null;
  isLoading: boolean;
  isSummaryLoading: boolean;
  error: string | null;

  // Filters
  filters: StrategyStateFilters;
  setFilters: (filters: StrategyStateFilters) => void;

  // Actions
  refresh: () => void;
  refreshSummary: () => void;

  // State
  lastUpdated: Date | null;
  isRefreshing: boolean;
}

export const useStrategyStates = (
  options: UseStrategyStatesOptions = {}
): UseStrategyStatesReturn => {
  const { autoRefresh = true, filters: initialFilters = {} } = options;

  const [filters, setFilters] = useState<StrategyStateFilters>(initialFilters);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Query for states list
  const {
    data: states = [],
    isLoading,
    error: statesError,
    refetch: refetchStates,
    isFetching: isRefetchingStates,
  } = useQuery({
    queryKey: ['strategyStates', filters],
    queryFn: () => strategyStateService.getStates(filters),
    staleTime: 30 * 1000, // 30 seconds
    refetchOnWindowFocus: false,
  });

  // Query for summary
  const {
    data: summary = null,
    isLoading: isSummaryLoading,
    error: summaryError,
    refetch: refetchSummary,
    isFetching: isRefetchingSummary,
  } = useQuery({
    queryKey: ['strategyStatesSummary', filters.date],
    queryFn: () => strategyStateService.getSummary(filters.date),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });

  // Update lastUpdated when data changes
  useEffect(() => {
    if (states.length > 0 || summary) {
      setLastUpdated(new Date());
    }
  }, [states, summary]);

  // Auto-refresh setup
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        refetchStates();
        refetchSummary();
      }, AUTO_REFRESH_INTERVAL);

      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
      };
    }
  }, [autoRefresh, refetchStates, refetchSummary]);

  // Manual refresh
  const refresh = useCallback(() => {
    refetchStates();
    refetchSummary();
    toast.info('Refreshing strategy states...', { autoClose: 1000 });
  }, [refetchStates, refetchSummary]);

  const refreshSummary = useCallback(() => {
    refetchSummary();
  }, [refetchSummary]);

  // Error handling
  const error = statesError
    ? (statesError as Error).message
    : summaryError
    ? (summaryError as Error).message
    : null;

  return {
    states,
    summary,
    isLoading,
    isSummaryLoading,
    error,
    filters,
    setFilters,
    refresh,
    refreshSummary,
    lastUpdated,
    isRefreshing: isRefetchingStates || isRefetchingSummary,
  };
};

/**
 * Hook for fetching a specific user's strategy state details
 * Used in the UserDetailsPanel tab
 */
interface UseUserStrategyStateOptions {
  username: string;
  broker: string;
  enabled?: boolean;
}

interface UseUserStrategyStateReturn {
  states: StrategyStateSnapshot[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  getStrategyDetails: (strategyName: string) => Promise<StrategyStateSnapshot>;
  getBreakoutWatches: () => Promise<BreakoutWatch[]>;
}

export const useUserStrategyStates = (
  options: UseUserStrategyStateOptions
): UseUserStrategyStateReturn => {
  const { username, broker, enabled = true } = options;

  const {
    data: states = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['userStrategyStates', username, broker],
    queryFn: () => strategyStateService.getStates({ username }),
    enabled: enabled && !!username,
    staleTime: 30 * 1000,
  });

  // Filter states for the specific broker
  const brokerStates = states.filter((s) => s.brokerName === broker);

  const refresh = useCallback(() => {
    refetch();
  }, [refetch]);

  const getStrategyDetails = useCallback(
    async (strategyName: string): Promise<StrategyStateSnapshot> => {
      return strategyStateService.getDetails(username, strategyName, broker);
    },
    [username, broker]
  );

  const getBreakoutWatches = useCallback(
    async (): Promise<BreakoutWatch[]> => {
      return breakoutWatchService.getByUserBroker(username, broker);
    },
    [username, broker]
  );

  return {
    states: brokerStates,
    isLoading,
    error: error ? (error as Error).message : null,
    refresh,
    getStrategyDetails,
    getBreakoutWatches,
  };
};

export default useStrategyStates;
