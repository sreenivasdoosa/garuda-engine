/**
 * JWT utility functions for decoding and validating tokens
 */

export interface JwtPayload {
  sub: string;
  username: string;
  email: string;
  full_name?: string;
  role_code?: string;
  iat: number; // issued at, seconds
  exp: number; // expires at, seconds
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
