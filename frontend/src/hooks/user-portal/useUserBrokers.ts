/**
 * User Brokers Hook
 * React Query hooks for user's broker operations
 * Services use JWT token for authentication - no username parameter needed
 */

import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { useAuthStore } from '@/store/authStore';
import { userBrokerService } from '@/services/user-portal';
import type { AddBrokerRequest, UpdateBrokerRequest } from '@/types/user-portal';

/**
 * Hook to get user's brokers
 * Note: loginVerified = true means first-time OAuth authorization is done (auto-login available)
 * Actual login status should be fetched separately using useBrokerLoginStatus or useAllBrokerLoginStatuses
 */
export const useUserBrokers = () => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'brokers', username],
    queryFn: () => userBrokerService.getBrokers(),
    enabled: !!username,
    staleTime: 60000, // 1 minute
  });
};

/**
 * Hook to get login status for all user's brokers
 * Returns a map of broker -> isLoggedIn status
 */
export const useAllBrokerLoginStatuses = (brokers: string[]) => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'broker-login-statuses', username, brokers],
    queryFn: async () => {
      const statuses: Record<string, boolean> = {};
      await Promise.all(
        brokers.map(async (broker) => {
          try {
            const status = await userBrokerService.getLoginStatus(broker);
            statuses[broker] = status.isLoggedIn;
          } catch {
            statuses[broker] = false;
          }
        })
      );
      return statuses;
    },
    enabled: !!username && brokers.length > 0,
    staleTime: 30000, // 30 seconds
    refetchInterval: 60000, // Refresh every minute
  });
};

/**
 * Hook to get broker funds for all user's brokers
 */
export const useUserBrokerFunds = () => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'broker-funds', username],
    queryFn: () => userBrokerService.getAllFunds(),
    enabled: !!username,
    staleTime: 60000,
    refetchInterval: 60000,
  });
};

/**
 * Hook to get funds for a specific broker
 */
export const useBrokerFunds = (broker: string) => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'broker-funds', username, broker],
    queryFn: () => userBrokerService.getFunds(broker),
    enabled: !!username && !!broker,
    staleTime: 60000,
  });
};

/**
 * Hook to get login status for a specific broker
 */
export const useBrokerLoginStatus = (broker: string) => {
  const { user } = useAuthStore();
  const username = user?.username || '';

  return useQuery({
    queryKey: ['user-portal', 'broker-login-status', username, broker],
    queryFn: () => userBrokerService.getLoginStatus(broker),
    enabled: !!username && !!broker,
    staleTime: 30000, // 30 seconds
    refetchInterval: 60000, // Refresh every minute
  });
};

/**
 * Hook for broker mutations (add, update, remove, login)
 */
export const useUserBrokerMutations = () => {
  const queryClient = useQueryClient();

  // Tracks the broker-login OAuth popup window so we can:
  //  1. detect manual close (user cancels) via polling popup.closed
  //  2. correlate postMessage events from the popup back to this hook instance
  const popupRef = useRef<Window | null>(null);
  const popupPollRef = useRef<number | null>(null);
  const messageHandledRef = useRef<boolean>(false);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as
        | { type?: string; status?: string; broker?: string; message?: string }
        | null;
      if (!data || data.type !== 'broker-login') return;
      // Only the hook instance that opened the popup handles the message
      if (!popupRef.current) return;

      messageHandledRef.current = true;
      if (popupPollRef.current !== null) {
        window.clearInterval(popupPollRef.current);
        popupPollRef.current = null;
      }

      const broker = data.broker || '';
      const status = data.status || 'error';
      const message = data.message || '';

      if (status === 'success') {
        toast.success(broker ? `Logged in to ${broker}` : 'Logged in');
        queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-login-status'] });
        queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-login-statuses'] });
        queryClient.invalidateQueries({ queryKey: ['user-portal', 'brokers'] });
        queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-funds'] });
      } else if (status === 'already') {
        toast.info(broker ? `Already logged in to ${broker}` : 'Already logged in');
        queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-login-status'] });
        queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-login-statuses'] });
      } else if (status === 'auth-required') {
        toast.error('Session expired. Please log in again.');
      } else {
        toast.error(message ? `${broker} login failed: ${message}` : 'Broker login failed');
      }

      popupRef.current = null;
    };

    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
      if (popupPollRef.current !== null) {
        window.clearInterval(popupPollRef.current);
        popupPollRef.current = null;
      }
    };
  }, [queryClient]);

  const addBrokerMutation = useMutation({
    mutationFn: (data: AddBrokerRequest) => userBrokerService.addBroker(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'brokers'] });
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-funds'] });
      toast.success('Broker added successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to add broker');
    },
  });

  const updateBrokerMutation = useMutation({
    mutationFn: ({ broker, data }: { broker: string; data: UpdateBrokerRequest }) =>
      userBrokerService.updateBroker(broker, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'brokers'] });
      toast.success('Broker updated successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update broker');
    },
  });

  const removeBrokerMutation = useMutation({
    mutationFn: (broker: string) => userBrokerService.removeBroker(broker),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'brokers'] });
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-funds'] });
      toast.success('Broker removed successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to remove broker');
    },
  });

  const autoLoginMutation = useMutation({
    mutationFn: (broker: string) => userBrokerService.autoLogin(broker),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'brokers'] });
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-login-status'] });
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-login-statuses'] });
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-funds'] });
      toast.success(response.message || 'Login triggered successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Auto-login failed');
    },
  });

  const manualLoginMutation = useMutation({
    mutationFn: (broker: string) => userBrokerService.getManualLoginUrl(broker),
    onSuccess: (response) => {
      if (response.status === 'redirect_required' && response.loginUrl) {
        const width = 500;
        const height = 700;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;
        const features = `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,status=yes`;
        const popup = window.open(response.loginUrl, 'broker-login', features);

        if (!popup) {
          toast.error('Popup blocked. Please allow popups for this site.');
          return;
        }

        popupRef.current = popup;
        messageHandledRef.current = false;
        if (popupPollRef.current !== null) {
          window.clearInterval(popupPollRef.current);
        }
        // Poll for manual close — if no message arrived, user cancelled.
        popupPollRef.current = window.setInterval(() => {
          if (popup.closed) {
            if (popupPollRef.current !== null) {
              window.clearInterval(popupPollRef.current);
              popupPollRef.current = null;
            }
            if (!messageHandledRef.current) {
              toast.info('Broker login cancelled');
            }
            popupRef.current = null;
          }
        }, 500);
      } else if (
        response.status === 'already_logged_in' ||
        response.status === 'login_successful'
      ) {
        toast.success(response.message || 'Login successful');
        queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-login-status'] });
        queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-login-statuses'] });
        queryClient.invalidateQueries({ queryKey: ['user-portal', 'brokers'] });
      } else {
        toast.error('Could not get login URL');
      }
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to get login URL');
    },
  });

  const logoutMutation = useMutation({
    mutationFn: (broker: string) => userBrokerService.logout(broker),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'brokers'] });
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-login-status'] });
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-login-statuses'] });
      queryClient.invalidateQueries({ queryKey: ['user-portal', 'broker-funds'] });
      toast.success('Logged out successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Logout failed');
    },
  });

  return {
    addBroker: addBrokerMutation.mutate,
    isAddingBroker: addBrokerMutation.isPending,

    updateBroker: updateBrokerMutation.mutate,
    isUpdatingBroker: updateBrokerMutation.isPending,

    removeBroker: removeBrokerMutation.mutate,
    isRemovingBroker: removeBrokerMutation.isPending,

    autoLogin: autoLoginMutation.mutate,
    isAutoLoggingIn: autoLoginMutation.isPending,

    manualLogin: manualLoginMutation.mutate,
    isGettingLoginUrl: manualLoginMutation.isPending,

    logout: logoutMutation.mutate,
    isLoggingOut: logoutMutation.isPending,
  };
};
