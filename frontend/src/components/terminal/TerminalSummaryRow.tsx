/**
 * TerminalSummaryRow Component
 * Expandable row for a user-broker summary
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { BsChevronDown, BsChevronRight, BsCircleFill } from 'react-icons/bs';
import clsx from 'clsx';
import { Badge } from '@/components/ui';

import type { UserTradeSummary, UserTradeDetails, TerminalSquareOffRequest, ExitPositionRequest, ExitPositionsResponse } from '@/types/terminal';
import type { SquareOffProduct } from '@/types/product';
import PnLDisplay from './PnLDisplay';
import MismatchBadge from './MismatchBadge';
import HedgeDistanceBadge from './HedgeDistanceBadge';
import TerminalActions from './TerminalActions';
import UserDetailsPanel from './UserDetailsPanel';
import RowTradesActionModal from './RowTradesActionModal';
import { valueForMode, countForMode, liveOnlyForMode } from '@/utils/tradingMode';

interface TerminalSummaryRowProps {
  summary: UserTradeSummary;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onRefresh: (username: string, broker: string) => Promise<UserTradeDetails>;
  onSquareOff: (username: string, broker: string, product: SquareOffProduct) => void;
  onSquareOffStrategy?: (request: TerminalSquareOffRequest) => Promise<void>;
  onGetDetails: (username: string, broker: string) => Promise<UserTradeDetails>;
  isRefreshing?: boolean;
  isSquaringOff?: boolean;
  // Single trade actions
  onCompleteTrade?: (username: string, broker: string, tradeID: string, exitPrice: number, exitDate?: string) => Promise<void>;
  onSquareOffTrade?: (username: string, broker: string, tradeID: string, product?: SquareOffProduct) => Promise<void>;
  onCancelTrade?: (username: string, broker: string, tradeID: string) => Promise<void>;
  // Exit positions
  onExitPositions?: (request: ExitPositionRequest) => Promise<ExitPositionsResponse | void>;
  // External details from periodic refresh
  externalDetails?: UserTradeDetails | null;
  // live = real only (default), paper = paper only, mixed = both.
  tradingMode?: 'live' | 'paper' | 'mixed';
}

const TerminalSummaryRow: React.FC<TerminalSummaryRowProps> = ({
  summary,
  isExpanded,
  onToggleExpand,
  onRefresh,
  onSquareOff,
  onSquareOffStrategy,
  onGetDetails,
  isRefreshing = false,
  isSquaringOff = false,
  onCompleteTrade,
  onSquareOffTrade,
  onCancelTrade,
  onExitPositions,
  externalDetails,
  tradingMode = 'live',
}) => {
  // Broker-PnL + Mismatch cells require ALGO_BROKER_COMPARE View (matches the header/footer gate
  // in TerminalSummaryTable so column counts stay aligned).
  // Margin % cell requires MARGINS View (matches the TerminalSummaryTable header/footer gate).
  const [details, setDetails] = useState<UserTradeDetails | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<string | undefined>();
  // Row-level "Complete Trades" / "Alter Trades" modals opened from the 3-dots menu.
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [showAlterModal, setShowAlterModal] = useState(false);
  const rowRef = useRef<HTMLTableRowElement>(null);

  // Tracks whether a user-initiated expand needs scroll adjustment
  const pendingScrollRef = useRef(false);
  const scrollTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const prevLoadingRef = useRef(isLoadingDetails);

  const clearScrollTimers = useCallback(() => {
    scrollTimersRef.current.forEach(clearTimeout);
    scrollTimersRef.current = [];
  }, []);

  const doScrollToRow = useCallback(() => {
    if (rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect();
      const targetY = window.innerHeight * 0.05;
      const diff = rect.top - targetY;
      if (Math.abs(diff) > 20) {
        window.scrollBy({ top: diff, behavior: 'instant' });
      }
    }
  }, []);

  const handleToggleExpand = useCallback(() => {
    clearScrollTimers();
    const expanding = !isExpanded;
    onToggleExpand();

    if (expanding) {
      pendingScrollRef.current = true;
      // Retry scroll as page grows taller (Collapse animation + loading spinner)
      [400, 700, 1000].forEach(delay => {
        scrollTimersRef.current.push(setTimeout(doScrollToRow, delay));
      });
    }
  }, [isExpanded, onToggleExpand, clearScrollTimers, doScrollToRow]);

  // Final scroll after data finishes loading (handles slow API responses)
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoadingDetails;

    // Detect loading → loaded transition while a scroll is pending
    if (wasLoading && !isLoadingDetails && pendingScrollRef.current) {
      pendingScrollRef.current = false;
      clearScrollTimers();
      const timer = setTimeout(doScrollToRow, 100);
      scrollTimersRef.current.push(timer);
    }
  }, [isLoadingDetails, doScrollToRow, clearScrollTimers]);

  // Cleanup timers on unmount
  useEffect(() => clearScrollTimers, [clearScrollTimers]);

  // Track previous trade counts to detect changes from WebSocket updates
  const prevTradeCountsRef = useRef({
    activeTradesCount: summary.activeTradesCount,
    completedTradesCount: summary.completedTradesCount,
  });

  // Single-flight latch for this row's details loading. While a request is
  // in-flight, new triggers (expand / WS count-change / manual refresh) are
  // skipped rather than firing a second concurrent request — we wait for the
  // current one to finish. A ref (not state) is used so the guard is read
  // synchronously and two triggers off the same render can't both slip through.
  // The request itself is bounded at 20s (terminalService), so the latch can
  // never stay stuck if a request hangs.
  const inFlightRef = useRef(false);

  const loadDetails = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsLoadingDetails(true);
    setDetailsError(undefined);
    onGetDetails(summary.username, summary.broker)
      .then(setDetails)
      .catch(err => setDetailsError((err as Error).message || 'Failed to load details'))
      .finally(() => {
        inFlightRef.current = false;
        setIsLoadingDetails(false);
      });
  }, [onGetDetails, summary.username, summary.broker]);

  // Fetch details every time the row is expanded
  useEffect(() => {
    if (isExpanded) {
      loadDetails();
    }
  }, [isExpanded, loadDetails]);

  // Auto-refresh details when trade counts change via WebSocket while row is expanded
  useEffect(() => {
    const prevCounts = prevTradeCountsRef.current;
    const countsChanged =
      prevCounts.activeTradesCount !== summary.activeTradesCount ||
      prevCounts.completedTradesCount !== summary.completedTradesCount;

    // Update ref with current counts
    prevTradeCountsRef.current = {
      activeTradesCount: summary.activeTradesCount,
      completedTradesCount: summary.completedTradesCount,
    };

    // If row is expanded and counts changed, refresh details. The in-flight
    // latch inside loadDetails() drops this if a request is already pending.
    if (isExpanded && countsChanged) {
      console.log(
        `[TerminalSummaryRow] Trade counts changed for ${summary.username}, auto-refreshing details`,
        { prev: prevCounts, current: { activeTradesCount: summary.activeTradesCount, completedTradesCount: summary.completedTradesCount } }
      );
      loadDetails();
    }
  }, [isExpanded, summary.activeTradesCount, summary.completedTradesCount, summary.username, summary.broker, loadDetails]);

  // Update details when externalDetails changes (from periodic refresh)
  useEffect(() => {
    if (externalDetails && isExpanded) {
      console.log(`[TerminalSummaryRow] Updating details from periodic refresh for ${summary.username}`);
      setDetails(externalDetails);
    }
  }, [externalDetails, isExpanded, summary.username]);

  const handleRefresh = useCallback(async () => {
    // Manual refresh always fires immediately (the button is already disabled
    // while a refresh for this row is in-flight, so this can't double-run).
    // Hold the latch so the component's own expand/WS detail fetches don't
    // overlap this request.
    inFlightRef.current = true;
    setIsLoadingDetails(true);
    setDetailsError(undefined);
    try {
      // onRefresh now calls both APIs and returns details
      const refreshedDetails = await onRefresh(summary.username, summary.broker);
      setDetails(refreshedDetails);
    } catch (err) {
      setDetailsError((err as Error).message || 'Failed to refresh');
    } finally {
      inFlightRef.current = false;
      setIsLoadingDetails(false);
    }
  }, [onRefresh, summary.username, summary.broker]);

  const handleSquareOff = useCallback((product: SquareOffProduct) => {
    onSquareOff(summary.username, summary.broker, product);
  }, [onSquareOff, summary.username, summary.broker]);

  // Live / paper / mixed derivation for every collapsed-row metric.
  const activeCount = countForMode(summary.activeTradesCount, summary.paperActiveTradesCount, tradingMode);
  const completedCount = countForMode(summary.completedTradesCount, summary.paperCompletedTradesCount, tradingMode);
  const openCount = countForMode(summary.openTradesCount, summary.paperOpenTradesCount, tradingMode);
  const cancelledCount = countForMode(summary.cancelledTradesCount, summary.paperCancelledTradesCount, tradingMode);
  const trackLostCount = countForMode(summary.trackLostTradesCount, summary.paperTrackLostTradesCount, tradingMode);
  // "Z" — active option trades at/near the floor, CMP <= 0.10 (worthless at expiry)
  const zeroPriceCount = countForMode(summary.zeroPriceActiveTradesCount || 0, summary.paperZeroPriceActiveTradesCount, tradingMode);

  // Money / capital / margin / hedge / mismatch, mode-adjusted.
  const algoPnl = valueForMode(summary.algoPnl, summary.paperAlgoPnl, tradingMode);
  const brokerPnl = valueForMode(summary.brokerPnl, summary.paperBrokerPnl, tradingMode);
  // Capital is not mode-split — always the user-broker configured total capital.
  const capital = summary.totalCapital || 0;
  const externalCapital = summary.externalCapital || 0;
  const algoPct = capital > 0 ? (algoPnl / capital) * 100 : 0;
  const brokerPct = (capital + externalCapital) > 0 ? (brokerPnl / (capital + externalCapital)) * 100 : 0;
  // Margin and mismatch are live-only (paper trades use no real margin and never reconcile).
  const marginUtil = liveOnlyForMode(summary.marginUtilizationPercent, tradingMode);
  const peakMarginUtil = liveOnlyForMode(summary.peakMarginUtilizationPercent, tradingMode);
  const showMargin = tradingMode !== 'paper' && summary.totalMargin > 0;
  const intradayHedges = countForMode(summary.intradayHedgeShortCount, summary.paperIntradayHedgeShortCount, tradingMode);
  const positionalHedges = countForMode(summary.positionalHedgeShortCount, summary.paperPositionalHedgeShortCount, tradingMode);
  const mismatchCount = tradingMode === 'paper' ? 0 : summary.mismatchCount;
  const mismatchSeverity = tradingMode === 'paper' ? 'NONE' : summary.mismatchSeverity;

  // Filter the expanded trade-detail rows by the selected mode (b).
  const matchesMode = (t: { isPaperTrading?: boolean }) =>
    tradingMode === 'mixed' || (tradingMode === 'paper' ? !!t.isPaperTrading : !t.isPaperTrading);
  const filteredDetails: UserTradeDetails | null = (!details || tradingMode === 'mixed')
    ? details
    : {
        ...details,
        activeTrades: (details.activeTrades || []).filter(matchesMode),
        completedTrades: (details.completedTrades || []).filter(matchesMode),
        openTrades: (details.openTrades || []).filter(matchesMode),
        cancelledTrades: (details.cancelledTrades || []).filter(matchesMode),
        trackLostTrades: (details.trackLostTrades || []).filter(matchesMode),
        // Compare Positions respects the mode too: live → live positions only,
        // paper → paper only (mixed keeps all).
        algoPositions: (details.algoPositions || []).filter(matchesMode),
        brokerPositions: (details.brokerPositions || []).filter(matchesMode),
        mismatches: (details.mismatches || []).filter(matchesMode),
      };

  return (
    <>
      {/* Summary Row */}
      <tr
        ref={rowRef}
        className={clsx('terminal-summary-row hover:bg-raised/40', {
          'bg-danger-500/10': summary.mismatchSeverity === 'CRITICAL',
          'bg-warning-500/10': summary.mismatchSeverity === 'WARNING',
          expanded: isExpanded,
        })}
      >
        {/* Expand Toggle */}
        <td className="cursor-pointer text-ink" onClick={handleToggleExpand}>
          {isExpanded ? <BsChevronDown /> : <BsChevronRight />}
        </td>

        {/* Username & Status */}
        <td>
          <div className="flex items-center gap-2">
            <BsCircleFill size={8} className={summary.isLoggedIn ? 'text-success-500' : 'text-danger-500'} title={summary.isLoggedIn ? 'Logged In' : 'Logged Out'} />
            <span className="font-medium text-ink">{summary.username}</span>
          </div>
        </td>

        {/* Broker & Client ID */}
        <td>
          <div>
            <span className="text-ink">{summary.broker}</span>
            {summary.clientID && <small className="block text-ink-faint">{summary.clientID}</small>}
          </div>
        </td>

        {/* Trade Counts */}
        <td className="text-center">
          <div className="flex justify-center gap-1">
            {activeCount > 0 && <Badge tone="blue">{activeCount}</Badge>}
            {completedCount > 0 && <Badge tone="success">{completedCount}</Badge>}
            {openCount > 0 && <Badge tone="neutral">{openCount}</Badge>}
            {cancelledCount > 0 && <Badge tone="warning">{cancelledCount}</Badge>}
            {trackLostCount > 0 && <Badge tone="danger">{trackLostCount}</Badge>}
          </div>
        </td>

        {/* Z — zero-priced active options (CMP at/near the floor, <= 0.10) */}
        <td className="text-center">
          {zeroPriceCount > 0 ? (
            <span className="inline-flex rounded bg-ink px-1.5 py-0.5 text-xs text-app" title="Active option trades with CMP at/near the floor (≤ 0.10) — worthless at expiry">
              {zeroPriceCount}
            </span>
          ) : (
            <span className="text-ink-faint">-</span>
          )}
        </td>

        {/* Capital */}
        <td className="text-right tabular-nums text-ink">{capital.toLocaleString('en-IN')}</td>

        {/* External Capital */}
        {<td className="text-right tabular-nums text-ink">{externalCapital ? externalCapital.toLocaleString('en-IN') : '-'}</td>}

        {/* Algo Pnl */}
        <td className="text-right">
          <PnLDisplay value={algoPnl} size="sm" fullFormat />
        </td>

        {/* Algo % */}
        <td className="text-right">
          <PnLDisplay value={algoPct} size="sm" />
        </td>

        {/* Broker Pnl */}
                  <td className="text-right">
            <PnLDisplay value={brokerPnl} size="sm" fullFormat />
          </td>
        

        {/* Broker % */}
                  <td className="text-right">
            <PnLDisplay value={brokerPct} size="sm" />
          </td>
        

        {/* Margin Utilization */}
                  <td className="text-center">
            {showMargin ? (
              <div>
                <span className={clsx(marginUtil < 50 ? 'text-success-500' : marginUtil < 80 ? 'text-warning-500' : 'text-danger-500')}>{marginUtil.toFixed(1)}%</span>
                {peakMarginUtil > marginUtil && <small className="block text-ink-faint">Peak: {peakMarginUtil.toFixed(1)}%</small>}
              </div>
            ) : (
              <span className="text-ink-faint">-</span>
            )}
          </td>
        

        {/* Pos Hedges — counts of active POSITIONAL SHORT trades by current
            hedge distance (I = intraday, P = positional). Live snapshot of
            the morning / evening hedge-replace flow. */}
        <td className="text-center">
          <HedgeDistanceBadge
            intradayCount={intradayHedges}
            positionalCount={positionalHedges}
          />
        </td>

        {/* Mismatch (live-only — paper positions never reconcile) */}
                <td>
          <MismatchBadge
            severity={mismatchSeverity}
            mismatchCount={mismatchCount}
            hasQtyMismatch={tradingMode === 'paper' ? false : summary.hasQtyMismatch}
            hasSymbolMismatch={tradingMode === 'paper' ? false : summary.hasSymbolMismatch}
            hasPnlMismatch={tradingMode === 'paper' ? false : summary.hasPnlMismatch}
          />
        </td>
        

        {/* Actions */}
        <td>
          <TerminalActions
            username={summary.username}
            broker={summary.broker}
            clientID={summary.clientID}
            hasActiveTrades={summary.activeTradesCount > 0}
            isRefreshing={isRefreshing}
            isSquaringOff={isSquaringOff}
            onRefresh={handleRefresh}
            onSquareOff={handleSquareOff}
            onCompleteTrades={() => setShowCompleteModal(true)}
            onAlterTrades={() => setShowAlterModal(true)}
          />
        </td>
      </tr>

      {/* Row-level bulk action modals (scoped to this user + broker). On success
          they call handleRefresh so this row re-fetches its trades. */}
      <RowTradesActionModal
        show={showCompleteModal}
        mode="complete"
        username={summary.username}
        broker={summary.broker}
        onClose={() => setShowCompleteModal(false)}
        onSuccess={handleRefresh}
      />
      <RowTradesActionModal
        show={showAlterModal}
        mode="alter"
        username={summary.username}
        broker={summary.broker}
        onClose={() => setShowAlterModal(false)}
        onSuccess={handleRefresh}
      />

      {/* Expanded Details */}
      {isExpanded && (
        <tr className="terminal-details-row">
          <td colSpan={15} className="p-0">
            <UserDetailsPanel
              details={filteredDetails}
              isLoading={isLoadingDetails}
              error={detailsError}
              tradingMode={tradingMode}
              algoCapital={summary.totalCapital}
              externalCapital={summary.externalCapital}
              onSquareOff={onSquareOffStrategy}
              onExitPositions={onExitPositions}
              onCompleteTrade={onCompleteTrade ? (tradeID, exitPrice, exitDate) => onCompleteTrade(summary.username, summary.broker, tradeID, exitPrice, exitDate) : undefined}
              onSquareOffTrade={onSquareOffTrade ? (tradeID, product) => onSquareOffTrade(summary.username, summary.broker, tradeID, product) : undefined}
              onCancelTrade={onCancelTrade ? (tradeID) => onCancelTrade(summary.username, summary.broker, tradeID) : undefined}
            />
          </td>
        </tr>
      )}
    </>
  );
};

export default TerminalSummaryRow;
