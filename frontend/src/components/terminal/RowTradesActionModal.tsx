/**
 * RowTradesActionModal
 *
 * Per-row (user + broker) bulk trade action modal opened from the terminal
 * 3-dots menu. Two modes:
 *   - 'complete' : set ACTIVE trades to COMPLETED (operation completeTradeBulk).
 *                  Source = active-trades catalog. Exit price defaults to CMP;
 *                  positional/cashbuy trades also take an exit date.
 *   - 'alter'    : change the exit price of ALREADY-COMPLETED trades
 *                  (operation alterExitPrice, one call per trade). Source =
 *                  completedTrades. Exit price defaults to the current exit.
 *
 * It is self-contained: it fetches its own data, manages selection / inputs /
 * per-trade results, and submits via terminalService. On completion it calls
 * onSuccess() so the PARENT (the summary row) can refresh that row's trades —
 * this component never touches the table itself.
 *
 * All trades are selected by default (per product requirement).
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';

import { terminalService } from '@/services/terminal/terminalService';
import { Badge, Button, Modal, Spinner } from '@/components/ui';
import type { BulkCompleteTradeItem, UserTradeDetails } from '@/types/terminal';

export type RowTradesActionMode = 'complete' | 'alter';

interface RowTradesActionModalProps {
  show: boolean;
  mode: RowTradesActionMode;
  username: string;
  broker: string;
  onClose: () => void;
  /** Called after the action runs so the parent can refresh this row's trades. */
  onSuccess: () => void;
}

// Normalised row used by both modes.
interface ActionTradeRow {
  tradeID: string;
  strategy: string;
  tradingSymbol: string;
  product: string;       // INTRADAY | POSITIONAL | CASHBUY | MTF
  productType: string;   // MIS | NRML | CNC
  direction: 'LONG' | 'SHORT';
  quantity: number;
  entry: number;
  // 'complete' → CMP (default exit); 'alter' → current exit price.
  referencePrice: number;
}

interface RowResult {
  status: 'success' | 'error';
  message: string;
}

// Runtime shape of a completed trade from /trades (see ServerTrade in UserDetailsPanel).
interface CompletedServerTrade {
  tradeID: string;
  strategy: string;
  product: string;
  productType: string;
  tradingSymbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  entry: number;
  exit: number;
}

const todayDate = (): string => new Date().toISOString().split('T')[0];

const RowTradesActionModal: React.FC<RowTradesActionModalProps> = ({
  show,
  mode,
  username,
  broker,
  onClose,
  onSuccess,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [trades, setTrades] = useState<ActionTradeRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exitPrices, setExitPrices] = useState<Record<string, string>>({});
  const [exitDates, setExitDates] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, RowResult>>({});

  const isComplete = mode === 'complete';
  const title = isComplete ? 'Complete Trades' : 'Alter Exit Prices';

  // Fetch the relevant trades whenever the modal opens.
  useEffect(() => {
    if (!show) return;

    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    setResults({});

    const fetchTrades = async (): Promise<ActionTradeRow[]> => {
      if (isComplete) {
        const catalog = await terminalService.getActiveTradesCatalog({ username, broker });
        return catalog.map(item => ({
          tradeID: item.tradeID,
          strategy: item.strategy,
          tradingSymbol: item.tradingSymbol,
          product: item.product,
          productType: item.productType,
          direction: item.direction,
          quantity: item.quantity,
          entry: item.entry,
          referencePrice: item.cmp,
        }));
      }
      const details: UserTradeDetails = await terminalService.getTrades(username, broker);
      const completed = (details.completedTrades || []) as unknown as CompletedServerTrade[];
      return completed.map(t => ({
        tradeID: t.tradeID,
        strategy: t.strategy,
        tradingSymbol: t.tradingSymbol,
        product: t.product,
        productType: t.productType,
        direction: t.direction,
        quantity: t.quantity,
        entry: t.entry,
        referencePrice: t.exit,
      }));
    };

    fetchTrades()
      .then(rows => {
        if (cancelled) return;
        setTrades(rows);
        // Select all by default.
        setSelectedIds(new Set(rows.map(r => r.tradeID)));
        // Prefill exit price with the reference price (CMP for complete, current exit for alter).
        setExitPrices(
          Object.fromEntries(rows.map(r => [r.tradeID, r.referencePrice != null ? String(r.referencePrice) : '']))
        );
        // Prefill exit date (today) for non-INTRADAY trades in complete mode.
        if (isComplete) {
          const today = todayDate();
          setExitDates(
            Object.fromEntries(rows.filter(r => r.product !== 'INTRADAY').map(r => [r.tradeID, today]))
          );
        } else {
          setExitDates({});
        }
      })
      .catch(err => {
        if (cancelled) return;
        setLoadError((err as Error).message || 'Failed to load trades');
        setTrades([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [show, mode, username, broker, isComplete]);

  const handleClose = useCallback(() => {
    if (isSubmitting) return;
    setTrades([]);
    setSelectedIds(new Set());
    setExitPrices({});
    setExitDates({});
    setResults({});
    setLoadError(null);
    onClose();
  }, [isSubmitting, onClose]);

  const toggleSelect = useCallback((tradeID: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(tradeID)) next.delete(tradeID);
      else next.add(tradeID);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback((selectAll: boolean) => {
    setSelectedIds(selectAll ? new Set(trades.map(t => t.tradeID)) : new Set());
  }, [trades]);

  const allSelected = trades.length > 0 && selectedIds.size === trades.length;

  const selectedTrades = useMemo(
    () => trades.filter(t => selectedIds.has(t.tradeID)),
    [trades, selectedIds]
  );

  // A selected row is invalid if its exit price is non-positive, or (complete mode,
  // non-INTRADAY) it has no exit date.
  const hasInvalidSelectedRows = useMemo(() => {
    return selectedTrades.some(t => {
      const price = Number(exitPrices[t.tradeID] || '');
      if (!Number.isFinite(price) || price <= 0) return true;
      if (isComplete && t.product !== 'INTRADAY' && !(exitDates[t.tradeID] || '').trim()) return true;
      return false;
    });
  }, [selectedTrades, exitPrices, exitDates, isComplete]);

  const handleSubmit = useCallback(async () => {
    if (selectedTrades.length === 0) return;
    setIsSubmitting(true);
    try {
      if (isComplete) {
        const payload: BulkCompleteTradeItem[] = selectedTrades.map(t => ({
          username,
          broker,
          tradeID: t.tradeID,
          exitPrice: Number(exitPrices[t.tradeID] || t.referencePrice || 0),
          exitDate: t.product === 'INTRADAY' ? undefined : (exitDates[t.tradeID] || todayDate()),
        }));
        const apiResults = await terminalService.completeTradesBulk(username, broker, payload);
        setResults(
          Object.fromEntries(
            apiResults.map(r => [r.tradeID, { status: r.status, message: r.message || '' }])
          )
        );
      } else {
        // alterExitPrice has no bulk form — one call per selected trade.
        const settled = await Promise.allSettled(
          selectedTrades.map(t =>
            terminalService
              .alterExitPrice(username, broker, t.tradeID, Number(exitPrices[t.tradeID] || t.referencePrice || 0))
              .then(res => ({ tradeID: t.tradeID, res }))
          )
        );
        const next: Record<string, RowResult> = {};
        settled.forEach((s, idx) => {
          const tradeID = selectedTrades[idx].tradeID;
          if (s.status === 'fulfilled') {
            const { res } = s.value;
            next[tradeID] = {
              status: res.success ? 'success' : 'error',
              message: res.message || res.status || (res.success ? 'Altered' : 'Failed'),
            };
          } else {
            next[tradeID] = {
              status: 'error',
              message: (s.reason as Error)?.message || 'Failed to alter exit price',
            };
          }
        });
        setResults(next);
      }
      // Tell the parent to refresh this row's trades regardless of per-item outcome.
      onSuccess();
    } finally {
      setIsSubmitting(false);
    }
  }, [selectedTrades, isComplete, username, broker, exitPrices, exitDates, onSuccess]);

  const hasResults = Object.keys(results).length > 0;
  const cell = 'px-2 py-1.5';
  const numInput =
    'h-7 w-full rounded border border-hairline bg-card px-2 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60 disabled:opacity-50';

  return (
    <Modal
      open={show}
      onClose={handleClose}
      size="xl"
      title={
        <span>
          {title}
          <span className="ml-2 text-base font-normal text-ink-soft">
            — {username} / {broker}
          </span>
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={isSubmitting}>
            {hasResults ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={isLoading || isSubmitting || selectedTrades.length === 0 || hasInvalidSelectedRows}>
            {isSubmitting ? (
              <>
                <Spinner size="sm" />
                {isComplete ? 'Completing...' : 'Altering...'}
              </>
            ) : (
              `${isComplete ? 'Complete' : 'Alter'} ${selectedTrades.length} Trade${selectedTrades.length === 1 ? '' : 's'}`
            )}
          </Button>
        </>
      }
    >
      {isLoading ? (
        <div className="py-4 text-center text-primary-500">
          <Spinner />
          <p className="mb-0 mt-2 text-ink-soft">Loading trades...</p>
        </div>
      ) : loadError ? (
        <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">{loadError}</div>
      ) : trades.length === 0 ? (
        <p className="mb-0 text-ink-soft">{isComplete ? 'No active trades to complete for this user/broker.' : 'No completed trades to alter for this user/broker.'}</p>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-ink-soft">
              {selectedIds.size} of {trades.length} selected
            </span>
            <small className="text-ink-faint">
              {isComplete ? 'Exit price defaults to current market price.' : 'Changes the exit price of completed trades and recalculates P&L.'}
            </small>
          </div>
          <div style={{ maxHeight: '52vh', overflowY: 'auto' }} className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-[1] bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={cell} style={{ width: '40px' }}>
                    <input type="checkbox" className="h-4 w-4 accent-primary-500" checked={allSelected} onChange={(e) => toggleSelectAll(e.target.checked)} title="Select all" />
                  </th>
                  <th className={`${cell} text-left`}>Strategy</th>
                  <th className={`${cell} text-left`}>Symbol</th>
                  <th className={`${cell} text-left`}>Product</th>
                  <th className={`${cell} text-center`}>Dir</th>
                  <th className={`${cell} text-right`}>Qty</th>
                  <th className={`${cell} text-right`}>Entry</th>
                  <th className={`${cell} text-right`}>{isComplete ? 'Exit Price' : 'New Exit'}</th>
                  {isComplete && <th className={`${cell} text-left`}>Exit Date</th>}
                  <th className={`${cell} text-left`}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {trades.map((t) => {
                  const result = results[t.tradeID];
                  return (
                    <tr key={t.tradeID} className="hover:bg-raised/50">
                      <td className={cell}>
                        <input type="checkbox" className="h-4 w-4 accent-primary-500" checked={selectedIds.has(t.tradeID)} onChange={() => toggleSelect(t.tradeID)} />
                      </td>
                      <td className={`${cell} text-ink`}>{t.strategy}</td>
                      <td className={`${cell} font-medium text-ink`}>{t.tradingSymbol}</td>
                      <td className={cell}>
                        <small className="text-ink-faint">
                          {t.product} / {t.productType}
                        </small>
                      </td>
                      <td className={`${cell} text-center`}>
                        <Badge tone={t.direction === 'LONG' ? 'success' : 'danger'}>{t.direction}</Badge>
                      </td>
                      <td className={`${cell} text-right tabular-nums text-ink`}>{t.quantity}</td>
                      <td className={`${cell} text-right tabular-nums text-ink`}>{t.entry?.toFixed(2)}</td>
                      <td className={cell} style={{ width: '110px' }}>
                        <input
                          type="number"
                          step="0.05"
                          className={numInput}
                          value={exitPrices[t.tradeID] ?? ''}
                          onChange={(e) => setExitPrices((prev) => ({ ...prev, [t.tradeID]: e.target.value }))}
                          disabled={!selectedIds.has(t.tradeID)}
                        />
                      </td>
                      {isComplete && (
                        <td className={cell} style={{ width: '150px' }}>
                          {t.product !== 'INTRADAY' ? (
                            <input
                              type="date"
                              max={todayDate()}
                              className={numInput}
                              value={exitDates[t.tradeID] ?? ''}
                              onChange={(e) => setExitDates((prev) => ({ ...prev, [t.tradeID]: e.target.value }))}
                              disabled={!selectedIds.has(t.tradeID)}
                            />
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                      )}
                      <td className={cell}>
                        {result ? (
                          <Badge tone={result.status === 'success' ? 'success' : 'danger'}>{result.status === 'success' ? 'Done' : 'Failed'}</Badge>
                        ) : (
                          <span className="text-sm text-ink-faint">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
};

export default RowTradesActionModal;
