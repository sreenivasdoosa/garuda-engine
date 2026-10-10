import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { tradeLogService } from '@/services/trade-log/tradeLogService';
import type { TradeLogFilterParams } from '@/types/tradeLog';

/**
 * The paginated trade log: data, the filter setters, and the page controls.
 * Every filter change goes back to page one, because the page you were on
 * is a page of a different list.
 */
export const useTradeLogPage = (initialParams: TradeLogFilterParams = {}) => {
  const queryClient = useQueryClient();
  const [params, setParams] = useState<TradeLogFilterParams>({
    page: 1,
    pageSize: 100,
    ...initialParams,
  });

  const dataQuery = useQuery({
    queryKey: ['trade-log', 'page', params],
    queryFn: () => tradeLogService.getPaginated(params),
    staleTime: 5000,
    refetchInterval: 30000,
  });

  const filtersQuery = useQuery({
    queryKey: ['trade-log', 'filters'],
    queryFn: () => tradeLogService.getFilters(),
    staleTime: 60000,
  });

  const setPage = useCallback((page: number) => {
    setParams((prev) => ({ ...prev, page }));
  }, []);

  const setPageSize = useCallback((pageSize: number) => {
    setParams((prev) => ({ ...prev, pageSize, page: 1 }));
  }, []);

  const setFilter = useCallback((key: keyof TradeLogFilterParams, value: string | undefined) => {
    setParams((prev) => ({ ...prev, [key]: value || undefined, page: 1 }));
  }, []);

  const setSearch = useCallback((search: string) => {
    setParams((prev) => ({ ...prev, search: search || undefined, page: 1 }));
  }, []);

  const resetFilters = useCallback(() => {
    setParams((prev) => ({ page: 1, pageSize: prev.pageSize }));
  }, []);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['trade-log'] });
  }, [queryClient]);

  return {
    entries: dataQuery.data?.entries ?? [],
    pagination: dataQuery.data?.pagination,
    filters: filtersQuery.data,
    isLoading: dataQuery.isLoading,
    isFetching: dataQuery.isFetching,
    error: dataQuery.error,
    params,
    setPage,
    setPageSize,
    setFilter,
    setSearch,
    resetFilters,
    refresh,
  };
};
