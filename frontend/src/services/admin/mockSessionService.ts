/**
 * Mock Session Service
 *
 * Admin-only API surface for the global mock-trading session toggle
 * (start/stop/status). Used to drive NSE/BSE weekend mock-session tests
 * without contaminating live trading data — see MockSessionManager on
 * the backend.
 */

import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { MockSessionStatus } from '@/types/strategy-engine';

export const mockSessionService = {
  /** Current state snapshot from MOCK_SESSION_STATE. */
  getStatus(): Promise<MockSessionStatus> {
    return api.get<MockSessionStatus>(API_ENDPOINTS.V2_ENGINE_MOCK.STATUS);
  },

  /**
   * Start a mock session. Idempotent — server returns the current state
   * if already active. Throws on 409 if a live market is currently open
   * or if no isMock-tagged active strategies exist.
   */
  start(): Promise<MockSessionStatus> {
    return api.post<MockSessionStatus>(API_ENDPOINTS.V2_ENGINE_MOCK.START, {});
  },

  /**
   * Stop the current mock session. Idempotent. Server-side this also
   * dispatches squareoff to all mock subscriptions and runs the
   * in-memory cleanup (Phase 4+).
   */
  stop(): Promise<MockSessionStatus> {
    return api.post<MockSessionStatus>(API_ENDPOINTS.V2_ENGINE_MOCK.STOP, {});
  },
};
