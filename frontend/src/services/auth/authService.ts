import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { User } from '@/types/user';
import { decodeJwt, isTokenExpired, type JwtPayload } from '@/utils/jwt';

export interface AuthStatus {
  isAuthenticated: boolean;
  user?: User;
}

// Local auth login response (Standalone mode)
export interface LocalLoginResponse {
  accessToken: string;
  tokenType: string;
  username: string;
  fullName: string;
  email: string;
  role: string;
}

// OAuth token response from backend
export interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user?: {
    userId: number;
    username: string;
    email: string;
    fullName: string;
    role: string;
    roleCode?: string;
    rights: Record<string, string>;
  };
}

// Local profile response from Standalone mode backend (camelCase)
export interface LocalProfileResponse {
  username: string;
  email: string;
  fullName: string;
  phone: string;
  role: string;
  isActive: boolean;
  isEmailVerified: boolean;
  lastLoginAt: number | null;
  createdAt: number;
}

// User info response from auth service (snake_case from backend)
export interface UserInfoResponse {
  sub: number;
  username: string;
  email: string;
  full_name?: string;
  phone?: string;
  role_code?: string;
  role_name?: string;
  rights?: Record<string, string>;
  is_sysadmin?: boolean;
  app_id?: string;
  sso_sid?: string;
  role_hierarchy_level?: number;
  can_manage_rights?: boolean;
  can_manage_users?: boolean;
  created_at?: string;
  last_login_at?: string;
}

/**
 * Create a User object from OAuth user response
 */
export function createUserFromOAuth(oauthUser: NonNullable<OAuthTokenResponse['user']>): User {
  const roleCode = oauthUser.roleCode || oauthUser.role || '';
  return {
    id: String(oauthUser.userId),
    username: oauthUser.username,
    email: oauthUser.email,
    name: oauthUser.fullName || oauthUser.username,
    role: roleCode,
    roleCode: roleCode,
    brokers: [],
    isActive: true,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create a User object from user info response
 */
export function createUserFromUserInfo(userInfo: UserInfoResponse): User {
  const roleCode = userInfo.role_code || userInfo.role_name || '';
  return {
    id: String(userInfo.sub),
    username: userInfo.username,
    email: userInfo.email,
    name: userInfo.full_name || userInfo.username,
    phone: userInfo.phone,
    role: roleCode,
    roleCode: roleCode,
    brokers: [],
    isActive: true,
    createdAt: userInfo.created_at,
    lastLogin: userInfo.last_login_at,
  };
}

/**
 * Create a User object from decoded JWT payload
 */
function createUserFromJwt(decoded: JwtPayload): User {
  const roleCode = decoded.role_code || '';
  return {
    id: decoded.sub,
    username: decoded.username,
    email: decoded.email,
    name: decoded.full_name || decoded.username,
    role: roleCode,
    roleCode: roleCode,
    brokers: [],
    isActive: true,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create a User object from local login response (Standalone mode)
 */
export function createUserFromLocalLogin(response: LocalLoginResponse): User {
  return {
    id: response.username,
    username: response.username,
    email: response.email,
    name: response.fullName || response.username,
    role: response.role,
    roleCode: response.role,
    brokers: [],
    isActive: true,
    createdAt: new Date().toISOString(),
  };
}

export const authService = {
  // ==================== OAuth / SSO Methods ====================

  /**
   * Exchange authorization code for tokens via backend proxy
   */
  async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokenResponse> {
    return api.post<OAuthTokenResponse>(API_ENDPOINTS.AUTH.TOKEN, {
      code,
      redirect_uri: redirectUri,
    });
  },

  /**
   * Refresh access token using refresh token via backend proxy
   */
  async refreshToken(refreshToken: string): Promise<OAuthTokenResponse> {
    return api.post<OAuthTokenResponse>(API_ENDPOINTS.AUTH.REFRESH, {
      refresh_token: refreshToken,
    });
  },

  /**
   * Get user info from auth service via backend proxy
   * Returns user info with is_sysadmin, roles, rights, etc.
   */
  async getUserInfo(): Promise<UserInfoResponse> {
    return api.get<UserInfoResponse>(API_ENDPOINTS.AUTH.USERINFO);
  },

  /**
   * Check JWT-based authentication status
   */
  async checkJwtStatus(): Promise<AuthStatus> {
    const token = localStorage.getItem('access_token');
    if (!token) {
      return { isAuthenticated: false };
    }

    const decoded = decodeJwt(token);
    if (!decoded || isTokenExpired(decoded)) {
      // Try to refresh the token
      const refreshToken = localStorage.getItem('refresh_token');
      if (refreshToken) {
        try {
          const response = await authService.refreshToken(refreshToken);
          localStorage.setItem('access_token', response.access_token);
          if (response.refresh_token) {
            localStorage.setItem('refresh_token', response.refresh_token);
          }

          // Return user from response or decode new token
          if (response.user) {
            return {
              isAuthenticated: true,
              user: createUserFromOAuth(response.user),
            };
          }

          const newDecoded = decodeJwt(response.access_token);
          if (newDecoded) {
            return {
              isAuthenticated: true,
              user: createUserFromJwt(newDecoded),
            };
          }
        } catch {
          // Refresh failed - clear tokens
          localStorage.removeItem('access_token');
          localStorage.removeItem('refresh_token');
          return { isAuthenticated: false };
        }
      }

      // No refresh token - clear access token
      localStorage.removeItem('access_token');
      return { isAuthenticated: false };
    }

    // Token is valid - try to get complete user info from backend
    // Only call getUserInfo() for Enterprise edition (has refresh token / SSO).
    // Broker edition: JWT claims are sufficient — skip the network call entirely.
    const hasRefreshToken = !!localStorage.getItem('refresh_token');
    if (hasRefreshToken) {
      try {
        const userInfo = await authService.getUserInfo();
        if (userInfo) {
          return {
            isAuthenticated: true,
            user: createUserFromUserInfo(userInfo),
          };
        }
      } catch {
        // Fallback to JWT claims if userinfo fails
      }
    }

    // Fallback: use JWT claims
    return {
      isAuthenticated: true,
      user: createUserFromJwt(decoded),
    };
  },

  /**
   * Clear OAuth tokens (local logout)
   */
  clearTokens(): void {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
  },

  /**
   * Logout from SSO - redirects to Auth Service to clear SSO session
   * This will log you out from ALL apps using this Auth Service
   */
  logoutSSO(logoutUrl: string, postLogoutRedirectUri?: string): void {
    // Clear local tokens first
    this.clearTokens();

    // Build the SSO logout URL with optional redirect
    const url = new URL(logoutUrl);
    if (postLogoutRedirectUri) {
      url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    }

    // Redirect to SSO logout - this clears the SSO cookie
    window.location.href = url.toString();
  },

  // ==================== Local Auth Methods (Standalone mode) ====================

  /**
   * Login with username/password (Standalone mode)
   */
  async localLogin(username: string, password: string): Promise<LocalLoginResponse> {
    return api.post<LocalLoginResponse>(API_ENDPOINTS.LOCAL_AUTH.LOGIN, {
      username,
      password,
    });
  },

  /**
   * Change password (Standalone mode)
   */
  async localChangePassword(currentPassword: string, newPassword: string): Promise<void> {
    return api.post(API_ENDPOINTS.LOCAL_AUTH.CHANGE_PASSWORD, {
      currentPassword,
      newPassword,
    });
  },

  /**
   * Get local user profile (Standalone mode)
   */
  async getLocalProfile(): Promise<UserInfoResponse> {
    return api.get<UserInfoResponse>(API_ENDPOINTS.LOCAL_AUTH.PROFILE);
  },

  /**
   * Update own profile (Standalone mode) — name and phone only
   */
  async localUpdateProfile(fullName: string, phone: string): Promise<LocalProfileResponse> {
    return api.put<LocalProfileResponse>(API_ENDPOINTS.LOCAL_AUTH.UPDATE_PROFILE, {
      fullName,
      phone,
    });
  },
};
