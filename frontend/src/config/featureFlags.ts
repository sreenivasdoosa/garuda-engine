/**
 * Server-pushed runtime feature flags (same pattern as the runtime wsHost in env.ts):
 * configService.getServerConfig() publishes values here at app init, before any portal
 * page renders; pages read the getters synchronously.
 */

let clientSidePnl = false;

/** Published by configService.getServerConfig() — do not call from components. */
export function setClientSidePnl(enabled: boolean | undefined): void {
  clientSidePnl = enabled === true;
}

/**
 * Phase-2 flag (docs/USER_PORTAL_CLIENT_SIDE_PNL_DESIGN §8, Q10):
 * ON  -> user portal uses the client-side PnL engine (/me/live/* + WS events,
 *        no terminal-summary subscription, no details polling);
 * OFF -> legacy behavior, unchanged. OFF is the rollout default; flipping the
 *        instance's application.properties rolls back without a redeploy.
 */
export function isClientSidePnl(): boolean {
  return clientSidePnl;
}

let showTerminalPnlChart = false;

/** Published by configService.getServerConfig() — do not call from components. */
export function setShowTerminalPnlChart(enabled: boolean | undefined): void {
  showTerminalPnlChart = enabled === true;
}

/**
 * Show the intraday P&L chart on BOTH terminals (admin terminal + user portal). Server drives this
 * off `aggregated.pnl.snapshot.enabled` (the per-user snapshot writer) — the chart only has data to
 * plot when that writer is on, so visibility tracks it. OFF -> the chart button/tab is hidden.
 */
export function isShowTerminalPnlChart(): boolean {
  return showTerminalPnlChart;
}

// ---- AI assistant client hints (server config `ai` object) ----

let aiMaxQuestionChars = 2000;

/** Published by configService.getServerConfig() — do not call from components. */
export function setAiClientConfig(ai: { maxQuestionChars?: number } | undefined): void {
  if (ai?.maxQuestionChars && ai.maxQuestionChars > 0) {
    aiMaxQuestionChars = ai.maxQuestionChars;
  }
}

/**
 * Max characters for an AI chat question — mirrors the server's runtime
 * `ai.max.question.chars` (default 2000) so the input's maxLength tracks
 * System Config without a UI redeploy. The server independently enforces
 * the same limit on submit.
 */
export function getAiMaxQuestionChars(): number {
  return aiMaxQuestionChars;
}
