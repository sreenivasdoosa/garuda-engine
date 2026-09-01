import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { useAuthStore } from '@/store/authStore';
import { useConfigStore } from '@/store/configStore';
import { authService, createUserFromLocalLogin, type LocalLoginResponse } from '@/services/auth/authService';
import { setAccessTokenCookie, clearAccessTokenCookie } from '@/services/auth/cookieService';
import { decodeJwt, isTokenExpired } from '@/utils/jwt';
import { configService } from '@/services/config/configService';
import type { User } from '@/types/user';

/**
 * Signing in.
 *
 * One local admin with a username and a password. The engine this was copied
 * from also spoke OAuth to a central auth service and could sign a user out
 * of every app at once; garuda is self-hosted and answers to nobody, so that
 * is gone rather than disabled.
 */
export const useAuth = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setUser, setLoading, logout: clearAuth } = useAuthStore();
  const { setServerConfig, setSupportedBrokers } = useConfigStore();

  /** Where signing in lands. One operator, one place. */
  const getRedirectPath = (_user: User): string => '/console';

  // Check authentication status using JWT
  const checkAuthStatus = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch server config (public endpoint, no auth required)
      try {
        const serverConfig = await configService.getServerConfig();
        setServerConfig(serverConfig);
        setSupportedBrokers(serverConfig.supportedBrokers);
      } catch (configErr) {
        console.warn('Server config fetch failed (non-fatal):', configErr);
      }

      // Check JWT-based auth status
      const authStatus = await authService.checkJwtStatus();
      if (authStatus.isAuthenticated && authStatus.user) {
        setUser(authStatus.user);
        // Set WebSocket auth cookie if token exists
        const token = localStorage.getItem('access_token');
        if (token) {
          setAccessTokenCookie(token, 900); // 15 minutes default
        }
      } else {
        setUser(null);
        clearAccessTokenCookie();
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      // Only clear auth if there's no valid token in localStorage.
      // This prevents wiping a valid session due to transient API failures.
      const token = localStorage.getItem('access_token');
      const decoded = token ? decodeJwt(token) : null;
      if (!decoded || isTokenExpired(decoded)) {
        setUser(null);
        clearAccessTokenCookie();
      } else {
        // Token is locally valid — keep the persisted user session alive
        console.warn('Keeping existing session despite auth check failure (token still valid)');
      }
    } finally {
      setLoading(false);
    }
  }, [setUser, setLoading, setServerConfig, setSupportedBrokers]);

  /** Clear the session and go back to the login page. */
  const signOut = useCallback(() => {
    authService.clearTokens();
    clearAccessTokenCookie(); // Clear WebSocket auth cookie
    clearAuth();
    queryClient.clear();
    toast.success('Logged out successfully');
    navigate('/login', { replace: true });
  }, [clearAuth, queryClient, navigate]);


  /** Username and password, against this engine's own admin identity. */
  const localLoginMutation = useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) => {
      return authService.localLogin(username, password);
    },
    onSuccess: (response: LocalLoginResponse) => {
      localStorage.setItem('access_token', response.accessToken);
      setAccessTokenCookie(response.accessToken, 86400); // 24 hours
      const user = createUserFromLocalLogin(response);
      setUser(user);
      toast.success('Login successful!');
      navigate(getRedirectPath(user), { replace: true });
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || 'Login failed');
    },
  });

  return {
    checkAuthStatus,
    getRedirectPath,
    logout: signOut,
    handleLocalLogin: localLoginMutation.mutate,
    isLocalLoginLoading: localLoginMutation.isPending,
  };
};
