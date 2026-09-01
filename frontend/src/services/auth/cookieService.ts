/**
 * Cookie utility service for managing authentication cookies.
 * Used for WebSocket authentication since browser WebSocket API doesn't support custom headers.
 */

import { isWsHostSplit } from '@/config/env';

const ACCESS_TOKEN_COOKIE = 'ws_access_token';

/**
 * Parent domain of the page hostname, e.g. ".example.com" for
 * console.example.com — undefined for localhost, IPs and bare registrable
 * domains.
 */
function getParentDomain(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const hostname = window.location.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return undefined; // IP address — domain attribute not applicable
  }
  const labels = hostname.split('.');
  if (labels.length < 3) {
    return undefined; // localhost or bare domain — host-only cookie suffices
  }
  return '.' + labels.slice(-2).join('.');
}

/**
 * Domain to scope the WS auth cookie to when WebSockets connect to a
 * sibling hostname: a host-only cookie set on one hostname is never sent to
 * its sibling, so the upgrade would be rejected. Undefined when no WS host
 * split is configured, so
 * single-hostname deployments keep the tighter host-only cookie.
 */
function getCookieDomain(): string | undefined {
  return isWsHostSplit() ? getParentDomain() : undefined;
}

/**
 * Set a cookie with the given name, value, and options
 */
export function setCookie(name: string, value: string, options: {
  maxAge?: number;      // Max age in seconds
  path?: string;
  domain?: string;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
} = {}): void {
  const { maxAge, path = '/', domain, secure, sameSite = 'Lax' } = options;

  let cookieString = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;

  if (maxAge !== undefined) {
    cookieString += `; max-age=${maxAge}`;
  }

  cookieString += `; path=${path}`;

  if (domain) {
    cookieString += `; domain=${domain}`;
  }

  if (secure || window.location.protocol === 'https:') {
    cookieString += '; secure';
  }

  cookieString += `; samesite=${sameSite}`;

  document.cookie = cookieString;
}

/**
 * Get a cookie value by name
 */
export function getCookie(name: string): string | null {
  const cookies = document.cookie.split(';');
  const encodedName = encodeURIComponent(name);

  for (const cookie of cookies) {
    const [cookieName, cookieValue] = cookie.trim().split('=');
    if (cookieName === encodedName) {
      return decodeURIComponent(cookieValue);
    }
  }

  return null;
}

/**
 * Delete a cookie by name. A domain cookie can only be deleted with a
 * matching domain attribute, so when a domain is passed both variants
 * (host-only and domain-scoped) are cleared.
 */
export function deleteCookie(name: string, path: string = '/', domain?: string): void {
  document.cookie = `${encodeURIComponent(name)}=; max-age=0; path=${path}`;
  if (domain) {
    document.cookie = `${encodeURIComponent(name)}=; max-age=0; path=${path}; domain=${domain}`;
  }
}

/**
 * Set the access token cookie for WebSocket authentication.
 * The cookie is set with a short max-age matching the token expiration.
 * When a WS host split is configured (VITE_WS_HOST) the cookie is scoped to
 * the parent domain so the sibling ws- hostname receives it too.
 * @param token The JWT access token
 * @param expiresInSeconds Token expiration time in seconds (default: 15 minutes)
 */
export function setAccessTokenCookie(token: string, expiresInSeconds: number = 900): void {
  // Two same-named cookies (host-only + domain-scoped) must never coexist:
  // the WS servlet takes the first one the browser sends, and a stale
  // leftover from before a split was turned on/off would carry an old token
  // (mystery 401s for up to its max-age). Delete both variants, then write
  // exactly one.
  deleteCookie(ACCESS_TOKEN_COOKIE, '/', getParentDomain());
  setCookie(ACCESS_TOKEN_COOKIE, token, {
    maxAge: expiresInSeconds,
    path: '/',
    domain: getCookieDomain(),
    sameSite: 'Lax'
  });
}

/**
 * Get the access token from cookie
 */
export function getAccessTokenCookie(): string | null {
  return getCookie(ACCESS_TOKEN_COOKIE);
}

/**
 * Clear the access token cookie
 */
export function clearAccessTokenCookie(): void {
  deleteCookie(ACCESS_TOKEN_COOKIE, '/', getParentDomain());
}
