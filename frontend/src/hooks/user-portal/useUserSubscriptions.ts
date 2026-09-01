/**
 * User Subscriptions Hook
 * React Query hooks for user's strategy subscriptions
 * Uses /api/v2/me/* endpoints (no username needed - extracted from JWT)
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { useAuthStore } from '@/store/authStore';
import { userSubscriptionService } from '@/services/user-portal';
import type { CreateUserSubscriptionRequest, UpdateUserSubscriptionRequest } from '@/types/strategy-engine';

/**
 * Hook to get user's subscriptions
 */
export const useUserSubscriptions = () => {
  const { user } = useAuthStore();

  return useQuery({
    queryKey: ['user-portal', 'subscriptions'],
    queryFn: () => userSubscriptionService.getSubscriptions(),
    enabled: !!user,
    staleTime: 60000,
  });
};

/**
 * Hook to get strategies visible to the user (own + public + already-subscribed SYSTEM).
 * Includes SYSTEM-scope strategies for display/scope lookup.
 */
export const useAvailableStrategies = () => {
  const { user } = useAuthStore();

  return useQuery({
    queryKey: ['user-portal', 'available-strategies'],
    queryFn: () => userSubscriptionService.getAvailableStrategies(),
    enabled: !!user,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

/**
 * Hook to get strategies the user can self-subscribe to (ACTIVE, USER-scope, own or public).
 * Excludes SYSTEM-scope strategies. Use for the "add subscription" picker.
 */
export const useSubscribableStrategies = () => {
  const { user } = useAuthStore();

  return useQuery({
    queryKey: ['user-portal', 'subscribable-strategies'],
    queryFn: () => userSubscriptionService.getSubscribableStrategies(),
    enabled: !!user,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

/**
 * Hook for subscription mutations
 */
export const useUserSubscriptionMutations = () => {
  const queryClient = useQueryClient();

  const createSubscriptionMutation = useMutation({
    mutationFn: (data: Omit<CreateUserSubscriptionRequest, 'username'>) =>
      userSubscriptionService.createSubscription(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'subscriptions'] });
      toast.success('Subscription created successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to create subscription');
    },
  });

  const updateSubscriptionMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateUserSubscriptionRequest }) =>
      userSubscriptionService.updateSubscription(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'subscriptions'] });
      toast.success('Subscription updated successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update subscription');
    },
  });

  const deleteSubscriptionMutation = useMutation({
    mutationFn: (id: number) => userSubscriptionService.deleteSubscription(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'subscriptions'] });
      toast.success('Subscription removed successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to remove subscription');
    },
  });

  const activateSubscriptionMutation = useMutation({
    mutationFn: (id: number) => userSubscriptionService.activateSubscription(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'subscriptions'] });
      toast.success('Subscription activated');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to activate subscription');
    },
  });

  const deactivateSubscriptionMutation = useMutation({
    mutationFn: (id: number) => userSubscriptionService.deactivateSubscription(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'subscriptions'] });
      toast.success('Subscription deactivated');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to deactivate subscription');
    },
  });

  return {
    createSubscription: createSubscriptionMutation.mutate,
    isCreatingSubscription: createSubscriptionMutation.isPending,

    updateSubscription: updateSubscriptionMutation.mutate,
    isUpdatingSubscription: updateSubscriptionMutation.isPending,

    deleteSubscription: deleteSubscriptionMutation.mutate,
    isDeletingSubscription: deleteSubscriptionMutation.isPending,

    activateSubscription: activateSubscriptionMutation.mutate,
    isActivatingSubscription: activateSubscriptionMutation.isPending,

    deactivateSubscription: deactivateSubscriptionMutation.mutate,
    isDeactivatingSubscription: deactivateSubscriptionMutation.isPending,
  };
};
