import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { User } from '@/types/user';
import { decodeJwt, isTokenExpired, type JwtPayload } from '@/utils/jwt';

export interface AuthStatus {
  isAuthenticated: boolean;
  user?: User;
}

/** What `POST /api/auth/login` returns. */
export interface LocalLoginResponse {
  accessToken: string;
  tokenType: string;
  username: string;
  fullName: string;
  email: string;
  role: string;
}

/** What `PUT /api/auth/profile` returns. */
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

/** What `GET /api/auth/profile` returns. */
export interface ProfileResponse {
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
  /**
   * Are we signed in?
   *
   * The token in `access_token` and its claims are the whole answer. The
   * engine this was copied from could also refresh against a central identity
   * service and fetch a fuller profile from it; garuda issues one access
   * token at sign-in and nothing else, so an expired one means sign in again.
   */
  async checkJwtStatus(): Promise<AuthStatus> {
    const token = localStorage.getItem('access_token');
    if (!token) {
      return { isAuthenticated: false };
    }

    const decoded = decodeJwt(token);
    if (!decoded || isTokenExpired(decoded)) {
      localStorage.removeItem('access_token');
      return { isAuthenticated: false };
    }

    return { isAuthenticated: true, user: createUserFromJwt(decoded) };
  },

  clearTokens(): void {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
  },


  // ==================== Local Auth Methods (Standalone mode) ====================

  /**
   * Login with username/password (Standalone mode)
   */
  async localLogin(username: string, password: string): Promise<LocalLoginResponse> {
    return api.post<LocalLoginResponse>(API_ENDPOINTS.AUTH.LOGIN, {
      username,
      password,
    });
  },

  /**
   * Change password (Standalone mode)
   */
  async localChangePassword(currentPassword: string, newPassword: string): Promise<void> {
    return api.post(API_ENDPOINTS.AUTH.CHANGE_PASSWORD, {
      currentPassword,
      newPassword,
    });
  },

  /**
   * Get local user profile (Standalone mode)
   */
  async getLocalProfile(): Promise<ProfileResponse> {
    return api.get<ProfileResponse>(API_ENDPOINTS.AUTH.PROFILE);
  },

  /**
   * Update own profile (Standalone mode) — name and phone only
   */
  async localUpdateProfile(fullName: string, phone: string): Promise<LocalProfileResponse> {
    return api.put<LocalProfileResponse>(API_ENDPOINTS.AUTH.UPDATE_PROFILE, {
      fullName,
      phone,
    });
  },
};
