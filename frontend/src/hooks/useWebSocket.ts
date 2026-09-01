/**
 * useWebSocket Hook
 * Uses the shared WebSocket connection from WebSocketContext.
 * Multiple components can subscribe to different channels via the same connection.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useWebSocketContext } from '@/context/WebSocketContext';

export interface WebSocketOptions {
  /** Subscriptions to send on connect (e.g., ['terminal', 'ticks']) */
  subscriptions?: string[];
  /** Auto-reconnect on disconnect (handled by context, kept for API compatibility) */
  autoReconnect?: boolean;
  /** Reconnect delay in ms (handled by context, kept for API compatibility) */
  reconnectDelay?: number;
  /** Max reconnect attempts (handled by context, kept for API compatibility) */
  maxReconnectAttempts?: number;
  /** Callback when message received */
  onMessage?: (data: unknown) => void;
  /** Callback when connected */
  onConnect?: () => void;
  /** Callback when disconnected */
  onDisconnect?: () => void;
  /** Callback on error */
  onError?: (error: Event) => void;
}

export interface WebSocketState {
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  reconnectAttempts: number;
  /** Server closed with 4001 — market done for the day, poll-only (no reconnect). */
  marketClosed: boolean;
}

export interface WebSocketReturn extends WebSocketState {
  connect: () => void;
  disconnect: () => void;
  send: (message: unknown) => void;
  subscribe: (channels: string[]) => void;
  unsubscribe: (channels: string[]) => void;
  /** Manual reconnect - resets attempts and forces a new connection */
  reconnect: () => void;
}

// Generate unique subscriber ID
let subscriberIdCounter = 0;
const generateSubscriberId = () => `ws-subscriber-${++subscriberIdCounter}-${Date.now()}`;

export const useWebSocket = (options: WebSocketOptions = {}): WebSocketReturn => {
  const { subscriptions = [], onMessage, onConnect, onDisconnect, onError } = options;

  const context = useWebSocketContext();
  const subscriberIdRef = useRef<string>(generateSubscriberId());
  const isSubscribedRef = useRef(false);

  // Track local connected state for this subscriber
  const [localConnected, setLocalConnected] = useState(false);

  // Store callbacks in refs to avoid re-subscribing on every render
  const onMessageRef = useRef(onMessage);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);
  const subscriptionsRef = useRef(subscriptions);

  onMessageRef.current = onMessage;
  onConnectRef.current = onConnect;
  onDisconnectRef.current = onDisconnect;
  onErrorRef.current = onError;
  subscriptionsRef.current = subscriptions;

  // Subscribe to context
  const doSubscribe = useCallback(() => {
    if (isSubscribedRef.current) {
      console.log('[useWebSocket] Already subscribed, skipping');
      return;
    }

    console.log('[useWebSocket] Subscribing:', subscriberIdRef.current, subscriptionsRef.current);
    context.subscribe(subscriberIdRef.current, subscriptionsRef.current, {
      onMessage: (data) => onMessageRef.current?.(data),
      onConnect: () => {
        console.log('[useWebSocket] onConnect callback fired for:', subscriberIdRef.current);
        setLocalConnected(true);
        onConnectRef.current?.();
      },
      onDisconnect: () => {
        console.log('[useWebSocket] onDisconnect callback fired for:', subscriberIdRef.current);
        setLocalConnected(false);
        onDisconnectRef.current?.();
      },
      onError: (error) => onErrorRef.current?.(error),
    });
    isSubscribedRef.current = true;
  }, [context]);

  // Unsubscribe from context
  const doUnsubscribe = useCallback(() => {
    if (!isSubscribedRef.current) {
      console.log('[useWebSocket] Not subscribed, skipping unsubscribe');
      return;
    }

    console.log('[useWebSocket] Unsubscribing:', subscriberIdRef.current);
    context.unsubscribe(subscriberIdRef.current);
    isSubscribedRef.current = false;
    setLocalConnected(false);
  }, [context]);

  // Connect - subscribes to the shared connection
  const connect = useCallback(() => {
    doSubscribe();
  }, [doSubscribe]);

  // Disconnect - unsubscribes from the shared connection
  const disconnect = useCallback(() => {
    doUnsubscribe();
  }, [doUnsubscribe]);

  // Send message via shared connection
  const send = useCallback(
    (message: unknown) => {
      context.send(message);
    },
    [context]
  );

  // Subscribe to additional channels (runtime)
  const subscribe = useCallback(
    (channels: string[]) => {
      context.send({ method: 'subscribe', subList: channels });
    },
    [context]
  );

  // Unsubscribe from channels (runtime)
  const unsubscribe = useCallback(
    (_channels: string[]) => {
      context.send({ method: 'unsubscribe' });
    },
    [context]
  );

  // Auto-subscribe on mount, cleanup on unmount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Subscribe on mount
    doSubscribe();

    // Cleanup on unmount
    return () => {
      doUnsubscribe();
    };
    // Only run on mount/unmount - callbacks are stable via refs
  }, []);

  // Sync local connected state with context state
  // This handles cases where onConnect callback might be missed (e.g., page refresh timing)
  useEffect(() => {
    if (context.isConnected) {
      if (!isSubscribedRef.current) {
        // Context is connected but we're not subscribed - re-subscribe
        console.log('[useWebSocket] Context connected but not subscribed, re-subscribing');
        doSubscribe();
      } else if (!localConnected) {
        // Subscribed and context connected, but local state not updated
        console.log('[useWebSocket] Syncing local connected state with context');
        setLocalConnected(true);
      }
    } else if (localConnected) {
      setLocalConnected(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.isConnected, localConnected]);

  // Reconnect via context
  const reconnect = useCallback(() => {
    context.reconnect();
  }, [context]);

  return {
    isConnected: localConnected && context.isConnected,
    isConnecting: context.isConnecting,
    error: context.error,
    reconnectAttempts: context.reconnectAttempts,
    marketClosed: context.marketClosed,
    connect,
    disconnect,
    send,
    subscribe,
    unsubscribe,
    reconnect,
  };
};

export default useWebSocket;
