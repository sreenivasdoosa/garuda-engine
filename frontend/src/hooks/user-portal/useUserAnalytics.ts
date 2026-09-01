/**
 * User Analytics Hook
 * React Query hooks for user's analytics and performance data
 * Services use JWT token for authentication - no username parameter needed
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAuthStore } from '@/store/authStore';
import { userAnalyticsService } from '@/services/user-portal';
import type { DateRangeFilter, TradingMode } from '@/types/user-portal';

/**
 * Hook to get user's performance stats
 */
export const useUserPerformanceStats = (dateRange?: DateRangeFilter) => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'performance-stats', username, dateRange],
    queryFn: () => userAnalyticsService.getPerformanceStats(dateRange),
    enabled: !!username,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

/**
 * Hook to get daily P&L data for equity curve
 */
export const useUserDailyPnl = (dateRange?: DateRangeFilter) => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'daily-pnl', username, dateRange],
    queryFn: () => userAnalyticsService.getDailyPnl(dateRange),
    enabled: !!username,
    staleTime: 5 * 60 * 1000,
  });
};

/**
 * Hook to get cumulative P&L data
 */
export const useUserCumulativePnl = (dateRange?: DateRangeFilter) => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'cumulative-pnl', username, dateRange],
    queryFn: () => userAnalyticsService.getCumulativePnl(dateRange),
    enabled: !!username,
    staleTime: 5 * 60 * 1000,
  });
};

/**
 * Hook to get monthly P&L data
 */
export const useUserMonthlyPnl = (dateRange?: DateRangeFilter) => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'monthly-pnl', username, dateRange],
    queryFn: () => userAnalyticsService.getMonthlyPnl(dateRange),
    enabled: !!username,
    staleTime: 5 * 60 * 1000,
  });
};

/**
 * Hook to get strategy-wise performance
 */
export const useUserStrategyPerformance = (dateRange?: DateRangeFilter) => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'strategy-performance', username, dateRange],
    queryFn: () => userAnalyticsService.getStrategyPerformance(dateRange),
    enabled: !!username,
    staleTime: 5 * 60 * 1000,
  });
};

/**
 * Hook to get all analytics data for the analytics page
 */
export const useUserAnalytics = (dateRange?: DateRangeFilter, mode: TradingMode = 'live') => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  const performanceQuery = useQuery({
    queryKey: ['user-portal', 'performance-stats', username, dateRange, mode],
    queryFn: () => userAnalyticsService.getPerformanceStats(dateRange, mode),
    enabled: !!username,
    staleTime: 5 * 60 * 1000,
  });

  const dailyPnlQuery = useQuery({
    queryKey: ['user-portal', 'daily-pnl', username, dateRange, mode],
    queryFn: () => userAnalyticsService.getDailyPnl(dateRange, mode),
    enabled: !!username,
    staleTime: 5 * 60 * 1000,
  });

  const monthlyPnlQuery = useQuery({
    queryKey: ['user-portal', 'monthly-pnl', username, dateRange, mode],
    queryFn: () => userAnalyticsService.getMonthlyPnl(dateRange, mode),
    enabled: !!username,
    staleTime: 5 * 60 * 1000,
  });

  const strategyPerformanceQuery = useQuery({
    queryKey: ['user-portal', 'strategy-performance', username, dateRange, mode],
    queryFn: () => userAnalyticsService.getStrategyPerformance(dateRange, mode),
    enabled: !!username,
    staleTime: 5 * 60 * 1000,
  });

  const isLoading =
    performanceQuery.isLoading ||
    dailyPnlQuery.isLoading ||
    monthlyPnlQuery.isLoading ||
    strategyPerformanceQuery.isLoading;

  const isError =
    performanceQuery.isError ||
    dailyPnlQuery.isError ||
    monthlyPnlQuery.isError ||
    strategyPerformanceQuery.isError;

  return {
    stats: performanceQuery.data,
    dailyPnl: dailyPnlQuery.data || [],
    monthlyPnl: monthlyPnlQuery.data || [],
    strategyPerformance: strategyPerformanceQuery.data || [],
    isLoading,
    isError,
  };
};

/**
 * Hook for default date range (last 30 days)
 */
export const useDefaultDateRange = (): DateRangeFilter => {
  return useMemo(() => {
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return {
      fromDate: thirtyDaysAgo.toISOString().split('T')[0],
      toDate: today.toISOString().split('T')[0],
    };
  }, []);
};

/**
 * Hook for FY date range
 */
export const useFYDateRange = (): DateRangeFilter => {
  return useMemo(() => {
    const today = new Date();
    const currentYear = today.getFullYear();
    const fyStart = new Date(currentYear, 3, 1); // April 1

    if (today < fyStart) {
      fyStart.setFullYear(currentYear - 1);
    }

    return {
      fromDate: fyStart.toISOString().split('T')[0],
      toDate: today.toISOString().split('T')[0],
    };
  }, []);
};
