/**
 * What the operator may do: everything.
 *
 * The engine this was copied from served many users behind a rights matrix --
 * a tool code per page, three levels per code, checked in about twenty
 * components. Garuda has one admin who owns every account on it, so every
 * check has the same answer.
 *
 * Kept as a hook rather than deleted at each call site so that the twenty
 * components read unchanged. **It is a shim, not a design.** The conditionals
 * it feeds are dead branches, and inlining them -- deleting the checks
 * outright -- is follow-up work tracked in `docs/PROGRESS.md`. What must not
 * happen is this quietly growing a second answer: if a page ever needs to be
 * hidden, hide it in the route table where an operator can see the decision.
 */

export interface PermissionCheck {
  canView: boolean;
  canEdit: boolean;
  canManage: boolean;
}

const EVERYTHING: PermissionCheck = { canView: true, canEdit: true, canManage: true };

export function usePermissions() {
  return {
    hasRight: () => true,
    getPermissions: (): PermissionCheck => EVERYTHING,
    isAdmin: true,
    isSysadmin: true,
    hasAnyAdminAccess: true,
  aiAssistant: EVERYTHING,
  alerts: EVERYTHING,
  algoBrokerCompare: EVERYTHING,
  allocationModels: EVERYTHING,
  analyticsBilling: EVERYTHING,
  analyticsBrokerPerf: EVERYTHING,
  analyticsCapital: EVERYTHING,
  analyticsStrategies: EVERYTHING,
  analyticsTrades: EVERYTHING,
  analyticsUserPerf: EVERYTHING,
  analyticsUsers: EVERYTHING,
  auditLogs: EVERYTHING,
  billingPlans: EVERYTHING,
  breakoutWatches: EVERYTHING,
  brokerConfig: EVERYTHING,
  brokers: EVERYTHING,
  email: EVERYTHING,
  eventDays: EVERYTHING,
  exchanges: EVERYTHING,
  faqs: EVERYTHING,
  holidays: EVERYTHING,
  instruments: EVERYTHING,
  licenses: EVERYTHING,
  margins: EVERYTHING,
  mockTrading: EVERYTHING,
  orders: EVERYTHING,
  pnlReports: EVERYTHING,
  positions: EVERYTHING,
  riskProfiles: EVERYTHING,
  rms: EVERYTHING,
  signalOut: EVERYTHING,
  signals: EVERYTHING,
  specialTradingDays: EVERYTHING,
  squareOff: EVERYTHING,
  strategyConfigs: EVERYTHING,
  strategyDefinitions: EVERYTHING,
  strategyEngine: EVERYTHING,
  strategyPolicies: EVERYTHING,
  strategySummaries: EVERYTHING,
  symbolConfig: EVERYTHING,
  systemConfig: EVERYTHING,
  testing: EVERYTHING,
  tradeLog: EVERYTHING,
  trades: EVERYTHING,
  tradingCharges: EVERYTHING,
  userBills: EVERYTHING,
  userBrokers: EVERYTHING,
  userNotes: EVERYTHING,
  userSubscriptions: EVERYTHING,
  users: EVERYTHING,
  } as const;
}
