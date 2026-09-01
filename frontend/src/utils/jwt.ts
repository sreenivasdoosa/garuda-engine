/**
 * JWT utility functions for decoding and validating tokens
 */

export interface JwtPayload {
  sub: string;           // User ID
  username: string;
  email: string;
  // Auth service uses snake_case in JWT
  full_name?: string;
  fullName?: string;     // Legacy support
  is_sysadmin?: boolean;
  isSysadmin?: boolean;  // Legacy support
  role_code?: string;
  roleCode?: string;     // Legacy support
  role_name?: string;
  roleName?: string;     // Legacy support
  app_id?: string;
  appId?: string;        // Legacy support
  rights?: Record<string, string>;  // toolCode -> rightCode (V/E/M)
  // Permission flags from auth service
  can_manage_users?: boolean;
  canManageUsers?: boolean;  // Legacy support
  can_manage_rights?: boolean;
  canManageRights?: boolean;  // Legacy support
  role_hierarchy_level?: number;
  roleHierarchyLevel?: number;  // Legacy support
  iat: number;           // Issued at (seconds)
  exp: number;           // Expires at (seconds)
}

/**
 * Decode a JWT token without verification.
 * Note: This only decodes the payload - verification is done by the backend.
 */
export function decodeJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      window.atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );

    return JSON.parse(jsonPayload) as JwtPayload;
  } catch (error) {
    console.error('Failed to decode JWT:', error);
    return null;
  }
}

/**
 * Check if a decoded token is expired.
 * @param decoded The decoded JWT payload
 * @param bufferSeconds Optional buffer time in seconds before actual expiry (default 60)
 */
export function isTokenExpired(decoded: JwtPayload | null, bufferSeconds: number = 60): boolean {
  if (!decoded || !decoded.exp) {
    return true;
  }
  // exp is in seconds, Date.now() is in milliseconds
  const expiresAt = decoded.exp * 1000;
  const now = Date.now();
  const bufferMs = bufferSeconds * 1000;
  return now >= expiresAt - bufferMs;
}

/**
 * Get remaining time until token expiry in seconds.
 */
export function getTokenRemainingTime(decoded: JwtPayload | null): number {
  if (!decoded || !decoded.exp) {
    return 0;
  }
  const expiresAt = decoded.exp * 1000;
  const remaining = expiresAt - Date.now();
  return Math.max(0, Math.floor(remaining / 1000));
}

/**
 * Helper to get value from JWT payload supporting both snake_case and camelCase
 */
export function getJwtFullName(decoded: JwtPayload): string {
  return decoded.full_name || decoded.fullName || decoded.username;
}

export function getJwtIsSysadmin(decoded: JwtPayload): boolean {
  return decoded.is_sysadmin || decoded.isSysadmin || false;
}

export function getJwtRoleCode(decoded: JwtPayload): string | undefined {
  return decoded.role_code || decoded.roleCode;
}

export function getJwtCanManageUsers(decoded: JwtPayload): boolean {
  return decoded.can_manage_users || decoded.canManageUsers || false;
}

export function getJwtCanManageRights(decoded: JwtPayload): boolean {
  return decoded.can_manage_rights || decoded.canManageRights || false;
}

export function getJwtRoleHierarchyLevel(decoded: JwtPayload): number {
  return decoded.role_hierarchy_level || decoded.roleHierarchyLevel || 0;
}
