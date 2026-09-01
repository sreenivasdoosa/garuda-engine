import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useCallback, useEffect, useRef } from 'react';

import { alertsService } from '@/services/alerts/alertsService';
import { userAlertsService } from '@/services/user-portal';
import { useAuthStore } from '@/store/authStore';
import type { AlertFilterParams, SystemAlert } from '@/types/common';

// Custom event name for triggering alert refresh from WebSocket
export const ALERT_REFRESH_EVENT = 'garuda:alert-refresh';

// Throttle state for alert refresh
let lastRefreshTriggerTime = 0;
let pendingRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
const REFRESH_THROTTLE_MS = 2000; // Minimum 2 seconds between refreshes

/**
 * Trigger a refresh of alerts (called from WebSocket alert handler)
 * Throttled to prevent flooding the API - max 1 refresh every 2 seconds
 */
export const triggerAlertRefresh = () => {
  const now = Date.now();
  const timeSinceLastRefresh = now - lastRefreshTriggerTime;

  // If we recently triggered a refresh, schedule one for later (if not already scheduled)
  if (timeSinceLastRefresh < REFRESH_THROTTLE_MS) {
    if (!pendingRefreshTimeout) {
      const delay = REFRESH_THROTTLE_MS - timeSinceLastRefresh;
      pendingRefreshTimeout = setTimeout(() => {
        pendingRefreshTimeout = null;
        lastRefreshTriggerTime = Date.now();
        window.dispatchEvent(new CustomEvent(ALERT_REFRESH_EVENT));
      }, delay);
    }
    return;
  }

  // Trigger immediately
  lastRefreshTriggerTime = now;
  window.dispatchEvent(new CustomEvent(ALERT_REFRESH_EVENT));
};

/**
 * Hook for fetching recent alerts (for bell icon in header).
 * Auto-refreshes every 30 seconds and on WebSocket alert event.
 * Uses admin endpoint for admins, user-portal endpoint for regular users.
 */
export const useRecentAlerts = (limit: number = 50, alertLevel?: string) => {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();

  // Check if user has admin access
  const isAdmin = user?.canManageUsers || user?.isSysadmin;

  // Listen for custom refresh event (triggered when WebSocket alert received)
  useEffect(() => {
    const handleRefresh = () => {
      console.log('[useRecentAlerts] Refresh triggered by WebSocket alert');
      queryClient.invalidateQueries({ queryKey: ['alerts', 'recent'] });
    };

    window.addEventListener(ALERT_REFRESH_EVENT, handleRefresh);
    return () => {
      window.removeEventListener(ALERT_REFRESH_EVENT, handleRefresh);
    };
  }, [queryClient]);

  return useQuery({
    queryKey: ['alerts', 'recent', limit, alertLevel, isAdmin],
    queryFn: async (): Promise<SystemAlert[]> => {
      if (isAdmin) {
        // Admin users use the admin endpoint
        return alertsService.getRecentAlerts(limit, alertLevel);
      } else {
        // Regular users use the user-portal endpoint
        const userAlerts = await userAlertsService.getRecentAlerts(limit);
        // Map user alerts to SystemAlert format
        return userAlerts.map(alert => ({
          timestamp: alert.timestamp,
          alertLevel: alert.alertLevel,
          entityType: alert.entityType,
          entityName: alert.entityName,
          operation: alert.operation,
          alertMessage: alert.alertMessage,
        }));
      }
    },
    enabled: !!user,
    refetchInterval: 30000, // Refetch every 30 seconds
    staleTime: 10000, // Consider data stale after 10 seconds
  });
};

/**
 * Hook for fetching paginated alerts with filters and search.
 * Used on the Alerts page (admin only).
 */
export const useAlertsPage = (initialParams: AlertFilterParams = {}) => {
  const queryClient = useQueryClient();
  const [params, setParams] = useState<AlertFilterParams>({
    page: 1,
    pageSize: 100,
    ...initialParams,
  });

  // Store the latest alert timestamp for delta updates
  const latestTimestampRef = useRef<string | null>(null);

  const alertsQuery = useQuery({
    queryKey: ['alerts', 'page', params],
    queryFn: () => alertsService.getAlerts(params),
    staleTime: 5000,
  });

  const filtersQuery = useQuery({
    queryKey: ['alerts', 'filters'],
    queryFn: () => alertsService.getFilters(),
    staleTime: 60000, // Filters don't change often
  });

  // Update latest timestamp when we get new data
  useEffect(() => {
    if (alertsQuery.data?.alerts && alertsQuery.data.alerts.length > 0) {
      latestTimestampRef.current = alertsQuery.data.alerts[0].timestamp;
    }
  }, [alertsQuery.data]);

  // Function to fetch new alerts since last fetch (for auto-refresh)
  const fetchNewAlerts = useCallback(async () => {
    if (!latestTimestampRef.current) return;

    try {
      const newAlerts = await alertsService.getAlertsSince(latestTimestampRef.current);
      if (newAlerts.length > 0) {
        // Update the latest timestamp
        latestTimestampRef.current = newAlerts[0].timestamp;
        // Invalidate and refetch the current page
        queryClient.invalidateQueries({ queryKey: ['alerts', 'page'] });
        queryClient.invalidateQueries({ queryKey: ['alerts', 'recent'] });
      }
    } catch (error) {
      console.error('Failed to fetch new alerts:', error);
    }
  }, [queryClient]);

  // Auto-refresh every 20 seconds
  useEffect(() => {
    const interval = setInterval(fetchNewAlerts, 20000);
    return () => clearInterval(interval);
  }, [fetchNewAlerts]);

  // Pagination and filter handlers
  const setPage = useCallback((page: number) => {
    setParams(prev => ({ ...prev, page }));
  }, []);

  const setPageSize = useCallback((pageSize: number) => {
    setParams(prev => ({ ...prev, pageSize, page: 1 }));
  }, []);

  const setFilter = useCallback((key: keyof AlertFilterParams, value: string | undefined) => {
    setParams(prev => ({ ...prev, [key]: value, page: 1 }));
  }, []);

  const setSearch = useCallback((search: string) => {
    setParams(prev => ({ ...prev, search: search || undefined, page: 1 }));
  }, []);

  const resetFilters = useCallback(() => {
    setParams({
      page: 1,
      pageSize: params.pageSize,
    });
  }, [params.pageSize]);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['alerts', 'page'] });
    queryClient.invalidateQueries({ queryKey: ['alerts', 'recent'] });
  }, [queryClient]);

  return {
    // Data
    alerts: alertsQuery.data?.alerts || [],
    pagination: alertsQuery.data?.pagination,
    filters: filtersQuery.data,

    // Loading states
    isLoading: alertsQuery.isLoading,
    isFiltersLoading: filtersQuery.isLoading,
    isFetching: alertsQuery.isFetching,
    error: alertsQuery.error,

    // Current params
    params,

    // Actions
    setPage,
    setPageSize,
    setFilter,
    setSearch,
    resetFilters,
    refresh,
    fetchNewAlerts,
  };
};

/**
 * Hook to get unread/recent alerts count for badge display.
 * Fetches all alerts and counts by level.
 */
export const useAlertsCount = () => {
  const { data: alerts } = useRecentAlerts(50);

  // Count alerts from the last hour as "unread"
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 23);

  const recentCount = alerts?.filter(alert => alert.timestamp > oneHourAgo).length || 0;
  const criticalCount = alerts?.filter(alert => alert.alertLevel === 'CRITICAL').length || 0;

  return {
    total: alerts?.length || 0,
    recent: recentCount,
    critical: criticalCount,
  };
};
