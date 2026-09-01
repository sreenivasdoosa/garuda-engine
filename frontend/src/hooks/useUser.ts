import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { userService } from '@/services/user/userService';
import type { ChangePasswordRequest, UpdateProfileRequest } from '@/types/user';

export const useUser = () => {
  const queryClient = useQueryClient();

  const userQuery = useQuery({
    queryKey: ['user', 'details'],
    queryFn: userService.getDetails,
    staleTime: 5 * 60 * 1000,
  });

  const updateProfileMutation = useMutation({
    mutationFn: (data: UpdateProfileRequest) => userService.updateProfile(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user', 'details'] });
      toast.success('Profile updated successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to update profile');
    },
  });

  const changePasswordMutation = useMutation({
    mutationFn: (data: ChangePasswordRequest) => userService.changePassword(data),
    onSuccess: () => {
      toast.success('Password changed successfully');
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Failed to change password');
    },
  });

  return {
    user: userQuery.data,
    isLoading: userQuery.isLoading,
    error: userQuery.error,
    refetch: userQuery.refetch,
    updateProfile: updateProfileMutation.mutate,
    isUpdatingProfile: updateProfileMutation.isPending,
    changePassword: changePasswordMutation.mutate,
    isChangingPassword: changePasswordMutation.isPending,
  };
};

export const useUserAlerts = () => {
  return useQuery({
    queryKey: ['user', 'alerts'],
    queryFn: userService.getAlerts,
    refetchInterval: 30000, // Refetch every 30 seconds
  });
};

export const useUserPayments = () => {
  return useQuery({
    queryKey: ['user', 'payments'],
    queryFn: userService.getPayments,
  });
};

export const useUserPlans = () => {
  return useQuery({
    queryKey: ['user', 'plans'],
    queryFn: userService.getPlans,
  });
};
