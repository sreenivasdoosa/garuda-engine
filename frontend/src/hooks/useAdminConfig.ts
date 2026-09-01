/**
 * Admin Configuration Hooks
 * React Query hooks for system configuration, exchanges, etc.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  exchangeService,
  holidayService,
  eventDayService,
  brokerExchangeConfigService,
  allocationModelService,
  faqService,
  auditLogService,
} from '@/services/admin/v2AdminService';
import type {
  CreateExchangeRequest,
  CreateHolidayRequest,
  CreateBrokerExchangeConfigRequest,
} from '@/types/exchange';
import type {
  CreateAllocationModelRequest,
  AllocationModelStrategy,
} from '@/types/billing';
import type { CreateFAQRequest, AuditLogFilter } from '@/types/system';

// ==================== EXCHANGES ====================

export const useExchanges = () => {
  return useQuery({
    queryKey: ['admin', 'exchanges'],
    queryFn: () => exchangeService.getAll(),
    staleTime: 10 * 60 * 1000,
  });
};

export const useExchange = (code: string) => {
  return useQuery({
    queryKey: ['admin', 'exchanges', code],
    queryFn: () => exchangeService.getByCode(code),
    enabled: !!code,
  });
};

export const useExchangeMutations = () => {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: CreateExchangeRequest) => exchangeService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'exchanges'] });
      toast.success('Exchange created');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to create exchange');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ code, data }: { code: string; data: Partial<CreateExchangeRequest> }) =>
      exchangeService.update(code, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'exchanges'] });
      toast.success('Exchange updated');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update exchange');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (code: string) => exchangeService.delete(code),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'exchanges'] });
      toast.success('Exchange deleted');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to delete exchange');
    },
  });

  return {
    createExchange: createMutation.mutate,
    isCreating: createMutation.isPending,
    updateExchange: updateMutation.mutate,
    isUpdating: updateMutation.isPending,
    deleteExchange: deleteMutation.mutate,
    isDeleting: deleteMutation.isPending,
  };
};

// ==================== HOLIDAYS ====================

export const useHolidays = (exchange: string) => {
  return useQuery({
    queryKey: ['admin', 'holidays', exchange],
    queryFn: () => holidayService.getByExchange(exchange),
    enabled: !!exchange,
  });
};

export const useHolidayMutations = () => {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: CreateHolidayRequest) => holidayService.create(data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'holidays', variables.exchange] });
      toast.success('Holiday added');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to add holiday');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ exchange, date }: { exchange: string; date: string }) =>
      holidayService.delete(exchange, date),
    onSuccess: (_, { exchange }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'holidays', exchange] });
      toast.success('Holiday removed');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to remove holiday');
    },
  });

  return {
    addHoliday: createMutation.mutate,
    isAdding: createMutation.isPending,
    removeHoliday: deleteMutation.mutate,
    isRemoving: deleteMutation.isPending,
  };
};

// ==================== EVENT DAYS ====================

export const useEventDays = (exchange: string) => {
  return useQuery({
    queryKey: ['admin', 'eventDays', exchange],
    queryFn: () => eventDayService.getByExchange(exchange),
    enabled: !!exchange,
  });
};

export const useEventDayMutations = () => {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: ({ exchange, eventDate }: { exchange: string; eventDate: string }) =>
      eventDayService.delete(exchange, eventDate),
    onSuccess: (_, { exchange }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'eventDays', exchange] });
      toast.success('Event day removed');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to remove event day');
    },
  });

  return {
    removeEventDay: deleteMutation.mutate,
    isRemoving: deleteMutation.isPending,
  };
};

// ==================== BROKER EXCHANGE CONFIGS ====================

export const useBrokerExchangeConfigs = (broker?: string) => {
  return useQuery({
    queryKey: ['admin', 'brokerExchangeConfigs', broker],
    queryFn: () => broker
      ? brokerExchangeConfigService.getByBroker(broker)
      : brokerExchangeConfigService.getAll(),
    staleTime: 10 * 60 * 1000,
  });
};

export const useBrokerExchangeConfigMutations = () => {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: CreateBrokerExchangeConfigRequest) =>
      brokerExchangeConfigService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'brokerExchangeConfigs'] });
      toast.success('Broker exchange config created');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to create config');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      broker,
      exchange,
      data,
    }: {
      broker: string;
      exchange: string;
      data: Partial<CreateBrokerExchangeConfigRequest>;
    }) => brokerExchangeConfigService.update(broker, exchange, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'brokerExchangeConfigs'] });
      toast.success('Broker exchange config updated');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update config');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ broker, exchange }: { broker: string; exchange: string }) =>
      brokerExchangeConfigService.delete(broker, exchange),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'brokerExchangeConfigs'] });
      toast.success('Broker exchange config deleted');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to delete config');
    },
  });

  return {
    createConfig: createMutation.mutate,
    isCreating: createMutation.isPending,
    updateConfig: updateMutation.mutate,
    isUpdating: updateMutation.isPending,
    deleteConfig: deleteMutation.mutate,
    isDeleting: deleteMutation.isPending,
  };
};

// ==================== ALLOCATION MODELS ====================

export const useAllocationModels = () => {
  return useQuery({
    queryKey: ['admin', 'allocationModels'],
    queryFn: () => allocationModelService.getAll(),
    staleTime: 10 * 60 * 1000,
  });
};

export const useAllocationModel = (name: string) => {
  return useQuery({
    queryKey: ['admin', 'allocationModels', name],
    queryFn: () => allocationModelService.getByName(name),
    enabled: !!name,
  });
};

export const useAllocationModelStrategies = (name: string) => {
  return useQuery({
    queryKey: ['admin', 'allocationModels', name, 'strategies'],
    queryFn: () => allocationModelService.getStrategies(name),
    enabled: !!name,
  });
};

export const useAllocationModelMutations = () => {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: CreateAllocationModelRequest) => allocationModelService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModels'] });
      toast.success('Allocation model created');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to create allocation model');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, data }: { name: string; data: Partial<CreateAllocationModelRequest> }) =>
      allocationModelService.update(name, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModels'] });
      toast.success('Allocation model updated');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update allocation model');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => allocationModelService.delete(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModels'] });
      toast.success('Allocation model deleted');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to delete allocation model');
    },
  });

  const addStrategyMutation = useMutation({
    mutationFn: ({ name, data }: { name: string; data: Omit<AllocationModelStrategy, 'allocationModel'> }) =>
      allocationModelService.addStrategy(name, data),
    onSuccess: (_, { name }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModels', name, 'strategies'] });
      toast.success('Strategy added to model');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to add strategy');
    },
  });

  const removeStrategyMutation = useMutation({
    mutationFn: ({ name, strategy }: { name: string; strategy: string }) =>
      allocationModelService.removeStrategy(name, strategy),
    onSuccess: (_, { name }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModels', name, 'strategies'] });
      toast.success('Strategy removed from model');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to remove strategy');
    },
  });

  return {
    createModel: createMutation.mutate,
    isCreating: createMutation.isPending,
    updateModel: updateMutation.mutate,
    isUpdating: updateMutation.isPending,
    deleteModel: deleteMutation.mutate,
    isDeleting: deleteMutation.isPending,
    addStrategy: addStrategyMutation.mutate,
    isAddingStrategy: addStrategyMutation.isPending,
    removeStrategy: removeStrategyMutation.mutate,
    isRemovingStrategy: removeStrategyMutation.isPending,
  };
};

// ==================== FAQs ====================

export const useFaqs = (category?: string) => {
  return useQuery({
    queryKey: ['admin', 'faqs', category],
    queryFn: () => faqService.getAll(category),
    staleTime: 10 * 60 * 1000,
  });
};

export const useFaqMutations = () => {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: CreateFAQRequest) => faqService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'faqs'] });
      toast.success('FAQ created');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to create FAQ');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: CreateFAQRequest }) =>
      faqService.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'faqs'] });
      toast.success('FAQ updated');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update FAQ');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => faqService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'faqs'] });
      toast.success('FAQ deleted');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to delete FAQ');
    },
  });

  return {
    createFaq: createMutation.mutate,
    isCreating: createMutation.isPending,
    updateFaq: updateMutation.mutate,
    isUpdating: updateMutation.isPending,
    deleteFaq: deleteMutation.mutate,
    isDeleting: deleteMutation.isPending,
  };
};

// ==================== AUDIT LOGS ====================

export const useAuditLogs = (filter?: AuditLogFilter) => {
  return useQuery({
    queryKey: ['admin', 'auditLogs', filter],
    queryFn: () => auditLogService.getLogs(filter),
  });
};

export const useAuditLogsByEntity = (entityType: string, entityId: string) => {
  return useQuery({
    queryKey: ['admin', 'auditLogs', 'entity', entityType, entityId],
    queryFn: () => auditLogService.getLogsByEntity(entityType, entityId),
    enabled: !!entityType && !!entityId,
  });
};

export const useAuditLogsByUser = (username: string) => {
  return useQuery({
    queryKey: ['admin', 'auditLogs', 'user', username],
    queryFn: () => auditLogService.getLogsByUser(username),
    enabled: !!username,
  });
};
