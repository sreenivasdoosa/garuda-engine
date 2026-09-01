// Environment configuration

export const getBaseUrl = (): string => {
  // In production, use the current origin
  if (typeof window !== 'undefined') {
    const { protocol, host } = window.location;
    return `${protocol}//${host}`;
  }
  return import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
};

/**
 * Runtime WebSocket host pushed by the server's /api/v2/public/config
 * (server.ws.host). Set by configService.getServerConfig() — which useAuth
 * fetches before the WS auth cookie is written and before isAuthenticated
 * flips (the WS connect trigger), so it is in place before any connection.
 * Takes precedence over the build-time VITE_WS_HOST: prod serves one UI
 * build from the jar across instances, so per-instance config must come
 * from the instance itself.
 */
let runtimeWsHost: string | null = null;

export const setRuntimeWsHost = (host?: string | null): void => {
  runtimeWsHost = host?.trim() || null;
};

/**
 * Host (hostname[:port]) for WebSocket connections.
 *
 * Priority: server-pushed wsHost (runtime) → VITE_WS_HOST (build-time) →
 * page origin. When set, all WebSocket connections
 * use that hostname directly — a DNS-only (grey-cloud) record that bypasses
 * the Cloudflare proxy — while REST/static traffic stays on the proxied page
 * origin. Otherwise WS stays on the page host, so dev and single-hostname
 * deployments behave exactly as before.
 */
export const getWsHost = (): string => {
  if (runtimeWsHost) {
    return runtimeWsHost;
  }
  const configured = (import.meta.env.VITE_WS_HOST as string | undefined)?.trim();
  if (configured) {
    return configured;
  }
  if (typeof window !== 'undefined') {
    return window.location.host;
  }
  return 'localhost:8080';
};

/** True when WebSockets are configured to use a different host than the page. */
export const isWsHostSplit = (): boolean => {
  return typeof window !== 'undefined' && getWsHost() !== window.location.host;
};

/**
 * WebSocket scheme (`wss:` / `ws:`) for a given host — follows the HOST's TLS, not the
 * page protocol. The page-protocol heuristic is only correct when WS shares the page
 * origin; a SPLIT WS host (e.g. the grey-cloud `ws-lab` / `ws-xtreme` records) is a
 * public TLS endpoint (wss-only on 443), so it must be `wss:` even when the page is
 * plain `http` — otherwise `npm run dev` (http://localhost) pointed at a prod/lab
 * server builds a plaintext `ws://` that the TLS-only host drops (close 1006). Rules:
 *   - https page → wss (prod, unchanged)
 *   - split host that is a real domain (ws-lab/ws-xtreme) → wss (fixes http-dev → remote)
 *   - otherwise (WS on the page origin, or a local/loopback split host) → page scheme
 */
export const getWsScheme = (host: string = getWsHost()): string => {
  if (typeof window === 'undefined') {
    return 'ws:';
  }
  if (window.location.protocol === 'https:') {
    return 'wss:';
  }
  const isSplit = host !== window.location.host;
  const isLocalHost = /^(localhost|127\.|0\.0\.0\.0|\[?::1)/i.test(host);
  return isSplit && !isLocalHost ? 'wss:' : 'ws:';
};

export const getWsUrl = (): string => {
  if (typeof window !== 'undefined') {
    return `${getWsScheme()}//${getWsHost()}`;
  }
  return import.meta.env.VITE_WS_URL || 'ws://localhost:8080';
};

/** One brand. Kept as a function so callers do not have to change. */
export const getBrand = (): string => 'garuda-engine';

export const isDebugMode = (): boolean => {
  return import.meta.env.VITE_DEBUG === 'true';
};

export const isAnalyticsEnabled = (): boolean => {
  return import.meta.env.VITE_ENABLE_ANALYTICS === 'true';
};

// OAuth - Fallback redirect URI (used if server config not available)
// Primary OAuth config comes from server via /apis/public/config endpoint
export const getOAuthRedirectUri = (): string => {
  if (typeof window !== 'undefined') {
    // In browser, construct redirect URI from current origin
    return `${window.location.origin}/oauth/callback`;
  }
  return import.meta.env.VITE_OAUTH_REDIRECT_URI || 'http://localhost:5173/oauth/callback';
};
