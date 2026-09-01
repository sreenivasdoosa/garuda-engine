import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { tradeService } from '@/services/trade/tradeService';
import type { TradeFilter, TradeAction, SquareOffRequest } from '@/types/trade';

export const useTrades = (filters?: TradeFilter) => {
  return useQuery({
    queryKey: ['trades', filters],
    queryFn: () => tradeService.getTrades(filters),
    refetchInterval: 30000, // Refresh every 30 seconds for active monitoring
  });
};

export const useActiveTrades = (filters?: Partial<TradeFilter>) => {
  return useQuery({
    queryKey: ['trades', 'active', filters],
    queryFn: () => tradeService.getActiveTrades(filters),
    refetchInterval: 10000, // Refresh more frequently for active trades
  });
};

export const useTradeHistory = (filters?: TradeFilter) => {
  return useQuery({
    queryKey: ['trades', 'history', filters],
    queryFn: () => tradeService.getTradeHistory(filters),
  });
};

export const usePositions = (filters?: {
  userId?: string;
  broker?: string;
  strategy?: string;
}) => {
  return useQuery({
    queryKey: ['positions', filters],
    queryFn: () => tradeService.getPositions(filters),
    refetchInterval: 10000,
  });
};

export const useTradeSummary = (filters?: TradeFilter) => {
  return useQuery({
    queryKey: ['trades', 'summary', filters],
    queryFn: () => tradeService.getSummary(filters),
  });
};

export const useDailyPerformance = (params: {
  userId?: string;
  broker?: string;
  strategy?: string;
  fromDate: string;
  toDate: string;
}) => {
  return useQuery({
    queryKey: ['performance', 'daily', params],
    queryFn: () => tradeService.getDailyPerformance(params),
    enabled: !!params.fromDate && !!params.toDate,
  });
};

export const useMonthlyPerformance = (params: { userId?: string; year?: number }) => {
  return useQuery({
    queryKey: ['performance', 'monthly', params],
    queryFn: () => tradeService.getMonthlyPerformance(params),
  });
};

export const useStrategyPerformance = (params: {
  userId?: string;
  fromDate?: string;
  toDate?: string;
}) => {
  return useQuery({
    queryKey: ['performance', 'strategy', params],
    queryFn: () => tradeService.getStrategyPerformance(params),
  });
};

export const useTradeMutations = () => {
  const queryClient = useQueryClient();

  const modifyTradeMutation = useMutation({
    mutationFn: (action: TradeAction) => tradeService.modifyTrade(action),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trades'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      toast.success('Trade modified successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to modify trade');
    },
  });

  const cancelTradeMutation = useMutation({
    mutationFn: ({ tradeId, reason }: { tradeId: string; reason?: string }) =>
      tradeService.cancelTrade(tradeId, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trades'] });
      toast.success('Trade cancelled successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to cancel trade');
    },
  });

  const exitTradeMutation = useMutation({
    mutationFn: ({
      tradeId,
      data,
    }: {
      tradeId: string;
      data?: { quantity?: number; price?: number };
    }) => tradeService.exitTrade(tradeId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trades'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      toast.success('Trade exited successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to exit trade');
    },
  });

  const squareOffMutation = useMutation({
    mutationFn: (request: SquareOffRequest) => tradeService.squareOff(request),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['trades'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      toast.success(`Squared off ${result.squaredOff} positions`);
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to square off positions');
    },
  });

  return {
    modifyTrade: modifyTradeMutation.mutate,
    isModifying: modifyTradeMutation.isPending,
    cancelTrade: cancelTradeMutation.mutate,
    isCancelling: cancelTradeMutation.isPending,
    exitTrade: exitTradeMutation.mutate,
    isExiting: exitTradeMutation.isPending,
    squareOff: squareOffMutation.mutate,
    isSquaringOff: squareOffMutation.isPending,
  };
};
