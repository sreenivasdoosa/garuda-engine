/**
 * TerminalSummaryTable Component
 * Main table displaying all user trade summaries
 */

import React, { useMemo, useState, useCallback } from 'react';

import type { UserTradeSummary, UserTradeDetails, TerminalSquareOffRequest, ExitPositionRequest, ExitPositionsResponse } from '@/types/terminal';
import type { SquareOffProduct } from '@/types/product';
import { Badge, Spinner } from '@/components/ui';
import TerminalSummaryRow from './TerminalSummaryRow';
import PnLDisplay from './PnLDisplay';
import HedgeDistanceBadge from './HedgeDistanceBadge';
import { valueForMode, countForMode } from '@/utils/tradingMode';
import { usePermissions } from '@/hooks/usePermissions';

interface TerminalSummaryTableProps {
  summaries: UserTradeSummary[];
  isLoading: boolean;
  error?: string | null;
  onRefresh: (username: string, broker: string) => Promise<UserTradeDetails>;
  onSquareOff: (username: string, broker: string, product: SquareOffProduct) => void;
  onSquareOffStrategy?: (request: TerminalSquareOffRequest) => Promise<void>;
  onGetDetails: (username: string, broker: string) => Promise<UserTradeDetails>;
  refreshingUsers?: Set<string>;
  squaringOffUsers?: Set<string>;
  // Single trade actions
  onCompleteTrade?: (username: string, broker: string, tradeID: string, exitPrice: number, exitDate?: string) => Promise<void>;
  onSquareOffTrade?: (username: string, broker: string, tradeID: string, product?: SquareOffProduct) => Promise<void>;
  onCancelTrade?: (username: string, broker: string, tradeID: string) => Promise<void>;
  // Exit positions
  onExitPositions?: (request: ExitPositionRequest) => Promise<ExitPositionsResponse | void>;
  // Callback when expanded row changes (for WebSocket refresh filtering)
  onExpandedRowChange?: (key: string | null) => void;
  // Expanded row details from periodic refresh
  expandedRowDetails?: UserTradeDetails | null;
  expandedRowKey?: string | null;
  // Key (`username-broker`) of the expanded row whose periodic/manual refresh is
  // currently in-flight — disables only that one row's refresh button.
  refreshingExpandedKey?: string | null;
  // live = real only (default), paper = paper only, mixed = both.
  tradingMode?: 'live' | 'paper' | 'mixed';
}

const TerminalSummaryTable: React.FC<TerminalSummaryTableProps> = ({
  summaries,
  isLoading,
  error,
  onRefresh,
  onSquareOff,
  onSquareOffStrategy,
  onGetDetails,
  refreshingUsers = new Set(),
  squaringOffUsers = new Set(),
  onCompleteTrade,
  onSquareOffTrade,
  onCancelTrade,
  onExitPositions,
  onExpandedRowChange,
  expandedRowDetails,
  expandedRowKey: externalExpandedRowKey,
  refreshingExpandedKey = null,
  tradingMode = 'live',
}) => {
  // Broker-PnL + Mismatch columns require ALGO_BROKER_COMPARE View (kept consistent across
  // header/body/footer; TerminalSummaryRow checks the same right for its body cells).
  const { algoBrokerCompare, margins } = usePermissions();
  const canCompare = algoBrokerCompare.canView;
  // Margin % column requires MARGINS View (header/body/footer consistent with TerminalSummaryRow).
  const canViewMargins = margins.canView;
  // Track which row is expanded (only one at a time)
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);

  // Handle row expansion toggle - only one row can be expanded at a time
  const handleToggleExpand = useCallback((key: string) => {
    setExpandedRowKey(prev => {
      const newKey = prev === key ? null : key;
      // Notify parent about expanded row change (for WebSocket refresh filtering)
      onExpandedRowChange?.(newKey);
      return newKey;
    });
  }, [onExpandedRowChange]);

  // Calculate totals
  const totals = useMemo(() => {
    return summaries.reduce(
      (acc, s) => ({
        activeTradesCount: acc.activeTradesCount + s.activeTradesCount,
        completedTradesCount: acc.completedTradesCount + s.completedTradesCount,
        paperActiveTradesCount: acc.paperActiveTradesCount + (s.paperActiveTradesCount || 0),
        paperCompletedTradesCount: acc.paperCompletedTradesCount + (s.paperCompletedTradesCount || 0),
        zeroPriceActiveTradesCount: acc.zeroPriceActiveTradesCount + (s.zeroPriceActiveTradesCount || 0),
        paperZeroPriceActiveTradesCount: acc.paperZeroPriceActiveTradesCount + (s.paperZeroPriceActiveTradesCount || 0),
        totalCapital: acc.totalCapital + (s.totalCapital || 0),
        externalCapital: acc.externalCapital + (s.externalCapital || 0),
        algoPnl: acc.algoPnl + (s.algoPnl || 0),
        paperAlgoPnl: acc.paperAlgoPnl + (s.paperAlgoPnl || 0),
        brokerPnl: acc.brokerPnl + (s.brokerPnl || 0),
        paperBrokerPnl: acc.paperBrokerPnl + (s.paperBrokerPnl || 0),
        intradayHedgeShortCount: acc.intradayHedgeShortCount + (s.intradayHedgeShortCount || 0),
        positionalHedgeShortCount: acc.positionalHedgeShortCount + (s.positionalHedgeShortCount || 0),
        paperIntradayHedgeShortCount: acc.paperIntradayHedgeShortCount + (s.paperIntradayHedgeShortCount || 0),
        paperPositionalHedgeShortCount: acc.paperPositionalHedgeShortCount + (s.paperPositionalHedgeShortCount || 0),
        mismatchCount: acc.mismatchCount + (s.mismatchSeverity !== 'NONE' ? 1 : 0),
        loggedInCount: acc.loggedInCount + (s.isLoggedIn ? 1 : 0),
      }),
      {
        activeTradesCount: 0,
        completedTradesCount: 0,
        paperActiveTradesCount: 0,
        paperCompletedTradesCount: 0,
        zeroPriceActiveTradesCount: 0,
        paperZeroPriceActiveTradesCount: 0,
        totalCapital: 0,
        externalCapital: 0,
        algoPnl: 0,
        paperAlgoPnl: 0,
        brokerPnl: 0,
        paperBrokerPnl: 0,
        intradayHedgeShortCount: 0,
        positionalHedgeShortCount: 0,
        paperIntradayHedgeShortCount: 0,
        paperPositionalHedgeShortCount: 0,
        mismatchCount: 0,
        loggedInCount: 0,
      }
    );
  }, [summaries]);

  // Mode-adjusted footer values.
  const footerActive = countForMode(totals.activeTradesCount, totals.paperActiveTradesCount, tradingMode);
  const footerCompleted = countForMode(totals.completedTradesCount, totals.paperCompletedTradesCount, tradingMode);
  const footerZeroPrice = countForMode(totals.zeroPriceActiveTradesCount, totals.paperZeroPriceActiveTradesCount, tradingMode);
  // Capital is not mode-split — always the configured total.
  const footerCapital = totals.totalCapital;
  const footerExternalCapital = totals.externalCapital;
  const footerAlgoPnl = valueForMode(totals.algoPnl, totals.paperAlgoPnl, tradingMode);
  const footerBrokerPnl = valueForMode(totals.brokerPnl, totals.paperBrokerPnl, tradingMode);
  const footerIntradayHedges = countForMode(totals.intradayHedgeShortCount, totals.paperIntradayHedgeShortCount, tradingMode);
  const footerPositionalHedges = countForMode(totals.positionalHedgeShortCount, totals.paperPositionalHedgeShortCount, tradingMode);
  const footerMismatchCount = tradingMode === 'paper' ? 0 : totals.mismatchCount;

  const cardCls = 'rounded-card border border-hairline bg-card';

  if (isLoading && summaries.length === 0) {
    return (
      <div className={`${cardCls} py-10 text-center text-primary-500`}>
        <Spinner size="lg" />
        <p className="mb-0 mt-3 text-ink-soft">Loading terminal data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`${cardCls} py-10 text-center`}>
        <div className="inline-block rounded border border-danger-500/30 bg-danger-500/10 px-4 py-3 text-left text-danger-600 dark:text-danger-400">
          <h6 className="mb-1 font-semibold">Error Loading Terminal</h6>
          <p className="mb-0">{error}</p>
        </div>
      </div>
    );
  }

  if (summaries.length === 0) {
    return (
      <div className={`${cardCls} py-10 text-center`}>
        <p className="mb-0 text-ink-soft">No users found matching the current filters.</p>
      </div>
    );
  }

  return (
    // overflow-x-auto = THE horizontal scroller for the wide summary table (page never
    // scrolls sideways); container-type exposes the VISIBLE scrollport width as cqw so the
    // expanded detail row can pin itself to what's on screen (terminal.scss sizes
    // .terminal-details-row .user-details-panel to 100cqw + sticky left). Without a
    // container ancestor, 100cqw falls back to ~viewport width and the panel (and its
    // right-edge scrollbar) runs off-screen.
    <div className={`${cardCls} overflow-x-auto [container-type:inline-size]`}>
      <table className="w-full text-sm [&_td]:px-2 [&_td]:py-1 [&_td]:leading-tight [&_th]:px-2 [&_th]:py-1.5">
        <thead className="sticky top-0 z-[1] bg-raised text-xs uppercase text-ink-faint">
          <tr>
            <th style={{ width: '40px' }}></th>
            <th className="text-left">User</th>
            <th className="text-left">Broker</th>
            <th className="text-center">Trades</th>
            <th className="text-center" title="Active option trades with CMP at/near the floor (≤ 0.10) — worthless at expiry">
              Z
            </th>
            <th className="text-right">Capital</th>
            {canCompare && <th className="text-right">Ext Capital</th>}
            <th className="text-right">Algo Pnl</th>
            <th className="text-right">Algo %</th>
            {canCompare && <th className="text-right">Broker Pnl</th>}
            {canCompare && <th className="text-right">Broker %</th>}
            {canViewMargins && <th className="text-center">Margin %</th>}
            <th className="text-center" title="Active POSITIONAL SHORT trades by current hedge distance — I = intraday, P = positional">
              Pos Hedges
            </th>
            {canCompare && <th className="text-left">Mismatch</th>}
            <th className="text-left" style={{ width: '120px' }}>Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
            {summaries.map((summary) => {
              const key = `${summary.username}-${summary.broker}`;
              return (
                <TerminalSummaryRow
                  key={key}
                  summary={summary}
                  isExpanded={expandedRowKey === key}
                  onToggleExpand={() => handleToggleExpand(key)}
                  onRefresh={onRefresh}
                  onSquareOff={onSquareOff}
                  onSquareOffStrategy={onSquareOffStrategy}
                  onGetDetails={onGetDetails}
                  isRefreshing={refreshingUsers.has(key) || refreshingExpandedKey === key}
                  isSquaringOff={squaringOffUsers.has(key)}
                  onCompleteTrade={onCompleteTrade}
                  onSquareOffTrade={onSquareOffTrade}
                  onCancelTrade={onCancelTrade}
                  onExitPositions={onExitPositions}
                  externalDetails={externalExpandedRowKey === key ? expandedRowDetails : null}
                  tradingMode={tradingMode}
                />
              );
            })}
          </tbody>
        <tfoot className="bg-raised font-bold text-ink">
          <tr>
            <td></td>
            <td colSpan={2}>
              Total: {summaries.length} users ({totals.loggedInCount} logged in)
            </td>
            <td className="text-center">
              <span className="inline-flex items-center justify-center gap-1">
                <Badge tone="blue">{footerActive}</Badge>
                <Badge tone="success">{footerCompleted}</Badge>
              </span>
            </td>
            <td className="text-center">
              {footerZeroPrice > 0 ? (
                <span className="inline-flex rounded bg-ink px-1.5 py-0.5 text-xs text-app" title="Total active option trades at/near the floor (≤ 0.10) — worthless at expiry">
                  {footerZeroPrice}
                </span>
              ) : (
                <span className="text-ink-faint">-</span>
              )}
            </td>
            <td className="text-right tabular-nums">{footerCapital.toLocaleString('en-IN')}</td>
            {canCompare && <td className="text-right tabular-nums">{footerExternalCapital.toLocaleString('en-IN')}</td>}
            <td className="text-right">
              <PnLDisplay value={footerAlgoPnl} fullFormat />
            </td>
            <td className="text-right">
              <PnLDisplay value={footerCapital > 0 ? (footerAlgoPnl / footerCapital) * 100 : 0} size="sm" />
            </td>
            {canCompare && (
              <td className="text-right">
                <PnLDisplay value={footerBrokerPnl} fullFormat />
              </td>
            )}
            {canCompare && (
              <td className="text-right">
                <PnLDisplay value={footerCapital + footerExternalCapital > 0 ? (footerBrokerPnl / (footerCapital + footerExternalCapital)) * 100 : 0} size="sm" />
              </td>
            )}
            {canViewMargins && <td></td>}
            <td className="text-center">
              <HedgeDistanceBadge intradayCount={footerIntradayHedges} positionalCount={footerPositionalHedges} />
            </td>
            {canCompare && <td>{footerMismatchCount > 0 && <span className="text-danger-500">{footerMismatchCount} with issues</span>}</td>}
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
};

export default TerminalSummaryTable;
