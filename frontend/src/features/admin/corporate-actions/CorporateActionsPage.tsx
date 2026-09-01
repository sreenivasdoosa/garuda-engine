/**
 * CorporateActionsPage - Admin page for equity corporate actions (splits & bonuses).
 *
 * Lifecycle (docs/CORPORATE_ACTIONS_DESIGN.md C13): PENDING → APPROVED → APPLIED, or CANCELLED.
 * - Approvals view (default): PENDING actions by ex-date ascending — the admin reviews the ratio
 *   and the open-trade blast radius, then approves (auto-applies pre-market on the ex-date, or
 *   immediately if the ex-date already arrived) or cancels. A PENDING action past its ex-date
 *   FREEZES the symbol (no new entries, no algo exits) until resolved.
 * - All Actions view: full calendar with status filter, per-action journal drill-down
 *   (pre → post snapshots per trade) and apply-now / reverse for admins.
 *
 * Backed by CorporateActionServletV2 at /api/v2/corporate-actions (Resource.SYSTEM_CONFIG, admin-only).
 */

import { Fragment, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BsSignpostSplit,
  BsArrowClockwise,
  BsPlus,
  BsCheckCircle,
  BsXCircle,
  BsChevronDown,
  BsChevronRight,
  BsExclamationTriangle,
  BsPlayCircle,
  BsArrowCounterclockwise,
} from 'react-icons/bs';
import { toast } from 'react-toastify';
import clsx from 'clsx';

import { PageHeader } from '@/components/common';
import { usePermissions } from '@/hooks/usePermissions';
import { Badge, Button, Spinner, Modal } from '@/components/ui';
import type { Tone } from '@/components/ui';
import {
  corporateActionService,
  type CorporateAction,
  type CorporateActionJournalEntry,
  type CorporateActionStatus,
  type CorporateActionType,
} from '@/services/admin/corporateActionService';

const ctrl = 'w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:opacity-60';
const label = 'mb-1 flex items-center text-sm font-medium text-ink';
const help = 'mt-1 block text-xs text-ink-soft';
const cell = 'px-3 py-2';
const panel = 'rounded bg-raised p-3';

const STATUS_TONES: Record<CorporateActionStatus, Tone> = {
  PENDING: 'warning',
  APPROVED: 'blue',
  APPLIED: 'success',
  CANCELLED: 'neutral',
};

const StatusBadge: React.FC<{ status: CorporateActionStatus }> = ({ status }) => (
  <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{status}</Badge>
);

/** Trim a factor to a compact human string (5 → "5", 1.3333… → "1.33"). */
const fmtFactor = (f: number): string =>
  Number.isFinite(f) && f > 0 ? (Number.isInteger(f) ? String(f) : f.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')) : '—';

const fmtNum = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toLocaleString('en-IN');

const fmtEpoch = (ms?: number | null): string => (ms ? new Date(ms).toLocaleString('en-IN') : '—');

/** Whole days from today (local midnight) to the ex-date. 0 = today, negative = past. */
const daysUntil = (exDate: string): number => {
  const [y, m, d] = exDate.split('-').map(Number);
  const target = new Date(y, (m || 1) - 1, d || 1).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86400000);
};

const DaysUntil: React.FC<{ exDate: string }> = ({ exDate }) => {
  const days = daysUntil(exDate);
  if (days < 0) return <span className="font-medium text-danger-600 dark:text-danger-400">{-days}d overdue</span>;
  if (days === 0) return <span className="font-medium text-danger-600 dark:text-danger-400">Today</span>;
  if (days <= 2) return <span className="font-medium text-warning-700 dark:text-warning-400">{days} day{days === 1 ? '' : 's'}</span>;
  return <span className="text-ink">{days} days</span>;
};

/** Ratio + computed-factor summary, e.g. "FV 10→2 ⇒ ×5" or "1:1 ⇒ ×2". */
const ratioText = (a: CorporateAction): string =>
  a.actionType === 'SPLIT'
    ? `FV ${fmtFactor(a.ratioFrom)}→${fmtFactor(a.ratioTo)} ⇒ ×${fmtFactor(a.qtyFactor)}`
    : `${fmtFactor(a.ratioFrom)}:${fmtFactor(a.ratioTo)} ⇒ ×${fmtFactor(a.qtyFactor)}`;

const STATUS_FILTERS: Array<'ALL' | CorporateActionStatus> = ['ALL', 'PENDING', 'APPROVED', 'APPLIED', 'CANCELLED'];

// ==================== create form ====================

interface CreateFormState {
  exchange: string;
  symbol: string;
  actionType: CorporateActionType;
  ratioFrom: string;
  ratioTo: string;
  exDate: string;
  recordDate: string;
  notes: string;
}

const emptyForm = (): CreateFormState => ({
  exchange: 'NSE',
  symbol: '',
  actionType: 'SPLIT',
  ratioFrom: '',
  ratioTo: '',
  exDate: '',
  recordDate: '',
  notes: '',
});

/** Quantity factor from the form ratio — SPLIT: from/to; BONUS: (A+B)/B. NaN when incomplete. */
const formFactor = (f: CreateFormState): number => {
  const from = parseFloat(f.ratioFrom);
  const to = parseFloat(f.ratioTo);
  if (!(from > 0) || !(to > 0)) return NaN;
  return f.actionType === 'SPLIT' ? from / to : (from + to) / to;
};

// ==================== journal drill-down ====================

const JournalTable: React.FC<{
  action: CorporateAction;
  canManage: boolean;
  onReverse: (entry: CorporateActionJournalEntry) => void;
}> = ({ action, canManage, onReverse }) => {
  const { data: journal = [], isLoading, error } = useQuery({
    queryKey: ['corporate-actions', action.id, 'journal'],
    queryFn: () => corporateActionService.getJournal(action.id),
  });

  if (isLoading) {
    return (
      <div className="py-4 text-center">
        <Spinner size="sm" className="text-primary-500" /> <span className="text-sm text-ink-soft">Loading journal...</span>
      </div>
    );
  }
  if (error) {
    return <div className="py-3 text-sm text-danger-600 dark:text-danger-400">Failed to load journal: {(error as Error).message}</div>;
  }
  if (journal.length === 0) {
    return <div className="py-3 text-sm text-ink-soft">No trades adjusted by this action yet.</div>;
  }

  const preTo = (e: CorporateActionJournalEntry, field: string) =>
    `${fmtNum(e.preSnapshot?.[field])} → ${fmtNum(e.postSnapshot?.[field])}`;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
        <thead className="text-xs uppercase text-ink-faint">
          <tr>
            <th className={`${cell} text-left`}>Trade</th>
            <th className={`${cell} text-left`}>User</th>
            <th className={`${cell} text-left`}>Broker</th>
            <th className={`${cell} text-left`}>Product</th>
            <th className={`${cell} text-right`}>Factor</th>
            <th className={`${cell} text-right`}>Entry (pre → post)</th>
            <th className={`${cell} text-right`}>Filled Qty (pre → post)</th>
            <th className={`${cell} text-right`}>Residue</th>
            <th className={`${cell} text-left`}>Credit</th>
            <th className={`${cell} text-left`}>Applied At</th>
            <th className={`${cell} text-right`}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {journal.map((e) => (
            <tr key={e.id}>
              <td className={cell}><code className="text-xs text-ink">{e.tradeId}</code></td>
              <td className={`${cell} text-ink`}>{e.username}</td>
              <td className={cell}><Badge tone="neutral">{e.broker}</Badge></td>
              <td className={`${cell} text-ink-soft`}>{e.product || '—'}</td>
              <td className={`${cell} text-right text-ink`}>×{fmtFactor(e.qtyFactor)}</td>
              <td className={`${cell} text-right text-ink`}>{preTo(e, 'entry')}</td>
              <td className={`${cell} text-right text-ink`}>{preTo(e, 'filledQuantity')}</td>
              <td className={`${cell} text-right`}>
                {e.qtyResidue ? (
                  <span className="font-medium text-warning-700 dark:text-warning-400">{fmtNum(e.qtyResidue)}</span>
                ) : (
                  <span className="text-ink-faint">0</span>
                )}
              </td>
              <td className={cell}>
                {e.creditStatus === 'PENDING_CREDIT' ? (
                  <Badge tone="warning">Awaiting demat credit</Badge>
                ) : e.creditStatus === 'CREDITED' ? (
                  <Badge tone="success">Credited</Badge>
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </td>
              <td className={`${cell} text-ink-soft`}>{fmtEpoch(e.appliedAt)}</td>
              <td className={`${cell} text-right`}>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={!canManage}
                  title={canManage ? 'Reverse this trade back to its pre-snapshot' : 'Requires manage permission'}
                  onClick={() => onReverse(e)}
                >
                  <BsArrowCounterclockwise /> Reverse
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ==================== page ====================

const CorporateActionsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const canManage = permissions.systemConfig.canManage;
  const manageTitle = canManage ? undefined : 'Requires manage permission';

  const [activeTab, setActiveTab] = useState<'approvals' | 'all'>('approvals');
  const [statusFilter, setStatusFilter] = useState<'ALL' | CorporateActionStatus>('ALL');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Confirmation targets (one modal each)
  const [approveTarget, setApproveTarget] = useState<CorporateAction | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CorporateAction | null>(null);
  const [applyTarget, setApplyTarget] = useState<CorporateAction | null>(null);
  const [reverseTarget, setReverseTarget] = useState<CorporateActionJournalEntry | null>(null);

  // Create form
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [form, setForm] = useState<CreateFormState>(emptyForm());
  const setField = <K extends keyof CreateFormState>(key: K, value: CreateFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const { data: actions = [], isLoading, error, refetch } = useQuery({
    queryKey: ['corporate-actions'],
    queryFn: () => corporateActionService.list(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['corporate-actions'] });
  };

  const pendingActions = useMemo(
    () =>
      actions
        .filter((a) => a.status === 'PENDING')
        .sort((a, b) => a.exDate.localeCompare(b.exDate)),
    [actions],
  );
  const frozenCount = pendingActions.filter((a) => a.frozen).length;

  const allActions = useMemo(
    () =>
      actions
        .filter((a) => statusFilter === 'ALL' || a.status === statusFilter)
        .sort((a, b) => b.exDate.localeCompare(a.exDate)),
    [actions, statusFilter],
  );

  // ==================== mutations ====================

  const approveMutation = useMutation({
    mutationFn: (id: number) => corporateActionService.approve(id),
    onSuccess: (ca) => {
      invalidate();
      toast.success(
        ca.status === 'APPLIED'
          ? 'Approved and applied (ex-date had already arrived)'
          : 'Approved — will auto-apply pre-market on the ex-date',
      );
      setApproveTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to approve corporate action'),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: number) => corporateActionService.cancel(id),
    onSuccess: () => {
      invalidate();
      toast.success('Corporate action cancelled');
      setCancelTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to cancel corporate action'),
  });

  const applyMutation = useMutation({
    mutationFn: (id: number) => corporateActionService.applyNow(id),
    onSuccess: (res) => {
      invalidate();
      toast.success(`Apply run complete — ${res.adjustedTrades} trade(s) adjusted`);
      setApplyTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to apply corporate action'),
  });

  const reverseMutation = useMutation({
    mutationFn: (journalId: number) => corporateActionService.reverseJournalEntry(journalId),
    onSuccess: (_res, journalId) => {
      const actionId = reverseTarget?.corporateActionId;
      invalidate();
      if (actionId) queryClient.invalidateQueries({ queryKey: ['corporate-actions', actionId, 'journal'] });
      toast.success(`Trade application reversed from its pre-snapshot (journal #${journalId})`);
      setReverseTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to reverse trade application'),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      corporateActionService.create({
        exchange: form.exchange.trim() || 'NSE',
        symbol: form.symbol.trim().toUpperCase(),
        actionType: form.actionType,
        ratioFrom: parseFloat(form.ratioFrom),
        ratioTo: parseFloat(form.ratioTo),
        exDate: form.exDate,
        recordDate: form.recordDate || undefined,
        notes: form.notes.trim() || undefined,
      }),
    onSuccess: () => {
      invalidate();
      toast.success('Corporate action scheduled (PENDING) — approve it before the ex-date');
      setShowCreateModal(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to schedule corporate action'),
  });

  // ==================== create form validation ====================

  const factor = formFactor(form);
  const isSplit = form.actionType === 'SPLIT';

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.symbol.trim()) { toast.error('Symbol is required'); return; }
    const from = parseFloat(form.ratioFrom);
    const to = parseFloat(form.ratioTo);
    if (!(from > 0) || !(to > 0)) {
      toast.error(isSplit ? 'Old and new face value must be positive' : 'A and B must be positive');
      return;
    }
    if (isSplit && from <= to) {
      toast.error('A split must reduce the face value (old > new)');
      return;
    }
    if (!form.exDate) { toast.error('Ex-date is required'); return; }
    if (form.recordDate && form.recordDate < form.exDate) {
      toast.error('Record date cannot be before the ex-date');
      return;
    }
    createMutation.mutate();
  };

  const handleOpenCreate = () => {
    setForm(emptyForm());
    setShowCreateModal(true);
  };

  // ==================== row actions ====================

  const rowButtons = (a: CorporateAction) => (
    <div className="flex justify-end gap-1">
      {a.status === 'PENDING' && (
        <Button variant="primary" size="sm" disabled={!canManage} title={manageTitle} onClick={() => setApproveTarget(a)}>
          <BsCheckCircle /> Approve
        </Button>
      )}
      {(a.status === 'PENDING' || a.status === 'APPROVED') && (
        <Button variant="secondary" size="sm" disabled={!canManage} title={manageTitle} onClick={() => setCancelTarget(a)}>
          <BsXCircle /> Cancel
        </Button>
      )}
      {(a.status === 'APPROVED' || a.status === 'APPLIED') && (
        <Button variant="warning" size="sm" disabled={!canManage} title={manageTitle ?? (a.status === 'APPLIED' ? 'Re-run (already-adjusted trades are skipped via the journal)' : 'Apply to open trades now')} onClick={() => setApplyTarget(a)}>
          <BsPlayCircle /> Apply Now
        </Button>
      )}
    </div>
  );

  // ==================== render ====================

  if (error) {
    return (
      <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">
        Failed to load corporate actions: {(error as Error).message}
      </div>
    );
  }

  return (
    <div className="fade-in">
      <PageHeader
        title="Corporate Actions"
        subtitle="Equity splits & bonuses — approve scheduled actions before the ex-date; unapproved actions freeze the symbol"
        icon={<BsSignpostSplit />}
        actions={
          <>
            <Button variant="secondary" onClick={() => refetch()} title="Refresh">
              <BsArrowClockwise />
            </Button>
            {canManage && (
              <Button variant="primary" onClick={handleOpenCreate}>
                <BsPlus /> Schedule Action
              </Button>
            )}
          </>
        }
      />

      {frozenCount > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">
          <BsExclamationTriangle />
          <span>
            <strong>{frozenCount} symbol{frozenCount === 1 ? ' is' : 's are'} FROZEN</strong> — the ex-date arrived with the
            action still pending. No new entries and no algo exits on frozen symbols until you approve or cancel.
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-3 flex flex-wrap gap-1 border-b border-hairline">
        {([
          { key: 'approvals' as const, label: `Approvals (${pendingActions.length})` },
          { key: 'all' as const, label: 'All Actions' },
        ]).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={clsx(
              '-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              activeTab === t.key ? 'border-primary-500 text-primary-500' : 'border-transparent text-ink-soft hover:text-ink',
            )}
          >
            {t.label}
            {t.key === 'approvals' && frozenCount > 0 && <Badge tone="danger">{frozenCount} frozen</Badge>}
          </button>
        ))}
      </div>

      <div className="rounded-card border border-hairline bg-card">
        {isLoading ? (
          <div className="py-10 text-center">
            <Spinner className="text-primary-500" />
            <p className="mt-2 text-ink-soft">Loading corporate actions...</p>
          </div>
        ) : activeTab === 'approvals' ? (
          /* ==================== Approvals (PENDING, ex-date ascending) ==================== */
          pendingActions.length === 0 ? (
            <div className="py-10 text-center text-ink-soft">
              No corporate actions awaiting approval. Use <strong>Schedule Action</strong> to add an upcoming split or bonus.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                <thead className="bg-raised text-xs uppercase text-ink-faint">
                  <tr>
                    <th className={`${cell} text-left`}>Symbol</th>
                    <th className={`${cell} text-left`}>Type</th>
                    <th className={`${cell} text-left`}>Ratio</th>
                    <th className={`${cell} text-left`}>Ex-Date</th>
                    <th className={`${cell} text-left`}>Days Left</th>
                    <th className={`${cell} text-right`}>Open Trades</th>
                    <th className={`${cell} text-left`}>Source</th>
                    <th className={`${cell} text-right`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingActions.map((a) => (
                    <tr key={a.id} className={clsx('hover:bg-raised/50', a.frozen && 'bg-danger-500/10')}>
                      <td className={cell}>
                        <span className="font-medium text-ink">{a.tradingSymbol}</span>
                        <span className="ms-1 text-xs text-ink-faint">{a.exchange}</span>
                        {a.frozen && <Badge tone="danger" className="ms-2" icon={<BsExclamationTriangle />}>FROZEN</Badge>}
                      </td>
                      <td className={cell}>
                        <Badge tone={a.actionType === 'SPLIT' ? 'primary' : 'info'}>{a.actionType}</Badge>
                      </td>
                      <td className={cell}>
                        <span className="text-ink">{ratioText(a)}</span>
                        <span className={help}>{a.description}</span>
                      </td>
                      <td className={`${cell} text-ink`}>{a.exDate}</td>
                      <td className={cell}><DaysUntil exDate={a.exDate} /></td>
                      <td className={`${cell} text-right`}>
                        <span className={clsx('font-medium', a.openTradeCount > 0 ? 'text-warning-700 dark:text-warning-400' : 'text-ink-soft')}>
                          {a.openTradeCount}
                        </span>
                      </td>
                      <td className={`${cell} text-ink-soft`}>{a.source || '—'}</td>
                      <td className={`${cell} text-right`}>{rowButtons(a)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          /* ==================== All Actions (full calendar + journal drill-down) ==================== */
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline p-3">
              <h6 className="mb-0 font-semibold text-ink">All Actions ({allActions.length})</h6>
              <div style={{ width: 180 }}>
                <select
                  className={ctrl}
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'ALL' | CorporateActionStatus)}
                  aria-label="Filter by status"
                >
                  {STATUS_FILTERS.map((s) => (
                    <option key={s} value={s}>{s === 'ALL' ? 'All statuses' : s}</option>
                  ))}
                </select>
              </div>
            </div>
            {allActions.length === 0 ? (
              <div className="py-10 text-center text-ink-soft">
                {statusFilter === 'ALL' ? 'No corporate actions recorded yet.' : `No ${statusFilter} corporate actions.`}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                  <thead className="bg-raised text-xs uppercase text-ink-faint">
                    <tr>
                      <th className={`${cell} w-8`} aria-label="Expand" />
                      <th className={`${cell} text-left`}>Symbol</th>
                      <th className={`${cell} text-left`}>Type</th>
                      <th className={`${cell} text-left`}>Ratio</th>
                      <th className={`${cell} text-left`}>Ex-Date</th>
                      <th className={`${cell} text-left`}>Status</th>
                      <th className={`${cell} text-right`}>Applied Trades</th>
                      <th className={`${cell} text-left`}>Approved / Applied</th>
                      <th className={`${cell} text-left`}>Source</th>
                      <th className={`${cell} text-right`}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allActions.map((a) => (
                      <Fragment key={a.id}>
                        <tr className={clsx('hover:bg-raised/50', a.frozen && 'bg-danger-500/10')}>
                          <td className={cell}>
                            <button
                              type="button"
                              className="text-ink-soft hover:text-ink"
                              title={expandedId === a.id ? 'Hide journal' : 'Show application journal'}
                              aria-label={expandedId === a.id ? 'Hide journal' : 'Show application journal'}
                              onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
                            >
                              {expandedId === a.id ? <BsChevronDown /> : <BsChevronRight />}
                            </button>
                          </td>
                          <td className={cell}>
                            <span className="font-medium text-ink">{a.tradingSymbol}</span>
                            <span className="ms-1 text-xs text-ink-faint">{a.exchange}</span>
                            {a.frozen && <Badge tone="danger" className="ms-2" icon={<BsExclamationTriangle />}>FROZEN</Badge>}
                          </td>
                          <td className={cell}>
                            <Badge tone={a.actionType === 'SPLIT' ? 'primary' : 'info'}>{a.actionType}</Badge>
                          </td>
                          <td className={cell}>
                            <span className="text-ink">{ratioText(a)}</span>
                            {a.notes && <span className={help}>{a.notes}</span>}
                          </td>
                          <td className={`${cell} text-ink`}>{a.exDate}</td>
                          <td className={cell}><StatusBadge status={a.status} /></td>
                          <td className={`${cell} text-right text-ink`}>{a.appliedTradeCount}</td>
                          <td className={`${cell} text-xs text-ink-soft`}>
                            {a.approvedBy ? <div>by {a.approvedBy} · {fmtEpoch(a.approvedAt)}</div> : <div>—</div>}
                            {a.appliedAt ? <div>applied {fmtEpoch(a.appliedAt)}</div> : null}
                          </td>
                          <td className={`${cell} text-ink-soft`}>{a.source || '—'}</td>
                          <td className={`${cell} text-right`}>{rowButtons(a)}</td>
                        </tr>
                        {expandedId === a.id && (
                          <tr>
                            <td colSpan={10} className="bg-raised/40 px-4 py-3">
                              <div className="mb-1 text-xs font-medium uppercase text-ink-faint">
                                Application journal — {a.description}
                              </div>
                              <JournalTable action={a} canManage={canManage} onReverse={setReverseTarget} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* ==================== Approve confirmation ==================== */}
      <Modal
        open={approveTarget !== null}
        onClose={() => setApproveTarget(null)}
        title={<span className="flex items-center gap-2"><BsCheckCircle className="text-success-500" /> Approve Corporate Action</span>}
        footer={
          <>
            <Button variant="secondary" onClick={() => setApproveTarget(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => approveTarget && approveMutation.mutate(approveTarget.id)}
              disabled={approveMutation.isPending}
            >
              {approveMutation.isPending ? <><Spinner size="sm" /> Approving...</> : 'Approve'}
            </Button>
          </>
        }
      >
        {approveTarget && (
          <>
            {approveTarget.frozen && (
              <div className="mb-3 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">
                <strong>{approveTarget.tradingSymbol} is FROZEN</strong> — the ex-date has arrived. Approving applies the
                adjustment <strong>immediately</strong> and unfreezes the symbol.
              </div>
            )}
            <div className={panel}>
              <p className="mb-1 text-ink"><strong>{approveTarget.tradingSymbol}</strong> ({approveTarget.exchange}) — {approveTarget.description}</p>
              <p className="mb-1 text-sm text-ink">Ex-date: <strong>{approveTarget.exDate}</strong> (<DaysUntil exDate={approveTarget.exDate} />)</p>
              <p className="mb-0 text-sm text-ink">
                Open trades that will be adjusted: <strong>{approveTarget.openTradeCount}</strong>
              </p>
            </div>
            <p className="m-0 mt-3 text-sm text-ink-soft">
              Quantities multiply and prices divide by <strong>×{fmtFactor(approveTarget.qtyFactor)}</strong>. The action
              auto-applies pre-market on the ex-date (or immediately if the ex-date has already arrived).
            </p>
          </>
        )}
      </Modal>

      {/* ==================== Cancel confirmation ==================== */}
      <Modal
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        title={<span className="flex items-center gap-2 text-danger-500"><BsXCircle /> Cancel Corporate Action</span>}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelTarget(null)}>Keep It</Button>
            <Button
              variant="danger"
              onClick={() => cancelTarget && cancelMutation.mutate(cancelTarget.id)}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? <><Spinner size="sm" /> Cancelling...</> : 'Cancel Action'}
            </Button>
          </>
        }
      >
        {cancelTarget && (
          <>
            <div className="mb-3 rounded border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-ink">
              Cancel <strong>{cancelTarget.tradingSymbol}</strong> — {cancelTarget.description} (ex-date {cancelTarget.exDate})?
            </div>
            <p className="m-0 text-sm text-ink-soft">
              No adjustment will run for this action{cancelTarget.frozen ? ' and the symbol will be unfrozen' : ''}. Only cancel
              if the corporate action was entered wrongly or was withdrawn by the exchange.
            </p>
          </>
        )}
      </Modal>

      {/* ==================== Apply-now confirmation ==================== */}
      <Modal
        open={applyTarget !== null}
        onClose={() => setApplyTarget(null)}
        title={<span className="flex items-center gap-2"><BsPlayCircle className="text-warning-500" /> Apply Corporate Action Now</span>}
        footer={
          <>
            <Button variant="secondary" onClick={() => setApplyTarget(null)}>Cancel</Button>
            <Button
              variant="warning"
              onClick={() => applyTarget && applyMutation.mutate(applyTarget.id)}
              disabled={applyMutation.isPending}
            >
              {applyMutation.isPending ? <><Spinner size="sm" /> Applying...</> : 'Apply Now'}
            </Button>
          </>
        }
      >
        {applyTarget && (
          <>
            <div className="mb-3 rounded border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-ink">
              Run <strong>{applyTarget.tradingSymbol}</strong> — {applyTarget.description} against open trades now?
            </div>
            <p className="m-0 text-sm text-ink-soft">
              Each open trade is adjusted once — trades already in this action&apos;s journal are skipped, so re-running is
              safe. {applyTarget.appliedTradeCount > 0 && <>Already applied to <strong>{applyTarget.appliedTradeCount}</strong> trade(s).</>}
            </p>
          </>
        )}
      </Modal>

      {/* ==================== Reverse confirmation ==================== */}
      <Modal
        open={reverseTarget !== null}
        onClose={() => setReverseTarget(null)}
        title={<span className="flex items-center gap-2 text-danger-500"><BsArrowCounterclockwise /> Reverse Trade Application</span>}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReverseTarget(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => reverseTarget && reverseMutation.mutate(reverseTarget.id)}
              disabled={reverseMutation.isPending}
            >
              {reverseMutation.isPending ? <><Spinner size="sm" /> Reversing...</> : 'Reverse Application'}
            </Button>
          </>
        }
      >
        {reverseTarget && (
          <>
            <div className="mb-3 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">
              <strong>This is a mechanical undo.</strong> The trade is restored exactly to its pre-adjustment snapshot —
              quantities, prices, stop-loss and target all revert. Use only to correct a wrongly-applied action.
            </div>
            <div className={panel}>
              <p className="mb-1 text-ink">Trade <code className="text-xs">{reverseTarget.tradeId}</code></p>
              <p className="mb-1 text-sm text-ink">{reverseTarget.username} · {reverseTarget.broker}{reverseTarget.product ? ` · ${reverseTarget.product}` : ''}</p>
              <p className="mb-0 text-sm text-ink">
                Reverts factor ×{fmtFactor(reverseTarget.qtyFactor)} — filled qty {fmtNum(reverseTarget.postSnapshot?.filledQuantity)} → {fmtNum(reverseTarget.preSnapshot?.filledQuantity)},
                entry {fmtNum(reverseTarget.postSnapshot?.entry)} → {fmtNum(reverseTarget.preSnapshot?.entry)}
              </p>
            </div>
          </>
        )}
      </Modal>

      {/* ==================== Schedule Action (create) ==================== */}
      <Modal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        size="lg"
        title={<span className="flex items-center gap-2"><BsSignpostSplit /> Schedule Corporate Action</span>}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreateModal(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="corporate-action-form" disabled={createMutation.isPending}>
              {createMutation.isPending ? <><Spinner size="sm" /> Scheduling...</> : 'Schedule (PENDING)'}
            </Button>
          </>
        }
      >
        <form id="corporate-action-form" onSubmit={handleCreateSubmit}>
          <div className="mb-3 flex flex-wrap gap-4">
            <div style={{ width: 140 }}>
              <label className={label}>Exchange</label>
              <input type="text" className={ctrl} value={form.exchange} onChange={(e) => setField('exchange', e.target.value.toUpperCase())} />
            </div>
            <div className="min-w-[200px] flex-1">
              <label className={label}>Symbol <span className="text-danger-500">*</span></label>
              <input
                type="text"
                className={ctrl}
                value={form.symbol}
                onChange={(e) => setField('symbol', e.target.value.toUpperCase())}
                required
                placeholder="e.g. RELIANCE"
              />
            </div>
            <div style={{ width: 160 }}>
              <label className={label}>Action Type</label>
              <select className={ctrl} value={form.actionType} onChange={(e) => setField('actionType', e.target.value as CorporateActionType)}>
                <option value="SPLIT">SPLIT</option>
                <option value="BONUS">BONUS</option>
              </select>
            </div>
          </div>

          <div className="mb-3 flex flex-wrap gap-4">
            <div style={{ width: 200 }}>
              <label className={label}>{isSplit ? 'Old face value' : 'New shares (A)'} <span className="text-danger-500">*</span></label>
              <input
                type="number"
                className={ctrl}
                value={form.ratioFrom}
                onChange={(e) => setField('ratioFrom', e.target.value)}
                min="0"
                step="any"
                required
                placeholder={isSplit ? 'e.g. 10' : 'e.g. 1'}
              />
            </div>
            <div style={{ width: 200 }}>
              <label className={label}>{isSplit ? 'New face value' : 'Per shares held (B)'} <span className="text-danger-500">*</span></label>
              <input
                type="number"
                className={ctrl}
                value={form.ratioTo}
                onChange={(e) => setField('ratioTo', e.target.value)}
                min="0"
                step="any"
                required
                placeholder={isSplit ? 'e.g. 2' : 'e.g. 1'}
              />
            </div>
            <div className="min-w-[220px] flex-1 self-end">
              {Number.isFinite(factor) ? (
                <div className="rounded border border-primary-500/30 bg-primary-500/10 px-3 py-2 text-sm text-ink">
                  {isSplit
                    ? <>FV {fmtFactor(parseFloat(form.ratioFrom))}→{fmtFactor(parseFloat(form.ratioTo))} ⇒ <strong>×{fmtFactor(factor)}</strong></>
                    : <>{fmtFactor(parseFloat(form.ratioFrom))}:{fmtFactor(parseFloat(form.ratioTo))} ⇒ <strong>×{fmtFactor(factor)}</strong></>}
                  {' — '}quantities ×{fmtFactor(factor)}, prices ÷{fmtFactor(factor)}
                </div>
              ) : (
                <div className="rounded border border-hairline bg-raised px-3 py-2 text-sm text-ink-soft">
                  {isSplit
                    ? 'Factor = old FV ÷ new FV (e.g. 10→2 ⇒ ×5)'
                    : 'Factor = (A+B) ÷ B (e.g. 1:1 ⇒ ×2)'}
                </div>
              )}
            </div>
          </div>

          <div className="mb-3 flex flex-wrap gap-4">
            <div style={{ width: 200 }}>
              <label className={label}>Ex-date <span className="text-danger-500">*</span></label>
              <input type="date" className={ctrl} value={form.exDate} onChange={(e) => setField('exDate', e.target.value)} required />
              <span className={help}>Adjustment auto-applies pre-market on this date (approved actions only).</span>
            </div>
            <div style={{ width: 200 }}>
              <label className={label}>Record date</label>
              <input type="date" className={ctrl} value={form.recordDate} min={form.exDate || undefined} onChange={(e) => setField('recordDate', e.target.value)} />
              <span className={help}>Optional — informational.</span>
            </div>
          </div>

          <div className="mb-1">
            <label className={label}>Notes</label>
            <textarea
              rows={2}
              className={ctrl}
              value={form.notes}
              onChange={(e) => setField('notes', e.target.value)}
              placeholder="Optional — e.g. exchange circular reference"
            />
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default CorporateActionsPage;
