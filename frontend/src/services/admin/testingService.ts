/**
 * Testing Service
 * API service for manual testing utilities
 */

import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

// Types
export type SignalAction = 'ENTRY' | 'EXIT';

export interface TestSignalRequest {
  strategyName: string;
  tranch: number;
  action: SignalAction;
}

export interface TestSignalResponse {
  success: boolean;
  message: string;
  strategyName: string;
  tranch: number;
  action: string;
  source: string;
  exchange: string;
}

export interface SignalStrategyInfo {
  strategyName: string;
  exchange: string;
  templateName: string;
  fnoSymbolName: string;
}

export interface ResetStrategyStateRequest {
  resetScope?: 'USER' | 'STRATEGY';
  username?: string;
  strategyName: string;
  brokerName?: string;
  tradingDate?: string;
}

export interface ResetStrategyStateResponse {
  success: boolean;
  message: string;
  resetScope?: 'USER' | 'STRATEGY';
  username?: string;
  strategyName: string;
  brokerName?: string;
  tradingDate: string;
  exchange: string;
  stateCleared: boolean;
  signalsCleared: number;
  tradesCleared: number;
  schedulesReloaded: boolean;
  summaryRefreshed: boolean;
  strategyRuntimeCleared?: boolean;
  runtimeResetMode?: string;
  stateError?: string;
  tradeManagerError?: string;
  tradeManagerWarning?: string;
  schedulesError?: string;
  schedulesWarning?: string;
  summaryError?: string;
  summaryWarning?: string;
}

// Strategy-state edit/clear (testing tab) — these touch ONLY the evaluator
// state row; trades and signals are never modified.
export interface UpdateStrategyStateRequest {
  username: string;
  strategyName: string;
  brokerName: string;
  tradingDate?: string;
  /** Raw JSON string of the full stateData object (as returned by the state GET). */
  stateDataJson: string;
}

export interface UpdateStrategyStateResponse {
  success: boolean;
  message: string;
  username: string;
  strategyName: string;
  brokerName: string;
  tradingDate: string;
  stateApplied: boolean;
}

export interface ClearStrategyStateRequest {
  username: string;
  strategyName: string;
  brokerName: string;
  tradingDate?: string;
}

export interface ClearStrategyStateResponse {
  success: boolean;
  message: string;
  username: string;
  strategyName: string;
  brokerName: string;
  tradingDate: string;
  stateCleared: boolean;
  tradesCleared: number;
  tradesUntouched: boolean;
  tranchCacheCleared?: number[];
  stateError?: string;
  tranchCacheError?: string;
}

// Order operation types
export type OrderDirection = 'LONG' | 'SHORT';
export type OrderProductType = 'MIS' | 'NRML' | 'CNC';
export type OrderOrderType = 'MARKET' | 'LIMIT' | 'SL_MARKET' | 'SL_LIMIT';
export type OrderSegment = 'EQUITY' | 'FNO' | 'CURRENCY' | 'COMMODITY';

export interface PlaceOrderRequest {
  username: string;
  broker: string;
  tradingSymbol: string;
  exchange?: string;
  segment?: OrderSegment;
  direction: OrderDirection;
  quantity: number;
  productType: OrderProductType;
  orderType: OrderOrderType;
  price?: number;
  triggerPrice?: number;
}

export interface ModifyOrderRequest {
  username: string;
  broker: string;
  orderId: string;
  newPrice?: number;
  newTriggerPrice?: number;
  newQuantity?: number;
}

export interface CancelOrderRequest {
  username: string;
  broker: string;
  orderId: string;
}

export interface OrderOperationResponse {
  success: boolean;
  message: string;
  orderId?: string;
  systemOrderId?: string;
  orderStatus?: string;
}

export interface TriggerDbBackupResponse {
  success: boolean;
  message: string;
  triggeredBy: string;
  triggeredAt: string;
}

export type ClearCandlesType = 'day' | 'intraday' | 'both';
export type CandlesAction = 'clear' | 'update' | 'clear_and_update';

export interface ClearCandlesHistoryRequest {
  exchange: string;
  symbol: string;
  type: ClearCandlesType;
  action: CandlesAction;
}

export interface ClearCandlesHistoryResponse {
  success: boolean;
  message: string;
  exchange: string;
  symbol: string;
  type: string;
  action: string;
  dayCandlesCleared: boolean;
  dayCandlesCount: number;
  intradayCandlesCleared: boolean;
  intradayCandlesCount: number;
  cacheCleared: boolean;
  cacheEntriesCount: number;
  dayCandlesUpdated: boolean;
  dayCandlesUpdatedCount: number;
  intradayCandlesUpdated: boolean;
  intradayCandlesUpdatedCount: number;
  dayCandlesError?: string;
  intradayCandlesError?: string;
  cacheError?: string;
  dayCandlesUpdateError?: string;
  intradayCandlesUpdateError?: string;
}

export const testingService = {
  /**
   * Send a test external signal
   */
  async sendTestSignal(request: TestSignalRequest): Promise<TestSignalResponse> {
    return api.post<TestSignalResponse>(API_ENDPOINTS.V2_TESTING.SIGNAL, request);
  },

  /**
   * Get list of strategies that accept external signals
   */
  async getSignalStrategies(): Promise<SignalStrategyInfo[]> {
    return api.get<SignalStrategyInfo[]>(API_ENDPOINTS.V2_TESTING.STRATEGIES);
  },

  /**
   * Reset strategy state for testing
   * USER scope clears user state/signals/trades.
   * STRATEGY scope clears only strategy-level runtime scheduler state.
   */
  async resetStrategyState(request: ResetStrategyStateRequest): Promise<ResetStrategyStateResponse> {
    return api.post<ResetStrategyStateResponse>(API_ENDPOINTS.V2_TESTING.RESET_STRATEGY_STATE, request);
  },

  /**
   * Apply an admin-edited evaluator state JSON. Updates the in-memory cache and
   * the DB row (force-persist) so the running evaluator picks it up next cycle.
   * Trades and signals are NOT touched.
   */
  async updateStrategyState(request: UpdateStrategyStateRequest): Promise<UpdateStrategyStateResponse> {
    return api.post<UpdateStrategyStateResponse>(API_ENDPOINTS.V2_TESTING.UPDATE_STRATEGY_STATE, request);
  },

  /**
   * Clear ONLY the evaluator state (UserStrategyState row + cache + tranch
   * cache) for a user/strategy/broker. Trades and signals are NOT touched —
   * unlike resetStrategyState, which also clears trades.
   */
  async clearStrategyState(request: ClearStrategyStateRequest): Promise<ClearStrategyStateResponse> {
    return api.post<ClearStrategyStateResponse>(API_ENDPOINTS.V2_TESTING.CLEAR_STRATEGY_STATE, request);
  },

  /**
   * Place a test order
   */
  async placeOrder(request: PlaceOrderRequest): Promise<OrderOperationResponse> {
    return api.post<OrderOperationResponse>(API_ENDPOINTS.V2_TESTING.PLACE_ORDER, request);
  },

  /**
   * Modify an existing order
   */
  async modifyOrder(request: ModifyOrderRequest): Promise<OrderOperationResponse> {
    return api.post<OrderOperationResponse>(API_ENDPOINTS.V2_TESTING.MODIFY_ORDER, request);
  },

  /**
   * Cancel an existing order
   */
  async cancelOrder(request: CancelOrderRequest): Promise<OrderOperationResponse> {
    return api.post<OrderOperationResponse>(API_ENDPOINTS.V2_TESTING.CANCEL_ORDER, request);
  },

  /**
   * Trigger manual DB backup to S3
   */
  async triggerDbBackup(): Promise<TriggerDbBackupResponse> {
    return api.post<TriggerDbBackupResponse>(API_ENDPOINTS.V2_TESTING.TRIGGER_DB_BACKUP, {});
  },

  /**
   * Clear candle history (day/intraday/both) for a symbol from DB and cache
   */
  async clearCandlesHistory(request: ClearCandlesHistoryRequest): Promise<ClearCandlesHistoryResponse> {
    return api.post<ClearCandlesHistoryResponse>(API_ENDPOINTS.V2_TESTING.CLEAR_CANDLES_HISTORY, request);
  },
};
