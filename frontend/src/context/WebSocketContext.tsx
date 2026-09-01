/**
 * WebSocketContext
 * Provides a shared WebSocket connection across the application.
 * All components use the same connection, subscribing to different channels.
 */

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useAuthStore } from '@/store/authStore';
import { getAccessTokenCookie, setAccessTokenCookie } from '@/services/auth/cookieService';
import { getWsHost, getWsScheme } from '@/config/env';

const CLIENT_ID_PREFIX = 'garuda-console';

/**
 * Extract username from JWT token
 */
const getUsernameFromToken = (): string | null => {
  try {
    const token = localStorage.getItem('access_token');
    if (!token) return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.username || payload.sub || null;
  } catch {
    return null;
  }
};

/**
 * Get WebSocket URL based on environment with clientId for authentication
 */
const getSocketUrl = (): string => {
  if (typeof window === 'undefined') {
    return 'ws://localhost:8080/socket';
  }

  const wsProtocol = getWsScheme();

  const username = getUsernameFromToken();
  const clientId = username ? `${CLIENT_ID_PREFIX}-${username}` : CLIENT_ID_PREFIX;

  let url = `${wsProtocol}//${getWsHost()}/socket?clientId=${encodeURIComponent(clientId)}`;

  // DEV ONLY: pass the JWT as a query param so the upgrade authorizes without the
  // ws_access_token cookie. A localhost dev page can't send that cookie cross-site to a
  // remote WS host (ws-lab / ws-xtreme) — SameSite + domain scoping — so the handshake
  // would 401 (→ 1006). The servlet supports a `token` query-param fallback for exactly
  // this. NOT done in prod builds (prod uses the cookie; no token in the URL / access logs).
  if (import.meta.env.DEV) {
    const token = localStorage.getItem('access_token');
    if (token) {
      url += `&token=${encodeURIComponent(token)}`;
    }
  }

  return url;
};

export interface WebSocketState {
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  reconnectAttempts: number;
  /**
   * Server closed with code 4001 "market-closed": all of this user's enabled exchanges
   * are done for the day. NOT an error — no reconnect; the portal degrades to
   * poll-only (USER_PORTAL_CLIENT_SIDE_PNL_DESIGN §4.3.5). Cleared on the next
   * successful connect (new trading day / manual reconnect).
   */
  marketClosed: boolean;
}

/** WS close code the server uses for the per-user market-close disconnect. */
export const CLOSE_CODE_MARKET_CLOSED = 4001;

type MessageHandler = (data: unknown) => void;

interface Subscriber {
  id: string;
  channels: string[];
  onMessage: MessageHandler;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
}

interface WebSocketContextValue extends WebSocketState {
  subscribe: (
    id: string,
    channels: string[],
    handlers: {
      onMessage: MessageHandler;
      onConnect?: () => void;
      onDisconnect?: () => void;
      onError?: (error: Event) => void;
    }
  ) => void;
  unsubscribe: (id: string) => void;
  send: (message: unknown) => void;
  /** Manual reconnect - resets attempts and tries to connect */
  reconnect: () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RECONNECT_ATTEMPTS = 50; // Higher limit, with exponential backoff

export const WebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuthStore((state) => ({
    isAuthenticated: state.isAuthenticated,
    isLoading: state.isLoading,
  }));
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isConnectingRef = useRef(false);
  const isReconnectPendingRef = useRef(false); // Track if a reconnect is scheduled
  const subscribersRef = useRef<Map<string, Subscriber>>(new Map());
  const activeChannelsRef = useRef<Set<string>>(new Set());

  const [state, setState] = useState<WebSocketState>({
    isConnected: false,
    isConnecting: false,
    error: null,
    reconnectAttempts: 0,
    marketClosed: false,
  });

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    isReconnectPendingRef.current = false;
  }, []);

  // Calculate all unique channels from all subscribers
  const getAllChannels = useCallback((): string[] => {
    const channels = new Set<string>();
    subscribersRef.current.forEach((subscriber) => {
      subscriber.channels.forEach((ch) => channels.add(ch));
    });
    return Array.from(channels);
  }, []);

  // Send subscription message to server
  const sendSubscription = useCallback((channels: string[]) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && channels.length > 0) {
      const subMessage = {
        method: 'subscribe',
        subList: channels,
      };
      wsRef.current.send(JSON.stringify(subMessage));
      console.log('[WebSocket] Sent subscription:', channels);
    }
  }, []);

  const ensureWebSocketAuth = useCallback((): boolean => {
    const token = localStorage.getItem('access_token');
    if (!token) {
      return false;
    }

    if (!getAccessTokenCookie()) {
      setAccessTokenCookie(token, 900);
    }

    return true;
  }, []);

  // Connect to WebSocket
  const connect = useCallback(() => {
    console.log('[WebSocket] connect() called', {
      readyState: wsRef.current?.readyState,
      isConnecting: isConnectingRef.current,
      wsExists: !!wsRef.current,
    });

    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING ||
      isConnectingRef.current
    ) {
      console.log('[WebSocket] Skipping connect - already connected/connecting');
      return;
    }

    if (isLoading) {
      console.log('[WebSocket] Skipping connect - auth state still loading');
      return;
    }

    if (!isAuthenticated) {
      console.log('[WebSocket] Skipping connect - user not authenticated');
      return;
    }

    if (!ensureWebSocketAuth()) {
      console.log('[WebSocket] Skipping connect - WebSocket auth token unavailable');
      return;
    }

    // Clean up any stale WebSocket reference
    if (wsRef.current && wsRef.current.readyState === WebSocket.CLOSED) {
      console.log('[WebSocket] Cleaning up closed WebSocket');
      wsRef.current = null;
    }

    isConnectingRef.current = true;
    setState((prev) => ({ ...prev, isConnecting: true, error: null }));

    try {
      const wsUrl = getSocketUrl();
      console.log('[WebSocket] Connecting to:', wsUrl);
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        console.log('[WebSocket] Connected');
        isConnectingRef.current = false;
        isReconnectPendingRef.current = false;
        reconnectAttemptsRef.current = 0;
        setState({
          isConnected: true,
          isConnecting: false,
          error: null,
          reconnectAttempts: 0,
          marketClosed: false, // fresh connect = new day / manual reconnect
        });

        // Send subscriptions for all channels
        const allChannels = getAllChannels();
        if (allChannels.length > 0) {
          sendSubscription(allChannels);
          activeChannelsRef.current = new Set(allChannels);
        }

        // Notify all subscribers
        subscribersRef.current.forEach((subscriber) => {
          subscriber.onConnect?.();
        });
      };

      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Broadcast to all subscribers - they filter based on their needs
          subscribersRef.current.forEach((subscriber) => {
            subscriber.onMessage(data);
          });
        } catch (e) {
          console.error('[WebSocket] Failed to parse message:', e);
        }
      };

      wsRef.current.onclose = (event) => {
        console.log('[WebSocket] Disconnected:', event.code, event.reason);
        isConnectingRef.current = false;
        wsRef.current = null; // Clear the reference so reconnect creates new WebSocket

        setState((prev) => ({
          ...prev,
          isConnected: false,
          isConnecting: false,
        }));

        // Notify all subscribers
        subscribersRef.current.forEach((subscriber) => {
          subscriber.onDisconnect?.();
        });

        // 4001 = the server's per-user market-close disconnect: the trading day is
        // over for this user's exchanges. Deliberate, not a failure — suppress
        // reconnect entirely (it would just be dropped again all evening); the portal
        // poll loop keeps the page alive. Cleared on the next successful connect.
        if (event.code === CLOSE_CODE_MARKET_CLOSED) {
          console.log('[WebSocket] Market closed for the day (4001) — poll-only until tomorrow');
          setState((prev) => ({ ...prev, marketClosed: true, error: null }));
          return;
        }

        // Auto-reconnect if we have subscribers (regardless of close code)
        // Code 1000 can happen when server restarts, so we should still reconnect
        if (subscribersRef.current.size > 0 && isAuthenticated) {
          if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttemptsRef.current++;

            // Exponential backoff: 1s, 2s, 4s, 8s, ... up to MAX_RECONNECT_DELAY
            const delay = Math.min(
              INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttemptsRef.current - 1),
              MAX_RECONNECT_DELAY
            );

            setState((prev) => ({
              ...prev,
              reconnectAttempts: reconnectAttemptsRef.current,
              error: null, // Clear error on retry
            }));

            console.log(
              `[WebSocket] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})`
            );

            isReconnectPendingRef.current = true;
            reconnectTimeoutRef.current = setTimeout(() => {
              isReconnectPendingRef.current = false;
              connect();
            }, delay);
          } else {
            console.log('[WebSocket] Max reconnection attempts reached, will retry on user action');
            setState((prev) => ({
              ...prev,
              error: 'Connection lost. Click to reconnect.',
            }));
            // Reset attempts so user can trigger manual reconnect
            reconnectAttemptsRef.current = 0;
          }
        }
      };

      wsRef.current.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
        isConnectingRef.current = false;
        setState((prev) => ({
          ...prev,
          error: 'WebSocket connection error',
        }));

        // Notify all subscribers
        subscribersRef.current.forEach((subscriber) => {
          subscriber.onError?.(error);
        });
      };
    } catch (error) {
      console.error('[WebSocket] Failed to create connection:', error);
      isConnectingRef.current = false;
      setState((prev) => ({
        ...prev,
        isConnecting: false,
        error: 'Failed to create WebSocket connection',
      }));
    }
  }, [ensureWebSocketAuth, getAllChannels, isAuthenticated, isLoading, sendSubscription]);

  // Subscribe a component to channels
  const subscribe = useCallback(
    (
      id: string,
      channels: string[],
      handlers: {
        onMessage: MessageHandler;
        onConnect?: () => void;
        onDisconnect?: () => void;
        onError?: (error: Event) => void;
      }
    ) => {
      console.log(`[WebSocket] Subscriber ${id} subscribing to:`, channels, {
        readyState: wsRef.current?.readyState,
        isConnecting: isConnectingRef.current,
        wsExists: !!wsRef.current,
        subscriberCount: subscribersRef.current.size,
      });

      subscribersRef.current.set(id, {
        id,
        channels,
        ...handlers,
      });

      // Check if we need to subscribe to new channels
      const newChannels = channels.filter((ch) => !activeChannelsRef.current.has(ch));

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        console.log('[WebSocket] Already connected, notifying subscriber');
        if (newChannels.length > 0) {
          // Subscribe to new channels only
          sendSubscription(newChannels);
          newChannels.forEach((ch) => activeChannelsRef.current.add(ch));
        }
        // Notify this subscriber that we're already connected
        handlers.onConnect?.();
      } else if (!isConnectingRef.current && !isReconnectPendingRef.current &&
                 (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED)) {
        // First subscriber or reconnect after close - initiate connection
        // But only if no reconnect is already scheduled
        console.log('[WebSocket] Initiating new connection');
        connect();
      } else {
        console.log('[WebSocket] Connection in progress or reconnect pending, subscriber will be notified on connect');
      }
      // Note: If WebSocket is in CONNECTING state, subscriber is added to the map
      // and will receive onConnect when onopen fires (via subscribersRef.current.forEach)
    },
    [connect, sendSubscription]
  );

  // Unsubscribe a component
  const unsubscribe = useCallback((id: string) => {
    console.log(`[WebSocket] Subscriber ${id} unsubscribing`, {
      remainingSubscribers: subscribersRef.current.size - 1,
      readyState: wsRef.current?.readyState,
    });
    subscribersRef.current.delete(id);

    // If no more subscribers, we could disconnect, but let's keep the connection
    // for faster reconnection when user navigates back
    // Optionally: disconnect if no subscribers for a while
  }, []);

  // Send a message
  const send = useCallback((message: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(typeof message === 'string' ? message : JSON.stringify(message));
    } else {
      console.warn('[WebSocket] Cannot send message - not connected');
    }
  }, []);

  // Manual reconnect - resets attempts and forces a new connection
  const reconnect = useCallback(() => {
    console.log('[WebSocket] Manual reconnect triggered', {
      subscriberCount: subscribersRef.current.size,
      wsExists: !!wsRef.current,
      readyState: wsRef.current?.readyState,
      isConnecting: isConnectingRef.current,
    });

    // Clear any pending reconnect timeout
    clearReconnectTimeout();

    // Reset reconnect attempts
    reconnectAttemptsRef.current = 0;

    // Close existing connection if any
    if (wsRef.current) {
      console.log('[WebSocket] Closing existing connection for reconnect');
      wsRef.current.onclose = null; // Prevent auto-reconnect from firing
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.onopen = null;
      try {
        wsRef.current.close(1000, 'Manual reconnect');
      } catch (e) {
        console.log('[WebSocket] Error closing existing connection:', e);
      }
      wsRef.current = null;
    }

    isConnectingRef.current = false;

    setState((prev) => ({
      ...prev,
      isConnected: false,
      isConnecting: false,
      error: null,
      reconnectAttempts: 0,
    }));

    // Small delay to ensure state is clean before reconnecting
    setTimeout(() => {
      console.log('[WebSocket] Calling connect() after reconnect cleanup');
      connect();
    }, 100);
  }, [clearReconnectTimeout, connect]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (!isAuthenticated) {
      clearReconnectTimeout();
      reconnectAttemptsRef.current = 0;
      isConnectingRef.current = false;

      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.onopen = null;
        try {
          wsRef.current.close(1000, 'Auth unavailable');
        } catch (e) {
          console.log('[WebSocket] Error closing connection after auth loss:', e);
        }
        wsRef.current = null;
      }

      setState((prev) => ({
        ...prev,
        isConnected: false,
        isConnecting: false,
      }));
      return;
    }

    if (subscribersRef.current.size > 0 &&
        !isReconnectPendingRef.current &&
        (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED)) {
      connect();
    }
  }, [clearReconnectTimeout, connect, isAuthenticated, isLoading]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearReconnectTimeout();
      if (wsRef.current) {
        wsRef.current.close(1000, 'Provider unmount');
        wsRef.current = null;
      }
    };
  }, [clearReconnectTimeout]);

  const value: WebSocketContextValue = {
    ...state,
    subscribe,
    unsubscribe,
    send,
    reconnect,
  };

  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>;
};

export const useWebSocketContext = (): WebSocketContextValue => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocketContext must be used within a WebSocketProvider');
  }
  return context;
};

export default WebSocketContext;
