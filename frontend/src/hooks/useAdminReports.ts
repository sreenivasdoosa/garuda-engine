/**
 * Admin Reports & Analytics Hooks
 * React Query hooks for trades, reports, and analytics
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  tradeService,
  eodPnlService,
  capitalHistoryService,
  userMarginService,
  brokerLoginStatusService,
  brokerApiStatsService,
  billingPlanService,
  brokeragePlanService,
  v2BrokerService,
  analyticsService,
} from '@/services/admin/v2AdminService';
import { strategyDefinitionService } from '@/services/admin/strategyEngineService';
import type { TradeFilter, EODPnlFilter } from '@/types/reports';
import type { CreateBillingPlanRequest, CreateBrokeragePlanRequest } from '@/types/billing';
import type { CreateBrokerRequest, UpdateBrokerRequest } from '@/types/broker';
import type { CreateStrategyDefinitionRequest, UpdateStrategyDefinitionRequest } from '@/types/strategy-engine';

// ==================== TRADES ====================

export const useTrades = (filter?: TradeFilter) => {
  return useQuery({
    queryKey: ['admin', 'trades', filter],
    queryFn: () => tradeService.getTrades(filter),
  });
};

// ==================== EOD PNL REPORTS ====================

export const useEodPnlReports = (filter?: EODPnlFilter) => {
  return useQuery({
    queryKey: ['admin', 'eodPnl', filter],
    queryFn: () => eodPnlService.getReports(filter),
  });
};

// ==================== CAPITAL HISTORY ====================

export const useCapitalHistory = (params: {
  username?: string;
  broker?: string;
  strategy?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}) => {
  return useQuery({
    queryKey: ['admin', 'capitalHistory', params],
    queryFn: () => capitalHistoryService.getHistory(params),
  });
};

// ==================== USER MARGINS ====================

export const useUserMargins = (date?: string) => {
  return useQuery({
    queryKey: ['admin', 'userMargins', date],
    queryFn: () => userMarginService.getMargins(date ? { date } : {}),
    refetchInterval: 60 * 1000, // Refresh every minute
  });
};

// ==================== BROKER LOGIN STATUS ====================

export const useBrokerLoginStatus = (username?: string) => {
  return useQuery({
    queryKey: ['admin', 'brokerLoginStatus', username],
    queryFn: () => brokerLoginStatusService.getStatus(username),
    refetchInterval: 30 * 1000, // Refresh every 30 seconds
  });
};

// ==================== BROKER API STATS ====================

export const useBrokerApiStats = (params: { broker?: string; date: string }) => {
  return useQuery({
    queryKey: ['admin', 'brokerApiStats', params],
    queryFn: () => brokerApiStatsService.getStats(params),
    enabled: !!params.date,
  });
};

// ==================== BILLING PLANS ====================

export const useBillingPlans = () => {
  return useQuery({
    queryKey: ['admin', 'billingPlans'],
    queryFn: () => billingPlanService.getAll(),
    staleTime: 10 * 60 * 1000,
  });
};

export const useBillingPlan = (planName: string) => {
  return useQuery({
    queryKey: ['admin', 'billingPlans', planName],
    queryFn: () => billingPlanService.getByName(planName),
    enabled: !!planName,
  });
};

export const useBillingPlanMutations = () => {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: CreateBillingPlanRequest) => billingPlanService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'billingPlans'] });
      toast.success('Billing plan created');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to create billing plan');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ planName, data }: { planName: string; data: Partial<CreateBillingPlanRequest> }) =>
      billingPlanService.update(planName, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'billingPlans'] });
      toast.success('Billing plan updated');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update billing plan');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (planName: string) => billingPlanService.delete(planName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'billingPlans'] });
      toast.success('Billing plan deleted');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to delete billing plan');
    },
  });

  return {
    createPlan: createMutation.mutate,
    isCreating: createMutation.isPending,
    updatePlan: updateMutation.mutate,
    isUpdating: updateMutation.isPending,
    deletePlan: deleteMutation.mutate,
    isDeleting: deleteMutation.isPending,
  };
};

// ==================== BROKERAGE PLANS ====================

export const useBrokeragePlans = () => {
  return useQuery({
    queryKey: ['admin', 'brokeragePlans'],
    queryFn: () => brokeragePlanService.getAll(),
    staleTime: 10 * 60 * 1000,
  });
};

export const useBrokeragePlan = (name: string) => {
  return useQuery({
    queryKey: ['admin', 'brokeragePlans', name],
    queryFn: () => brokeragePlanService.getByName(name),
    enabled: !!name,
  });
};

export const useBrokeragePlanMutations = () => {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: CreateBrokeragePlanRequest) => brokeragePlanService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'brokeragePlans'] });
      toast.success('Brokerage plan created');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to create brokerage plan');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ planName, data }: { planName: string; data: Partial<CreateBrokeragePlanRequest> }) =>
      brokeragePlanService.update(planName, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'brokeragePlans'] });
      toast.success('Brokerage plan updated');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update brokerage plan');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (planName: string) => brokeragePlanService.delete(planName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'brokeragePlans'] });
      toast.success('Brokerage plan deleted');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to delete brokerage plan');
    },
  });

  return {
    createPlan: createMutation.mutate,
    isCreating: createMutation.isPending,
    updatePlan: updateMutation.mutate,
    isUpdating: updateMutation.isPending,
    deletePlan: deleteMutation.mutate,
    isDeleting: deleteMutation.isPending,
  };
};

// ==================== V2 BROKERS ====================

export const useV2Brokers = () => {
  return useQuery({
    queryKey: ['admin', 'v2Brokers'],
    queryFn: () => v2BrokerService.getAll(),
    staleTime: 10 * 60 * 1000,
  });
};

export const useV2Broker = (name: string) => {
  return useQuery({
    queryKey: ['admin', 'v2Brokers', name],
    queryFn: () => v2BrokerService.getByName(name),
    enabled: !!name,
  });
};

export const useV2BrokerMutations = () => {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: CreateBrokerRequest) => v2BrokerService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'v2Brokers'] });
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      toast.success('Broker created');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to create broker');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, data }: { name: string; data: UpdateBrokerRequest }) =>
      v2BrokerService.update(name, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'v2Brokers'] });
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      toast.success('Broker updated');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update broker');
    },
  });

  const stopMutation = useMutation({
    mutationFn: (name: string) => v2BrokerService.stop(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'v2Brokers'] });
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      toast.success('Broker stopped');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to stop broker');
    },
  });

  const unstopMutation = useMutation({
    mutationFn: (name: string) => v2BrokerService.unstop(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'v2Brokers'] });
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      toast.success('Broker restarted');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to restart broker');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => v2BrokerService.delete(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'v2Brokers'] });
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      toast.success('Broker deleted');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to delete broker');
    },
  });

  return {
    createBroker: createMutation.mutate,
    isCreating: createMutation.isPending,
    updateBroker: updateMutation.mutate,
    isUpdating: updateMutation.isPending,
    stopBroker: stopMutation.mutate,
    isStopping: stopMutation.isPending,
    unstopBroker: unstopMutation.mutate,
    isUnstopping: unstopMutation.isPending,
    deleteBroker: deleteMutation.mutate,
    isDeleting: deleteMutation.isPending,
  };
};

// ==================== STRATEGY DEFINITIONS ====================

export const useStrategyDefinitions = () => {
  return useQuery({
    queryKey: ['strategyDefinitions'],
    queryFn: () => strategyDefinitionService.getAll(),
    staleTime: 10 * 60 * 1000,
  });
};

export const useStrategyDefinition = (name: string) => {
  return useQuery({
    queryKey: ['strategyDefinitions', name],
    queryFn: () => strategyDefinitionService.getByName(name),
    enabled: !!name,
  });
};

export const useStrategyDefinitionMutations = () => {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: CreateStrategyDefinitionRequest) => strategyDefinitionService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategyDefinitions'] });
      toast.success('Strategy definition created');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to create strategy definition');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ strategyId, data }: { strategyId: number; data: UpdateStrategyDefinitionRequest }) =>
      strategyDefinitionService.update(strategyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategyDefinitions'] });
      toast.success('Strategy definition updated');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update strategy definition');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (strategyId: number) => strategyDefinitionService.delete(strategyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategyDefinitions'] });
      toast.success('Strategy definition deleted');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to delete strategy definition');
    },
  });

  return {
    createStrategyDefinition: createMutation.mutate,
    isCreating: createMutation.isPending,
    updateStrategyDefinition: updateMutation.mutate,
    isUpdating: updateMutation.isPending,
    deleteStrategyDefinition: deleteMutation.mutate,
    isDeleting: deleteMutation.isPending,
  };
};

// ==================== ANALYTICS ====================

export const useAdminAnalytics = (params?: { fromDate?: string; toDate?: string }) => {
  return useQuery({
    queryKey: ['admin', 'analytics', params],
    queryFn: () => analyticsService.getAnalytics(params),
    staleTime: 5 * 60 * 1000,
  });
};
