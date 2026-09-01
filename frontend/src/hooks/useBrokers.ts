import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { v2BrokerService } from '@/services/admin/v2AdminService';
import { brokerService } from '@/services/broker/brokerService';
import type { BrokerCredentials, CreateBrokerRequest, UpdateBrokerRequest } from '@/types/broker';

export const useBrokers = () => {
  return useQuery({
    queryKey: ['brokers'],
    queryFn: () => v2BrokerService.getAll(),
    staleTime: 10 * 60 * 1000, // 10 minutes
  });
};

export const useBrokerLoginRules = (broker: string) => {
  return useQuery({
    queryKey: ['broker', 'loginRules', broker],
    queryFn: () => brokerService.getLoginRules(broker),
    enabled: !!broker,
  });
};

export const useBrokerLoginStatus = (broker?: string) => {
  return useQuery({
    queryKey: ['broker', 'loginStatus', broker],
    queryFn: () => brokerService.getLoginStatus(broker),
    refetchInterval: 60000, // Refresh every minute
  });
};

export const useBrokerFunds = (broker?: string) => {
  return useQuery({
    queryKey: ['broker', 'funds', broker],
    queryFn: () => brokerService.getFunds(broker),
    refetchInterval: 60000,
  });
};

export const useBrokerMutations = () => {
  const queryClient = useQueryClient();

  const addCredentialsMutation = useMutation({
    mutationFn: (data: BrokerCredentials) => brokerService.addCredentials(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['broker'] });
      queryClient.invalidateQueries({ queryKey: ['user', 'details'] });
      toast.success('Broker added successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to add broker');
    },
  });

  const updateCredentialsMutation = useMutation({
    mutationFn: (data: BrokerCredentials) => brokerService.updateCredentials(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['broker'] });
      toast.success('Broker updated successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update broker');
    },
  });

  const removeCredentialsMutation = useMutation({
    mutationFn: (broker: string) => brokerService.removeCredentials(broker),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['broker'] });
      queryClient.invalidateQueries({ queryKey: ['user', 'details'] });
      toast.success('Broker removed successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to remove broker');
    },
  });

  const triggerLoginMutation = useMutation({
    mutationFn: (broker: string) => brokerService.triggerLogin(broker),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['broker', 'loginStatus'] });
      toast.success(response.message || 'Login triggered');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to trigger login');
    },
  });

  return {
    addCredentials: addCredentialsMutation.mutate,
    isAddingCredentials: addCredentialsMutation.isPending,
    updateCredentials: updateCredentialsMutation.mutate,
    isUpdatingCredentials: updateCredentialsMutation.isPending,
    removeCredentials: removeCredentialsMutation.mutate,
    isRemovingCredentials: removeCredentialsMutation.isPending,
    triggerLogin: triggerLoginMutation.mutate,
    isTriggeringLogin: triggerLoginMutation.isPending,
  };
};

// Admin broker mutations (V2 API)
export const useAdminBrokerMutations = () => {
  const queryClient = useQueryClient();

  const createBrokerMutation = useMutation({
    mutationFn: (data: CreateBrokerRequest) => v2BrokerService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      toast.success('Broker created successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to create broker');
    },
  });

  const updateBrokerMutation = useMutation({
    mutationFn: ({ name, data }: { name: string; data: UpdateBrokerRequest }) =>
      v2BrokerService.update(name, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      toast.success('Broker updated successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update broker');
    },
  });

  const deleteBrokerMutation = useMutation({
    mutationFn: (name: string) => v2BrokerService.delete(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      toast.success('Broker deleted successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to delete broker');
    },
  });

  const stopBrokerMutation = useMutation({
    mutationFn: (name: string) => v2BrokerService.stop(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      toast.success('Broker stopped successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to stop broker');
    },
  });

  const unstopBrokerMutation = useMutation({
    mutationFn: (name: string) => v2BrokerService.unstop(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      toast.success('Broker unstopped successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to unstop broker');
    },
  });

  return {
    createBroker: createBrokerMutation.mutate,
    isCreatingBroker: createBrokerMutation.isPending,
    updateBroker: updateBrokerMutation.mutate,
    isUpdatingBroker: updateBrokerMutation.isPending,
    deleteBroker: deleteBrokerMutation.mutate,
    isDeletingBroker: deleteBrokerMutation.isPending,
    stopBroker: stopBrokerMutation.mutate,
    isStoppingBroker: stopBrokerMutation.isPending,
    unstopBroker: unstopBrokerMutation.mutate,
    isUnstoppingBroker: unstopBrokerMutation.isPending,
  };
};
