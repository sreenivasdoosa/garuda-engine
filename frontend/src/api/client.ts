import axios, { AxiosInstance, AxiosError, AxiosRequestConfig, InternalAxiosRequestConfig, AxiosResponse } from 'axios';
import { getBaseUrl } from '@/config/env';
import { trimStringsDeep } from '@/utils/inputTrim';

// Create axios instance
const apiClient: AxiosInstance = axios.create({
  baseURL: getBaseUrl(),
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // Important for cookie-based authentication
});

// Flag to prevent multiple refresh attempts
let isRefreshing = false;
// Queue of requests waiting for token refresh
let refreshSubscribers: ((token: string) => void)[] = [];
// Flag to prevent multiple redirects
let isRedirecting = false;

// Subscribe to token refresh
const subscribeTokenRefresh = (callback: (token: string) => void) => {
  refreshSubscribers.push(callback);
};

// Notify all subscribers with new token
const onTokenRefreshed = (token: string) => {
  refreshSubscribers.forEach((callback) => callback(token));
  refreshSubscribers = [];
};

// Reject all pending subscribers
const onRefreshFailed = (_error: unknown) => {
  refreshSubscribers = [];
};

// Clear tokens and redirect to login (only once)
const clearTokensAndRedirect = () => {
  if (isRedirecting) return; // prevent multiple simultaneous redirects
  isRedirecting = true;
  console.log('[API] Clearing tokens and redirecting to login');
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('auth-storage'); // Clear Zustand persisted auth state
  sessionStorage.removeItem('oauth_state');
  if (!window.location.pathname.includes('/login') && !window.location.pathname.includes('/oauth/callback')) {
    window.location.href = '/login';
  }
};

// Attempt to refresh the access token
const refreshAccessToken = async (): Promise<string | null> => {
  const refreshToken = localStorage.getItem('refresh_token');
  if (!refreshToken) {
    return null;
  }

  try {
    console.log('[API] Attempting token refresh...');
    // Use axios directly to avoid interceptor loop
    const response = await axios.post(
      `${getBaseUrl()}/api/v2/auth/refresh`,
      { refresh_token: refreshToken },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const data = response.data?.data || response.data;
    if (data?.access_token) {
      console.log('[API] Token refresh successful');
      localStorage.setItem('access_token', data.access_token);
      if (data.refresh_token) {
        localStorage.setItem('refresh_token', data.refresh_token);
      }
      return data.access_token;
    }
    console.log('[API] Token refresh response missing access_token');
    return null;
  } catch (error) {
    console.error('[API] Token refresh failed:', error);
    return null;
  }
};

// Request interceptor
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // Add JWT Bearer token if available
    const token = localStorage.getItem('access_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    // Trim leading/trailing whitespace from every string in the request body so
    // values reach the server clean regardless of what the user typed (e.g.
    // "  Hit Me  " -> "Hit Me"). Only plain objects/arrays are walked; FormData,
    // Blob and other bodies are left untouched by trimStringsDeep.
    if (config.data && typeof config.data === 'object') {
      config.data = trimStringsDeep(config.data);
    }

    // Log requests in development
    if (import.meta.env.DEV) {
      console.log(`[API] ${config.method?.toUpperCase()} ${config.url}`);
    }

    return config;
  },
  (error: AxiosError) => {
    console.error('[API] Request error:', error);
    return Promise.reject(error);
  }
);

// Response interceptor
apiClient.interceptors.response.use(
  (response: AxiosResponse) => {
    const data = response.data;
    // Handle V2 API response format: { success, data, message, count, timestamp }
    // Check if response has the V2 API wrapper structure
    if (data && typeof data === 'object' && 'success' in data && 'data' in data) {
      // V2 API response - extract the actual data
      if (data.success) {
        return data.data;
      } else {
        // V2 API returned an error
        return Promise.reject({
          status: response.status,
          message: data.error?.message || data.message || 'Request failed',
          data: data.error,
        });
      }
    }

    // V1 API or non-wrapped response - return as-is
    return data;
  },
  async (error: AxiosError) => {
    const status = error.response?.status;
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // V2 API error response format: { success, error: { code, message, details, path, timestamp }, ... }
    const data = error.response?.data as {
      error?: { message?: string; code?: number } | string;
      message?: string;
    } | undefined;

    // Handle 401 Unauthorized
    if (status === 401 && !originalRequest._retry) {
      // Skip refresh for auth login/token/refresh endpoints to avoid loops
      const reqUrl = originalRequest.url || '';
      if (reqUrl.includes('/auth/login') || reqUrl.includes('/auth/token') ||
          reqUrl.includes('/auth/refresh') || reqUrl.includes('/auth/local/login')) {
        return Promise.reject(error);
      }

      // Broker edition: no refresh token available — don't hard-redirect.
      // Just reject the error so checkAuthStatus() can handle auth state gracefully.
      const hasRefreshToken = !!localStorage.getItem('refresh_token');
      if (!hasRefreshToken) {
        return Promise.reject({
          status,
          message: 'Unauthorized',
          data,
        });
      }

      // Enterprise edition: has refresh token — attempt refresh
      if (isRefreshing) {
        // Wait for ongoing refresh to complete
        return new Promise((resolve, _reject) => {
          subscribeTokenRefresh((token: string) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            resolve(apiClient(originalRequest));
          });
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const newToken = await refreshAccessToken();
        if (newToken) {
          // Refresh successful - retry original request and notify subscribers
          onTokenRefreshed(newToken);
          isRefreshing = false;
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return apiClient(originalRequest);
        } else {
          // Refresh failed - clear tokens and redirect
          isRefreshing = false;
          onRefreshFailed(error);
          clearTokensAndRedirect();
          return Promise.reject(error);
        }
      } catch (refreshError) {
        isRefreshing = false;
        onRefreshFailed(refreshError);
        clearTokensAndRedirect();
        return Promise.reject(refreshError);
      }
    }

    if (status === 403) {
      console.error('[API] Access denied');
    }

    if (status === 404) {
      console.error('[API] Resource not found');
    }

    if (status === 500) {
      console.error('[API] Server error');
    }

    // Extract error message - handle V2 API nested error object
    let errorMessage = 'An error occurred';
    if (data?.error) {
      if (typeof data.error === 'string') {
        errorMessage = data.error;
      } else if (data.error.message) {
        errorMessage = data.error.message;
      }
    } else if (data?.message) {
      errorMessage = data.message;
    } else if (error.message) {
      errorMessage = error.message;
    }

    return Promise.reject({
      status,
      message: errorMessage,
      data,
    });
  }
);

export default apiClient;

// Type-safe request helpers
export const api = {
  get: <T>(url: string, params?: Record<string, unknown>, config?: AxiosRequestConfig): Promise<T> =>
    apiClient.get(url, { params, ...config }),

  post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> =>
    apiClient.post(url, data, config),

  put: <T>(url: string, data?: unknown): Promise<T> =>
    apiClient.put(url, data),

  patch: <T>(url: string, data?: unknown): Promise<T> =>
    apiClient.patch(url, data),

  delete: <T>(url: string, data?: unknown): Promise<T> =>
    apiClient.delete(url, { data }),
};
