/**
 * AI analytics assistant types — v3 agentic investigation
 * (docs/AI_INTEGRATION_DESIGN.md §7.2): free-text questions, the server runs
 * a tool-use loop (SQL / alerts / logs / live state) and returns the answer
 * plus the investigation trace.
 */

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiAnalyzeRequest {
  question: string;
  history: AiChatMessage[];
  deep: boolean;
  conversationId: string;
}

/** Submit response — the turn is processed asynchronously; poll the result. */
export interface AiAnalyzeSubmitResponse {
  requestId: number;
  status: 'PENDING';
}

export type AiResultStatus = 'PENDING' | 'OK' | 'ERROR' | 'RATE_LIMITED';

/** One step of the investigation (a tool call the model made). */
export interface AiTraceStep {
  tool: string;
  summary: string;
  detail: string | null;
  error: boolean;
}

export interface AiResult {
  requestId: number;
  status: AiResultStatus;
  analysis: string | null;
  errorMessage: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  steps: number;
  trace: AiTraceStep[] | null;
}

export interface AiUsage {
  enabled: boolean;
  /** ai.deep.analysis.enabled — gates the Deep Analysis toggle (also enforced server-side). */
  deepAnalysisEnabled: boolean;
  requestsUsedToday: number;
  requestLimitPerDay: number;
  tokensUsedToday: number;
  dailyTokenBudget: number;
}
