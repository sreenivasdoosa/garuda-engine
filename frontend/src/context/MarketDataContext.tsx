/**
 * MarketDataContext - React context for real-time market data via WebSocket.
 * Used by the Live Feed page in Standalone mode.
 */

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import {
  marketDataWebSocket,
  type TickData,
  type StraddleTick,
  type Signal,
  type WebSocketEventType,
  type WebSocketMessage,
} from '@/api/marketDataWebSocket';

interface MarketDataContextType {
  isConnected: boolean;
  ticks: Map<string, TickData>;
  straddleTicks: Map<string, StraddleTick>;
  signals: Map<string, Signal>;
  lastHeartbeat: Date | null;
  connect: () => void;
  disconnect: () => void;
  clearTicks: () => void;
  clearStraddleTicks: () => void;
  clearSignals: () => void;
}

const MarketDataContext = createContext<MarketDataContextType | null>(null);

export function MarketDataProvider({ children }: { children: ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const [ticks, setTicks] = useState<Map<string, TickData>>(new Map());
  const [straddleTicks, setStraddleTicks] = useState<Map<string, StraddleTick>>(new Map());
  const [signals, setSignals] = useState<Map<string, Signal>>(new Map());
  const [lastHeartbeat, setLastHeartbeat] = useState<Date | null>(null);

  const handleMessage = useCallback((type: WebSocketEventType, data: WebSocketMessage) => {
    switch (type) {
      case 'connected':
        setIsConnected(true);
        break;
      case 'disconnected':
      case 'error':
        setIsConnected(false);
        break;
      case 'tick':
        if (data.tick) {
          const tick = data.tick;
          const key = `${tick.exchange}:${tick.tradingSymbol}`;
          setTicks((prev) => {
            const next = new Map(prev);
            next.set(key, tick);
            return next;
          });
        }
        break;
      case 'sTick':
        if (data.sTick) {
          const sTick = data.sTick;
          const key = `${sTick.exchange}:${sTick.symbol}`;
          setStraddleTicks((prev) => {
            const next = new Map(prev);
            next.set(key, sTick);
            return next;
          });
        }
        break;
      case 'signal':
        if (data.signal) {
          const signal = data.signal;
          const key = `${signal.strategyName}:${signal.exchange}:${signal.tranch}:${signal.condition}`;
          setSignals((prev) => {
            const next = new Map(prev);
            next.set(key, signal);
            return next;
          });
        }
        break;
      case 'heartbeat':
        setLastHeartbeat(new Date());
        break;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = marketDataWebSocket.subscribe(handleMessage);
    marketDataWebSocket.connect();
    if (marketDataWebSocket.isConnected()) {
      setIsConnected(true);
    }
    return () => {
      unsubscribe();
    };
  }, [handleMessage]);

  const connect = useCallback(() => marketDataWebSocket.connect(), []);
  const disconnect = useCallback(() => marketDataWebSocket.disconnect(), []);
  const clearTicks = useCallback(() => setTicks(new Map()), []);
  const clearStraddleTicks = useCallback(() => setStraddleTicks(new Map()), []);
  const clearSignals = useCallback(() => setSignals(new Map()), []);

  return (
    <MarketDataContext.Provider
      value={{
        isConnected,
        ticks,
        straddleTicks,
        signals,
        lastHeartbeat,
        connect,
        disconnect,
        clearTicks,
        clearStraddleTicks,
        clearSignals,
      }}
    >
      {children}
    </MarketDataContext.Provider>
  );
}

export function useMarketData() {
  const context = useContext(MarketDataContext);
  if (!context) {
    throw new Error('useMarketData must be used within a MarketDataProvider');
  }
  return context;
}
