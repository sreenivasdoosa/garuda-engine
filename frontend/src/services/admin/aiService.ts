/**
 * AI analytics assistant API — v3 agentic (docs/AI_INTEGRATION_DESIGN.md §7.2).
 */

import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  AiAnalyzeRequest,
  AiAnalyzeSubmitResponse,
  AiResult,
  AiUsage,
} from '@/types/ai';

/** Poll cadence + cap: 2.5s × 240 = 10 minutes, matching the server's abandonment window. */
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_ATTEMPTS = 240;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const aiService = {
  /** Submit is async — returns immediately with a requestId; see analyzeAndWait. */
  async analyze(request: AiAnalyzeRequest): Promise<AiAnalyzeSubmitResponse> {
    return api.post<AiAnalyzeSubmitResponse>(API_ENDPOINTS.V2_AI.ANALYZE, request);
  },

  async getResult(requestId: number): Promise<AiResult> {
    return api.get<AiResult>(API_ENDPOINTS.V2_AI.RESULT(requestId));
  },

  /**
   * Submit + poll until terminal. Investigations can take minutes (the
   * server runs a multi-step tool loop) — each poll is a short independent
   * request instead of one long-held connection.
   */
  async analyzeAndWait(request: AiAnalyzeRequest): Promise<AiResult> {
    const { requestId } = await this.analyze(request);
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS);
      const result = await this.getResult(requestId);
      if (result.status !== 'PENDING') {
        return result;
      }
    }
    throw new Error('AI analysis timed out — please try again');
  },

  async getUsage(): Promise<AiUsage> {
    return api.get<AiUsage>(API_ENDPOINTS.V2_AI.USAGE);
  },
};
