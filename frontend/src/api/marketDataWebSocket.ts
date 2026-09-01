/**
 * WebSocket service for real-time market data (Standalone mode).
 * Connects to /api/v2/market-data/socket registered in core's WebServer.
 */

import { getWsHost, getWsScheme } from '@/config/env';

export interface TickData {
  tradingSymbol: string;
  exchange: string;
  instrumentID: string;
  lastTradedPrice: number;
  lastTradedQuantity: number;
  avgTradedPrice: number;
  volume: number;
  totalBuyQuantity: number;
  totalSellQuantity: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  bids?: Depth[];
  asks?: Depth[];
  timestamp: number;
  oi: number;
  prevOI: number;
  turnover: number;
  sequenceNum: number;
}

export interface Depth {
  price: number;
  quantity: number;
  orders: number;
}

export interface StraddleTick {
  exchange: string;
  referenceSymbol: string;
  symbol: string;
  ceSymbol: string;
  peSymbol: string;
  cePrice: number;
  pePrice: number;
  price: number;
  ceOI: number;
  peOI: number;
  timestamp: number;
}

export interface Signal {
  strategyName: string;
  exchange: string;
  tranch: number;
  condition: string;
  rulesExpr: string;
  dependsOnCond: string | null;
  result: boolean;
}

export interface WebSocketMessage {
  tick?: TickData;
  sTick?: StraddleTick;
  signal?: Signal;
  status?: string;
  message?: string;
  timestamp?: string;
}

export type WebSocketEventType = 'tick' | 'sTick' | 'signal' | 'heartbeat' | 'connected' | 'disconnected' | 'error';

export type WebSocketEventHandler = (type: WebSocketEventType, data: WebSocketMessage) => void;

class MarketDataWebSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 3000;
  private handlers: Set<WebSocketEventHandler> = new Set();
  private isConnecting = false;
  private shouldReconnect = true;

  private buildUrl(): string {
    const protocol = getWsScheme();
    const username = this.getUsername();
    const clientId = username ? `garuda-console-${username}` : 'garuda-console';
    let url = `${protocol}//${getWsHost()}/api/v2/market-data/socket?clientId=${encodeURIComponent(clientId)}`;
    // DEV ONLY: see context/WebSocketContext.tsx — a localhost page can't send the
    // ws_access_token cookie cross-site to a remote WS host, so pass the JWT as the
    // servlet's `token` query-param fallback. Prod builds keep using the cookie.
    if (import.meta.env.DEV) {
      const token = localStorage.getItem('access_token');
      if (token) {
        url += `&token=${encodeURIComponent(token)}`;
      }
    }
    return url;
  }

  private getUsername(): string | null {
    try {
      const token = localStorage.getItem('access_token');
      if (!token) return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.username || null;
    } catch {
      return null;
    }
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    try {
      this.ws = new WebSocket(this.buildUrl());

      this.ws.onopen = () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.send({ method: 'addsymbol', symbols: ['ALL'] });
        this.send({ method: 'subsignals' });
        this.notifyHandlers('connected', { status: 'ok', message: 'Connected' });
      };

      this.ws.onmessage = (event) => {
        try {
          const data: WebSocketMessage = JSON.parse(event.data);
          if (data.tick) {
            this.notifyHandlers('tick', data);
          } else if (data.sTick) {
            this.notifyHandlers('sTick', data);
          } else if (data.signal) {
            this.notifyHandlers('signal', data);
          } else if (data.message === 'heartbeat') {
            this.notifyHandlers('heartbeat', data);
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      this.ws.onclose = (event) => {
        this.isConnecting = false;
        this.notifyHandlers('disconnected', { status: 'closed', message: event.reason || 'Connection closed' });
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.isConnecting = false;
        this.notifyHandlers('error', { status: 'error', message: 'WebSocket error' });
      };
    } catch {
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);
    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(data: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  subscribe(handler: WebSocketEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private notifyHandlers(type: WebSocketEventType, data: WebSocketMessage): void {
    this.handlers.forEach((handler) => {
      try {
        handler(type, data);
      } catch (error) {
        console.error('Error in WebSocket handler:', error);
      }
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export const marketDataWebSocket = new MarketDataWebSocket();
