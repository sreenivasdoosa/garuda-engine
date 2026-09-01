/**
 * Corporate Actions Service — equity splits & bonuses (admin only).
 * API service for the corporate-actions subsystem (docs/CORPORATE_ACTIONS_DESIGN.md).
 * Backed by CorporateActionServletV2 at /api/v2/corporate-actions.
 *
 * Lifecycle (C13): PENDING → APPROVED → APPLIED, or CANCELLED. Approved actions
 * auto-apply pre-market on the ex-date; a PENDING action whose ex-date has arrived
 * freezes the symbol (no new entries, no algo exits) until approved or cancelled.
 */

import { api } from '@/api/client';

const BASE = '/api/v2/corporate-actions';

export type CorporateActionType = 'SPLIT' | 'BONUS';
export type CorporateActionStatus = 'PENDING' | 'APPROVED' | 'APPLIED' | 'CANCELLED';

export interface CorporateAction {
  id: number;
  exchange: string;
  tradingSymbol: string;
  actionType: CorporateActionType;
  /** SPLIT: old face value; BONUS: new shares (A). */
  ratioFrom: number;
  /** SPLIT: new face value; BONUS: per shares held (B). */
  ratioTo: number;
  /** Quantity multiplier — SPLIT: from/to; BONUS: (A+B)/B. Prices divide by the same factor. */
  qtyFactor: number;
  /** yyyy-MM-dd */
  exDate: string;
  /** yyyy-MM-dd */
  recordDate?: string | null;
  status: CorporateActionStatus;
  source?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  /** epoch ms */
  createdAt?: number | null;
  approvedBy?: string | null;
  /** epoch ms */
  approvedAt?: number | null;
  /** epoch ms */
  appliedAt?: number | null;
  /** Human summary, e.g. "SPLIT FV 10→2 (×5)". */
  description: string;
  /** Trades already adjusted (journal count). */
  appliedTradeCount: number;
  /** Open trades on the symbol right now — the blast radius of approving. */
  openTradeCount: number;
  /** true = PENDING past its ex-date → live trading on the symbol is halted (C13 fallback). */
  frozen: boolean;
}

/** Trade fields captured in the journal's pre/post snapshots (all numeric). */
export interface CorporateActionSnapshot {
  entry?: number;
  requestedEntry?: number;
  exit?: number;
  cmp?: number;
  quantity?: number;
  requestedQuantity?: number;
  filledQuantity?: number;
  stopLoss?: number;
  initialStopLoss?: number;
  target?: number;
  caFactor?: number;
  [field: string]: number | undefined;
}

export interface CorporateActionJournalEntry {
  id: number;
  corporateActionId: number;
  tradeId: string;
  username: string;
  broker: string;
  product?: string | null;
  qtyFactor: number;
  preSnapshot?: CorporateActionSnapshot | null;
  postSnapshot?: CorporateActionSnapshot | null;
  /** Fractional shares dropped by flooring qty × factor (non-zero needs manual credit). */
  qtyResidue: number;
  /** 'PENDING_CREDIT' (bonus shares not yet in demat) | 'CREDITED' | null (splits). */
  creditStatus?: string | null;
  /** epoch ms */
  appliedAt?: number | null;
}

export interface CreateCorporateActionRequest {
  exchange?: string;
  symbol: string;
  actionType: CorporateActionType;
  ratioFrom: number;
  ratioTo: number;
  /** yyyy-MM-dd (required) */
  exDate: string;
  /** yyyy-MM-dd */
  recordDate?: string;
  notes?: string;
}

export const corporateActionService = {
  // List actions (all statuses by default; pass a status to filter server-side)
  async list(status?: CorporateActionStatus): Promise<CorporateAction[]> {
    return api.get<CorporateAction[]>(BASE, status ? { status } : undefined);
  },

  // Per-trade application journal for one action
  async getJournal(id: number): Promise<CorporateActionJournalEntry[]> {
    return api.get<CorporateActionJournalEntry[]>(`${BASE}/${id}/journal`);
  },

  // Schedule a new action (created PENDING — approve it before the ex-date)
  async create(data: CreateCorporateActionRequest): Promise<CorporateAction> {
    return api.post<CorporateAction>(BASE, data);
  },

  // Approve (auto-applies immediately if the ex-date has already arrived — check returned status)
  async approve(id: number): Promise<CorporateAction> {
    return api.post<CorporateAction>(`${BASE}/${id}/approve`);
  },

  // Cancel a pending/approved action
  async cancel(id: number): Promise<CorporateAction> {
    return api.post<CorporateAction>(`${BASE}/${id}/cancel`);
  },

  // Re-run an APPROVED/APPLIED action now (idempotent per trade via the journal)
  async applyNow(id: number): Promise<{ adjustedTrades: number }> {
    return api.post<{ adjustedTrades: number }>(`${BASE}/${id}/apply`);
  },

  // Mechanical undo of one trade application from its pre-snapshot
  async reverseJournalEntry(journalId: number): Promise<void> {
    return api.post<void>(`${BASE}/journal/${journalId}/reverse`);
  },
};

export default corporateActionService;
