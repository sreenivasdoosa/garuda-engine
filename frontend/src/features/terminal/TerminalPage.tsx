/**
 * TerminalPage Component
 * Live trades and positions monitoring terminal
 * Accessible via toggle button in header for admin/clientmanager roles
 */

import React, { useMemo, useCallback, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Container, Row, Col, Card, Badge, Alert, Button, Dropdown, Modal, Form, Table, Spinner } from '@/components/ui/rbShim';
import { BsTerminal, BsClock, BsPieChart, BsGraphUp, BsXSquare, BsBarChartLine, BsLightning, BsShieldCheck } from 'react-icons/bs';
import { format } from 'date-fns';

import { useTerminal } from '@/hooks/useTerminal';
import { valueForMode, countForMode } from '@/utils/tradingMode';
import { terminalService } from '@/services/terminal/terminalService';
import { systemConfigService, exchangeService } from '@/services/admin/v2AdminService';
import type { TerminalSquareOffRequest, ExitPositionRequest, BulkCompleteTradeItem, ActiveTradeCatalogItem } from '@/types/terminal';
import {
  TRADABLE_PRODUCTS,
  SQUARE_OFF_PRODUCT_OPTIONS,
  PRODUCT_LABELS,
  PRODUCT_BADGE_BG,
  squareOffScopeLabel,
  toTradableProduct,
  type SquareOffProduct,
  type TradableProduct,
} from '@/types/product';
import {
  TerminalSummaryTable,
  TerminalFilters,
  ConnectionStatus,
  PnLDisplay,
  OverallSummary,
  PnlChart,
} from '@/components/terminal';
import { BottomSlidePanel } from '@/components/common';
import UserSelect from '@/components/common/UserSelect';
import { useReportsStrategyOptions } from '@/hooks/useReportsStrategyOptions';
import { useScopedBrokerNames } from '@/hooks/useScopedBrokerNames';
import { isShowTerminalPnlChart } from '@/config/featureFlags';
import TablePagination from '@/components/common/TablePagination';
import EngineMonitor from '@/features/shared/strategy-engine/EngineMonitor';
import StrategyStatesPanel from '@/components/terminal/StrategyStatesPanel';
import HedgeWindowsPanel from '@/components/terminal/HedgeWindowsPanel';

import '@/styles/terminal.scss';

interface BulkCompleteTradeRow {
  username: string;
  broker: string;
  tradeID: string;
  strategy: string;
  tradingSymbol: string;
  product: string;
  productType: string;
  group?: string;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  filledQuantity: number;
  entry: number;
  cmp: number;
  startTimestamp: number;
}

interface BulkCompleteTradeStatus {
  status: 'success' | 'error';
  message: string;
}

const TerminalPage: React.FC = () => {
  // Algo-vs-broker comparison (broker P&L row, mismatch tile, PnL-chart broker line) needs ALGO_BROKER_COMPARE View.
  // Fleet-wide Strategy Summary / Risk Profile panels — each gated by its own View right.
  // Strategy Signals (fleet strategy-states panel) requires STRATEGY_ENGINE View.
  // Square off (single / per-user / by-strategy / all) requires SQUARE_OFF Manage.
  // Set-to-complete (single + bulk) requires TRADES Edit.
  // Exported Signals (strategy-bridge outbox) is read-only, so SIGNAL_OUT View —
  // the same tool the bridge requires on the shared API key.

  const {
    summaries,
    filteredSummaries,
    isLoading,
    error,
    isConnected,
    isConnecting,
    reconnectAttempts,
    filters,
    setFilters,
    pagination,
    setPage,
    setPageSize,
    squareOffJob,
    dismissSquareOffJob,
    reconnect,
    refreshAndGetDetails,
    getDetails,
    squareOff,
    squareOffAsync,
    squareOffAllAsync,
    squareOffByStrategiesAsync,
    completeTradeAsync,
    completeTradesBulkAsync,
    squareOffTradeAsync,
    cancelTradeAsync,
    exitPositionsAsync,
    setExpandedRowKey,
    expandedRowDetails,
    expandedRowKey,
    refreshingExpandedKey,
  } = useTerminal({ enableRealtime: true });

  // Live market status from the server (authoritative exchange timing) — gates market-dependent
  // actions (square-off / bulk-complete) on real state instead of a client-side guess.
  const { data: marketStatus } = useQuery({
    queryKey: ['exchange-market-status'],
    queryFn: () => exchangeService.getMarketStatus(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  // Any active exchange currently open? Default to OPEN while we don't yet know (avoid disabling
  // the controls / flashing the "closed" banner during the first load).
  const anyMarketOpen = marketStatus
    ? marketStatus.some((e) => e.isActive && e.isMarketOpen)
    : true;

  // Track which users are being refreshed/squared off
  const [refreshingUsers, setRefreshingUsers] = useState<Set<string>>(new Set());
  const [squaringOffUsers, setSquaringOffUsers] = useState<Set<string>>(new Set());

  // Strategy Summary / Risk Profile are now separate side panels (each permission-gated).
  const [showStrategySummary, setShowStrategySummary] = useState(false);
  const [showRiskProfile, setShowRiskProfile] = useState(false);

  // PnL chart panel state
  const [showPnlChart, setShowPnlChart] = useState(false);

  // Live / paper / mixed view filter for the summary rows + expanded trades.
  // Initial value comes from the 'admin.terminal.trading.mode.default' system
  // config (loaded below); falls back to 'live' until/unless it resolves.
  const [tradingMode, setTradingMode] = useState<'live' | 'paper' | 'mixed'>('live');

  // Load the deployment default for the trading-mode filter once on mount.
  useEffect(() => {
    let cancelled = false;
    systemConfigService
      .getByProperty('admin.terminal.trading.mode.default')
      .then((cfg) => {
        const raw = (cfg?.value || '').trim().toLowerCase();
        const v = raw === 'all' ? 'mixed' : raw; // accept 'all' as a synonym for mixed
        if (!cancelled && (v === 'live' || v === 'paper' || v === 'mixed')) {
          setTradingMode(v);
        }
      })
      .catch(() => {
        /* config missing/unreadable — keep the 'live' default */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Strategy states panel state
  const [showStrategyStates, setShowStrategyStates] = useState(false);

  // Hedge windows panel state
  const [showHedgeWindows, setShowHedgeWindows] = useState(false);

  // Testing panel state

  // Exported signals (strategy-bridge) panel state

  // Overall square off modal state
  const [showSquareOffAllModal, setShowSquareOffAllModal] = useState(false);
  const [squareOffAllProduct, setSquareOffAllProduct] = useState<SquareOffProduct>('ALL');
  const [squareOffAllConfirmText, setSquareOffAllConfirmText] = useState('');
  const [isSquaringOffAll, setIsSquaringOffAll] = useState(false);

  // Square off by strategies modal state
  const [showSquareOffByStrategiesModal, setShowSquareOffByStrategiesModal] = useState(false);
  const [selectedStrategies, setSelectedStrategies] = useState<Set<string>>(new Set());
  const [squareOffStrategiesConfirmText, setSquareOffStrategiesConfirmText] = useState('');
  const [isSquaringOffByStrategies, setIsSquaringOffByStrategies] = useState(false);

  // Bulk complete modal state
  const [showBulkCompleteModal, setShowBulkCompleteModal] = useState(false);
  const [isLoadingBulkCompleteSymbols, setIsLoadingBulkCompleteSymbols] = useState(false);
  const [isFetchingBulkCompleteTrades, setIsFetchingBulkCompleteTrades] = useState(false);
  const [isSubmittingBulkComplete, setIsSubmittingBulkComplete] = useState(false);
  const [bulkCompleteFilterUser, setBulkCompleteFilterUser] = useState('');
  const [bulkCompleteFilterBroker, setBulkCompleteFilterBroker] = useState('');
  const [bulkCompleteFilterSymbol, setBulkCompleteFilterSymbol] = useState('');
  const [bulkCompleteFilterStrategy, setBulkCompleteFilterStrategy] = useState('');
  const [bulkCompleteSymbols, setBulkCompleteSymbols] = useState<string[]>([]);
  const [bulkCompleteTrades, setBulkCompleteTrades] = useState<BulkCompleteTradeRow[]>([]);
  const [selectedBulkTradeIds, setSelectedBulkTradeIds] = useState<Set<string>>(new Set());
  const [bulkExitPrices, setBulkExitPrices] = useState<Record<string, string>>({});
  const [bulkExitDates, setBulkExitDates] = useState<Record<string, string>>({});
  const [bulkCompleteResults, setBulkCompleteResults] = useState<Record<string, BulkCompleteTradeStatus>>({});

  // Fleet-wide square-off counts (ALL accessible users, not the current page) — fetched only while
  // a square-off modal is open, so the heavy all-users aggregation runs on demand, not every poll.
  const { data: squareOffPreview, isFetching: isFetchingPreview } = useQuery({
    queryKey: ['squareoff-preview'],
    queryFn: () => terminalService.getSquareOffPreview(),
    enabled: showSquareOffAllModal || showSquareOffByStrategiesModal,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });

  // Strategy lists for the "by strategies" modal, derived from the server-wide preview (falls back
  // to nothing until loaded). One group per engine-managed product — the old code was a binary
  // `POSITIONAL ? positional : intraday`, which listed every CASHBUY / MTF equity strategy under
  // "Intraday Strategies". Anything the server reports with a non-tradable product falls into
  // "Other" instead of being silently mislabelled.
  const previewStrategyGroups = useMemo(() => {
    const groups = new Map<TradableProduct | 'OTHER', [string, number][]>();
    TRADABLE_PRODUCTS.forEach((p) => groups.set(p, []));
    groups.set('OTHER', []);
    (squareOffPreview?.byStrategy ?? []).forEach((s) => {
      const key = toTradableProduct(s.product) ?? 'OTHER';
      groups.get(key)!.push([s.strategy, s.activeTrades]);
    });
    return Array.from(groups.entries())
      .map(([key, rows]) => ({
        key,
        label: key === 'OTHER' ? 'Other' : PRODUCT_LABELS[key],
        badgeBg: key === 'OTHER' ? 'secondary' : PRODUCT_BADGE_BG[key],
        rows: rows.sort((a, b) => a[0].localeCompare(b[0])),
      }))
      // Keep the two long-standing columns always visible; only show the newer / catch-all
      // groups once the fleet actually has strategies in them.
      .filter((g) => g.key === 'INTRADAY' || g.key === 'POSITIONAL' || g.rows.length > 0);
  }, [squareOffPreview]);

  const todayDate = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);

  const resetBulkCompleteModal = useCallback(() => {
    setShowBulkCompleteModal(false);
    setBulkCompleteFilterUser('');
    setBulkCompleteFilterBroker('');
    setBulkCompleteFilterSymbol('');
    setBulkCompleteFilterStrategy('');
    setBulkCompleteTrades([]);
    setBulkCompleteSymbols([]);
    setSelectedBulkTradeIds(new Set());
    setBulkExitPrices({});
    setBulkExitDates({});
    setBulkCompleteResults({});
  }, []);

  const mapCatalogItemToBulkTradeRow = useCallback((trade: ActiveTradeCatalogItem): BulkCompleteTradeRow => ({
    username: trade.username,
    broker: trade.broker,
    tradeID: trade.tradeID,
    strategy: trade.strategy,
    tradingSymbol: trade.tradingSymbol,
    product: trade.product,
    productType: trade.productType,
    group: trade.group,
    direction: trade.direction,
    quantity: trade.quantity,
    filledQuantity: trade.filledQuantity,
    entry: trade.entry,
    cmp: trade.cmp,
    startTimestamp: trade.startTimestamp,
  }), []);

  const openBulkCompleteModal = useCallback(() => {
    setShowBulkCompleteModal(true);
    setBulkCompleteTrades([]);
    setBulkCompleteSymbols([]);
    setSelectedBulkTradeIds(new Set());
    setBulkExitPrices({});
    setBulkExitDates({});
    setBulkCompleteResults({});
  }, []);

  // Broker filter options — scoped to the caller's brokers (admins: full catalog; supervisor: only
  // their users' brokers), the same source as the User Brokers page. Broker filtering is server-side,
  // so a broker stays selectable even when no row for it is on the current page.
  const brokers = useScopedBrokerNames();

  // Auto-select when only one broker exists
  useEffect(() => {
    if (brokers.length === 1 && !filters.broker) {
      setFilters({ ...filters, broker: brokers[0] });
    }
  }, [brokers]);

  // (Strategy lists for the by-strategies modal now come from the server-wide preview —
  //  see previewStrategiesByProduct above — so the counts cover ALL users, not just this page.)

  // Bulk-complete filter sources are NO LONGER derived from the current terminal page:
  // the user picker now searches remotely (server-scoped), so the chosen user may not be
  // on this page. Brokers come from the full scoped broker list; strategies reuse the same
  // scoped source as the P&L / EOD PnL reports pages.
  const reportsStrategyOptions = useReportsStrategyOptions();

  // Brokers scoped to the caller (admins: full catalog; supervisor: only their users' brokers) —
  // same source as the P&L / EOD PnL reports pages. NOT the full broker list.
  const bulkCompleteBrokerOptions = useScopedBrokerNames();

  const bulkCompleteStrategyOptions = useMemo(() => {
    const byName = new Map<string, string>();
    reportsStrategyOptions.forEach((s) => {
      if (!byName.has(s.strategyName)) {
        byName.set(s.strategyName, s.displayName || s.strategyName);
      }
    });
    return Array.from(byName.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [reportsStrategyOptions]);

  const bulkCompleteSymbolOptions = useMemo(() => {
    return [...bulkCompleteSymbols].sort();
  }, [bulkCompleteSymbols]);

  // Calculate dashboard metrics (mode-aware: live = total - paper, paper, mixed = total)
  const metrics = useMemo(() => {
    const totalUsers = filteredSummaries.length;
    const loggedInUsers = filteredSummaries.filter(s => s.isLoggedIn).length;
    const usersWithActiveTrades = filteredSummaries.filter(
      s => countForMode(s.activeTradesCount, s.paperActiveTradesCount, tradingMode) > 0
    ).length;
    // Mismatch is live-only (paper positions never reconcile).
    const usersWithMismatch = tradingMode === 'paper'
      ? 0 : filteredSummaries.filter(s => s.mismatchSeverity !== 'NONE').length;
    const criticalMismatches = tradingMode === 'paper'
      ? 0 : filteredSummaries.filter(s => s.mismatchSeverity === 'CRITICAL').length;

    const totalNetPnl = filteredSummaries.reduce((sum, s) => sum + valueForMode(s.netPnl, s.paperNetPnl, tradingMode), 0);
    const totalRealizedPnl = filteredSummaries.reduce((sum, s) => sum + valueForMode(s.realizedPnl, s.paperRealizedPnl, tradingMode), 0);
    const totalUnrealizedPnl = filteredSummaries.reduce((sum, s) => sum + valueForMode(s.unrealizedPnl, s.paperUnrealizedPnl, tradingMode), 0);
    const totalPnl = filteredSummaries.reduce((sum, s) => sum + valueForMode(s.totalPnl, s.paperTotalPnl, tradingMode), 0);
    const totalCharges = filteredSummaries.reduce((sum, s) => sum + valueForMode(s.totalCharges, s.paperTotalCharges, tradingMode), 0);
    const totalActiveTrades = filteredSummaries.reduce((sum, s) => sum + countForMode(s.activeTradesCount, s.paperActiveTradesCount, tradingMode), 0);
    const totalCompletedTrades = filteredSummaries.reduce((sum, s) => sum + countForMode(s.completedTradesCount, s.paperCompletedTradesCount, tradingMode), 0);
    const totalOpenTrades = filteredSummaries.reduce((sum, s) => sum + countForMode(s.openTradesCount, s.paperOpenTradesCount, tradingMode), 0);
    const totalCancelledTrades = filteredSummaries.reduce((sum, s) => sum + countForMode(s.cancelledTradesCount, s.paperCancelledTradesCount, tradingMode), 0);

    // Capital is not mode-split — always the configured total (used as % denominator).
    const totalCapital = filteredSummaries.reduce((sum, s) => sum + (s.totalCapital || 0), 0);
    const totalExternalCapital = filteredSummaries.reduce((sum, s) => sum + (s.externalCapital || 0), 0);

    // Algo P&L breakdown
    const algoIntradayPnl = filteredSummaries.reduce((sum, s) => sum + valueForMode(s.algoIntradayPnl, s.paperAlgoIntradayPnl, tradingMode), 0);
    const algoPositionalPnl = filteredSummaries.reduce((sum, s) => sum + valueForMode(s.algoPositionalPnl, s.paperAlgoPositionalPnl, tradingMode), 0);
    const algoTotalPnl = filteredSummaries.reduce((sum, s) => sum + valueForMode(s.algoPnl, s.paperAlgoPnl, tradingMode), 0);

    // Broker P&L breakdown
    const brokerIntradayPnl = filteredSummaries.reduce((sum, s) => sum + valueForMode(s.brokerIntradayPnl, s.paperBrokerIntradayPnl, tradingMode), 0);
    const brokerPositionalPnl = filteredSummaries.reduce((sum, s) => sum + valueForMode(s.brokerPositionalPnl, s.paperBrokerPositionalPnl, tradingMode), 0);
    const brokerTotalPnl = filteredSummaries.reduce((sum, s) => sum + valueForMode(s.brokerPnl, s.paperBrokerPnl, tradingMode), 0);

    // Returns percentages
    const algoReturnsPercent = totalCapital > 0 ? (algoTotalPnl / totalCapital) * 100 : 0;
    const brokerReturnsPercent = (totalCapital + totalExternalCapital) > 0
      ? (brokerTotalPnl / (totalCapital + totalExternalCapital)) * 100
      : 0;

    return {
      totalUsers,
      loggedInUsers,
      usersWithActiveTrades,
      usersWithMismatch,
      criticalMismatches,
      totalNetPnl,
      totalRealizedPnl,
      totalUnrealizedPnl,
      totalPnl,
      totalCharges,
      totalActiveTrades,
      totalCompletedTrades,
      totalOpenTrades,
      totalCancelledTrades,
      totalCapital,
      totalExternalCapital,
      algoIntradayPnl,
      algoPositionalPnl,
      algoTotalPnl,
      brokerIntradayPnl,
      brokerPositionalPnl,
      brokerTotalPnl,
      algoReturnsPercent,
      brokerReturnsPercent,
    };
  }, [filteredSummaries, tradingMode]);

  // Handle refresh with tracking - returns details for the row to update
  const handleRefresh = useCallback(async (username: string, broker: string) => {
    const key = `${username}-${broker}`;
    setRefreshingUsers(prev => new Set(prev).add(key));
    try {
      const details = await refreshAndGetDetails(username, broker);
      return details;
    } finally {
      setRefreshingUsers(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [refreshAndGetDetails]);

  // Handle square off with tracking
  const handleSquareOff = useCallback((
    username: string,
    broker: string,
    product: SquareOffProduct
  ) => {
    const key = `${username}-${broker}`;
    setSquaringOffUsers(prev => new Set(prev).add(key));
    squareOff({
      username,
      broker,
      product,
    });
    // Remove from set after completion
    setTimeout(() => {
      setSquaringOffUsers(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, 5000);
  }, [squareOff]);

  // Handle strategy-specific square off (returns Promise for UI feedback)
  const handleSquareOffStrategy = useCallback(async (request: TerminalSquareOffRequest) => {
    const key = `${request.username}-${request.broker}`;
    setSquaringOffUsers(prev => new Set(prev).add(key));
    try {
      await squareOffAsync(request);
    } finally {
      // Remove from set after completion
      setTimeout(() => {
        setSquaringOffUsers(prev => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }, 2000);
    }
  }, [squareOffAsync]);

  // Get last update time
  const lastUpdateTime = useMemo(() => {
    if (filteredSummaries.length === 0) return null;
    const maxTime = Math.max(...filteredSummaries.map(s => s.lastUpdatedAt || 0));
    return maxTime > 0 ? new Date(maxTime) : null;
  }, [filteredSummaries]);

  // Handle complete single trade
  const handleCompleteTrade = useCallback(async (
    username: string,
    broker: string,
    tradeID: string,
    exitPrice: number,
    exitDate?: string
  ) => {
    await completeTradeAsync(username, broker, tradeID, exitPrice, exitDate);
  }, [completeTradeAsync]);

  // Handle square off single trade
  const handleSquareOffTrade = useCallback(async (
    username: string,
    broker: string,
    tradeID: string,
    product?: SquareOffProduct
  ) => {
    await squareOffTradeAsync(username, broker, tradeID, product);
  }, [squareOffTradeAsync]);

  // Handle cancel open trade
  const handleCancelTrade = useCallback(async (
    username: string,
    broker: string,
    tradeID: string
  ) => {
    await cancelTradeAsync(username, broker, tradeID);
  }, [cancelTradeAsync]);

  // Handle exit positions (for Compare Positions tab)
  const handleExitPositions = useCallback(async (request: ExitPositionRequest) => {
    return await exitPositionsAsync(request);
  }, [exitPositionsAsync]);

  // Handle overall square off for all users
  const handleSquareOffAll = useCallback(async () => {
    if (squareOffAllConfirmText.toUpperCase() !== 'SQUAREOFF') {
      return;
    }

    setIsSquaringOffAll(true);
    try {
      // Send broker: "all" to square off across all brokers in a single request
      await squareOffAllAsync(squareOffAllProduct, 'all');
      setShowSquareOffAllModal(false);
      setSquareOffAllConfirmText('');
    } finally {
      setIsSquaringOffAll(false);
    }
  }, [squareOffAllConfirmText, squareOffAllProduct, squareOffAllAsync]);

  // Handle square off by strategies for all users
  const handleSquareOffByStrategies = useCallback(async () => {
    if (squareOffStrategiesConfirmText.toUpperCase() !== 'SQUAREOFF' || selectedStrategies.size === 0) {
      return;
    }

    setIsSquaringOffByStrategies(true);
    try {
      await squareOffByStrategiesAsync(Array.from(selectedStrategies));
      setShowSquareOffByStrategiesModal(false);
      setSquareOffStrategiesConfirmText('');
      setSelectedStrategies(new Set());
    } finally {
      setIsSquaringOffByStrategies(false);
    }
  }, [squareOffStrategiesConfirmText, selectedStrategies, squareOffByStrategiesAsync]);

  // Toggle strategy selection
  const toggleStrategySelection = useCallback((strategy: string) => {
    setSelectedStrategies(prev => {
      const next = new Set(prev);
      if (next.has(strategy)) {
        next.delete(strategy);
      } else {
        next.add(strategy);
      }
      return next;
    });
  }, []);

  // Select/deselect all strategies in a category
  const selectAllStrategies = useCallback((strategies: string[], select: boolean) => {
    setSelectedStrategies(prev => {
      const next = new Set(prev);
      strategies.forEach(s => {
        if (select) {
          next.add(s);
        } else {
          next.delete(s);
        }
      });
      return next;
    });
  }, []);

  const handleFetchBulkCompleteTrades = useCallback(() => {
    setIsFetchingBulkCompleteTrades(true);
    terminalService.getActiveTradesCatalog({
      username: bulkCompleteFilterUser || undefined,
      broker: bulkCompleteFilterBroker || undefined,
      strategy: bulkCompleteFilterStrategy || undefined,
      symbol: bulkCompleteFilterSymbol || undefined,
    }).then(trades => {
      const rows = trades.map(mapCatalogItemToBulkTradeRow);
      setBulkCompleteTrades(rows);
      setSelectedBulkTradeIds(new Set());
      setBulkCompleteResults({});
      setBulkExitPrices(
        Object.fromEntries(rows.map(trade => [trade.tradeID, trade.cmp?.toString() || '']))
      );
      setBulkExitDates(
        Object.fromEntries(rows.map(trade => [trade.tradeID, todayDate]))
      );
    }).finally(() => {
      setIsFetchingBulkCompleteTrades(false);
    });
  }, [
    bulkCompleteFilterBroker,
    bulkCompleteFilterStrategy,
    bulkCompleteFilterSymbol,
    bulkCompleteFilterUser,
    mapCatalogItemToBulkTradeRow,
    todayDate,
  ]);

  const handleToggleBulkTradeSelection = useCallback((tradeID: string) => {
    setSelectedBulkTradeIds(prev => {
      const next = new Set(prev);
      if (next.has(tradeID)) {
        next.delete(tradeID);
      } else {
        next.add(tradeID);
      }
      return next;
    });
  }, []);

  const handleToggleSelectAllBulkTrades = useCallback((selectAll: boolean) => {
    setSelectedBulkTradeIds(selectAll ? new Set(bulkCompleteTrades.map(trade => trade.tradeID)) : new Set());
  }, [bulkCompleteTrades]);

  const handleBulkCompleteSubmit = useCallback(async () => {
    const selectedTrades = bulkCompleteTrades.filter(trade => selectedBulkTradeIds.has(trade.tradeID));
    if (selectedTrades.length === 0) return;

    const payload: BulkCompleteTradeItem[] = selectedTrades.map(trade => ({
      username: trade.username,
      broker: trade.broker,
      tradeID: trade.tradeID,
      exitPrice: Number(bulkExitPrices[trade.tradeID] || trade.cmp || 0),
      exitDate: trade.product === 'INTRADAY' ? undefined : (bulkExitDates[trade.tradeID] || todayDate),
    }));

    const usernames = Array.from(new Set(selectedTrades.map(trade => trade.username)));
    const brokersForRequest = Array.from(new Set(selectedTrades.map(trade => trade.broker)));

    setIsSubmittingBulkComplete(true);
    try {
      const results = await completeTradesBulkAsync(
        usernames.length === 1 ? usernames[0] : 'all',
        brokersForRequest.length === 1 ? brokersForRequest[0] : 'all',
        payload
      );
      setBulkCompleteResults(
        Object.fromEntries(
          results.map(result => [
            result.tradeID,
            { status: result.status, message: result.message || '' },
          ])
        )
      );
    } finally {
      setIsSubmittingBulkComplete(false);
    }
  }, [
    bulkCompleteTrades,
    selectedBulkTradeIds,
    bulkExitPrices,
    bulkExitDates,
    todayDate,
    completeTradesBulkAsync,
  ]);

  const allBulkTradesSelected = bulkCompleteTrades.length > 0 && selectedBulkTradeIds.size === bulkCompleteTrades.length;
  const selectedBulkTrades = useMemo(
    () => bulkCompleteTrades.filter(trade => selectedBulkTradeIds.has(trade.tradeID)),
    [bulkCompleteTrades, selectedBulkTradeIds]
  );
  const bulkCompleteHasInvalidSelectedRows = useMemo(() => {
    return selectedBulkTrades.some(trade => {
      const exitPrice = Number(bulkExitPrices[trade.tradeID] || '');
      if (!Number.isFinite(exitPrice) || exitPrice <= 0) return true;
      if (trade.product !== 'INTRADAY' && !(bulkExitDates[trade.tradeID] || '').trim()) return true;
      return false;
    });
  }, [bulkExitDates, bulkExitPrices, selectedBulkTrades]);

  useEffect(() => {
    if (!showBulkCompleteModal) {
      return;
    }

    setIsLoadingBulkCompleteSymbols(true);
    terminalService.getActiveSymbols({
      username: bulkCompleteFilterUser || undefined,
      broker: bulkCompleteFilterBroker || undefined,
      strategy: bulkCompleteFilterStrategy || undefined,
    }).then(symbols => {
      setBulkCompleteSymbols(symbols);
      if (bulkCompleteFilterSymbol && !symbols.includes(bulkCompleteFilterSymbol)) {
        setBulkCompleteFilterSymbol('');
      }
    }).finally(() => {
      setIsLoadingBulkCompleteSymbols(false);
    });
  }, [
    showBulkCompleteModal,
    bulkCompleteFilterUser,
    bulkCompleteFilterBroker,
    bulkCompleteFilterStrategy,
    bulkCompleteFilterSymbol,
  ]);

  return (
    <Container fluid className="terminal-page py-4 px-6">
      {/* Mock-trading session control. Renders only for users with the
          MOCK_TRADING resource and only on weekend/holiday or while a
          session is active. Sysadmins implicitly have all rights. */}


      {/* Header */}
      <Row className="mb-4">
        <Col>
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <BsTerminal size={28} className="text-primary-700 dark:text-primary-400" />
              <div>
                <h4 className="mb-0">Trading Terminal</h4>
                <small className="text-ink-soft">
                  Live monitoring of user trades and positions
                </small>
              </div>
            </div>
            <div className="flex items-center gap-4 terminal-actions-toolbar">
              {/* Live / Paper / Mixed filter — sits left of the summary buttons */}
              <Form.Select
                size="sm"
                value={tradingMode}
                onChange={(e) => setTradingMode(e.target.value as 'live' | 'paper' | 'mixed')}
                style={{ width: '140px' }}
                title="Live, paper-trading, or combined — filters the per-user trade counts and the expanded trades"
              >
                <option value="live">Live</option>
                <option value="paper">Paper</option>
                <option value="mixed">Live + Paper</option>
              </Form.Select>
              {/* Overall Summary Buttons — separate pill chips (see .terminal-actions-toolbar) */}
              <div className="flex items-center gap-2">
                {/* P&L Chart only when the server enables the snapshot writer (else no data to plot). */}
                {isShowTerminalPnlChart() && (
                <Button
                  variant="outline-primary"
                  onClick={() => setShowPnlChart(true)}
                  title="View intraday P&L and margin chart"
                >
                  <BsBarChartLine className="me-1" />
                  P&L Chart
                </Button>
                )}
                                <Button
                  variant="outline-primary"
                  onClick={() => setShowStrategySummary(true)}
                  title="View aggregated strategy summary across all users"
                >
                  <BsPieChart className="me-1" />
                  Strategy Summary
                </Button>
                
                                <Button
                  variant="outline-primary"
                  onClick={() => setShowRiskProfile(true)}
                  title="View combined risk profile across all users"
                >
                  <BsGraphUp className="me-1" />
                  Risk Profile
                </Button>
                
                                <Button
                  variant="outline-primary"
                  onClick={() => setShowStrategyStates(true)}
                  title="View strategy execution states and signals"
                >
                  <BsLightning className="me-1" />
                  Strategy Signals
                </Button>
                
                {true && (
                <Button
                  variant="outline-primary"
                  onClick={() => setShowHedgeWindows(true)}
                  title="View hedge window schedules for POSITIONAL strategies"
                >
                  <BsShieldCheck className="me-1" />
                  Hedge Windows
                </Button>
                )}
              </div>

              {/* Overall Square Off Dropdown — hidden unless SQUARE_OFF Manage */}
                            <Dropdown align="end">
                <Dropdown.Toggle
                  variant="outline-danger"
                  size="sm"
                  id="squareoff-all-dropdown"
                  disabled={!anyMarketOpen}
                >
                  <BsXSquare className="me-1" />
                  Square Off All
                </Dropdown.Toggle>
                <Dropdown.Menu>
                  <Dropdown.Header>Square Off All Users</Dropdown.Header>
                  {/* One entry per engine-managed product — CashBuy and MTF used to have no
                      dropdown entry at all, so those positions were unreachable from here. */}
                  {SQUARE_OFF_PRODUCT_OPTIONS.map(({ value, label }) => (
                    <Dropdown.Item
                      key={value}
                      onClick={() => {
                        setSquareOffAllProduct(value);
                        setShowSquareOffAllModal(true);
                      }}
                    >
                      {label} Only
                    </Dropdown.Item>
                  ))}
                  <Dropdown.Divider />
                  <Dropdown.Item
                    onClick={() => {
                      setSelectedStrategies(new Set());
                      setSquareOffStrategiesConfirmText('');
                      setShowSquareOffByStrategiesModal(true);
                    }}
                  >
                    By Strategies...
                  </Dropdown.Item>
                  <Dropdown.Divider />
                  <Dropdown.Item
                    className="text-danger-600 dark:text-danger-400"
                    onClick={() => {
                      setSquareOffAllProduct('ALL');
                      setShowSquareOffAllModal(true);
                    }}
                  >
                    All Positions
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown>
              
                            <Button
                variant="outline-success"
                size="sm"
                onClick={openBulkCompleteModal}
                disabled={!anyMarketOpen}
              >
                Bulk Set Complete
              </Button>
              
              {/* Last Update */}
              {lastUpdateTime && (
                <div className="flex items-center gap-1 text-ink-soft text-[0.875em]">
                  <BsClock />
                  <span>Updated: {format(lastUpdateTime, 'HH:mm:ss')}</span>
                </div>
              )}
              {/* Connection Status */}
              <ConnectionStatus
                isConnected={isConnected}
                isConnecting={isConnecting}
                reconnectAttempts={reconnectAttempts}
                onReconnect={reconnect}
              />
            </div>
          </div>
        </Col>
      </Row>

      {/* Market Status Alert — only once we know (server-confirmed all exchanges closed) */}
      {marketStatus && !anyMarketOpen && (
        <Alert variant="info" className="mb-4">
          <Alert.Heading className="text-base font-medium mb-1">Market Closed</Alert.Heading>
          <small>The market is currently closed. Data shown is from the last trading session.</small>
        </Alert>
      )}

      {/* Compact Dashboard Row */}
      <Row className="mb-4 items-stretch">
        {/* Trade Stats Card */}
        <Col xs={12} md={3}>
          <Card className="metric-card h-full">
            <Card.Body className="py-2">
              <div className="flex justify-between items-center mb-1">
                <span className="text-ink-soft text-[0.875em]">Users</span>
                <span className="font-bold">{metrics.totalUsers} <Badge bg="success" className="text-[0.875em]">{metrics.loggedInUsers}</Badge></span>
              </div>
              {/* One row, color-coded by the fixed trade-state scheme (same as the
                  row badges below): blue=Active, green=Completed, grey=Open,
                  amber=Cancelled — the color IS the label; tooltips spell it out. */}
              <div className="flex justify-between items-center mb-1">
                <span className="text-ink-soft text-[0.875em]">Trades</span>
                <span className="font-bold tabular-nums">
                  <span className="text-blue-700 dark:text-blue-400" title={`Active: ${metrics.totalActiveTrades}`}>A-{metrics.totalActiveTrades}</span>
                  <span className="mx-1 text-ink-faint">·</span>
                  <span className="text-success-500 dark:text-success-400" title={`Completed: ${metrics.totalCompletedTrades}`}>C-{metrics.totalCompletedTrades}</span>
                  <span className="mx-1 text-ink-faint">·</span>
                  <span className="text-ink-soft" title={`Open: ${metrics.totalOpenTrades}`}>O-{metrics.totalOpenTrades}</span>
                  <span className="mx-1 text-ink-faint">·</span>
                  <span className="text-warning-700 dark:text-warning-400" title={`Cancelled: ${metrics.totalCancelledTrades}`}>CN-{metrics.totalCancelledTrades}</span>
                </span>
              </div>
                            <div className="flex justify-between items-center">
                <span className="text-ink-soft text-[0.875em]">Mismatches</span>
                <span className={`font-bold ${metrics.usersWithMismatch > 0 ? 'text-danger-600 dark:text-danger-400' : 'text-success-500 dark:text-success-400'}`}>
                  {metrics.usersWithMismatch}
                  {metrics.criticalMismatches > 0 && <Badge bg="danger" className="ms-1 text-[0.875em]">{metrics.criticalMismatches}</Badge>}
                </span>
              </div>
              
            </Card.Body>
          </Card>
        </Col>

        {/* P&L Table */}
        <Col xs={12} md={9}>
          <Card className="metric-card h-full">
            <Card.Body className="py-2 px-4">
              <table className="w-full text-sm [&_thead_th]:bg-raised [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:text-ink-faint [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle [&_td]:text-ink [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline [&_th]:!py-1.5 [&_td]:!py-1.5 [&_th]:!px-2 [&_td]:!px-2 [&_tbody_tr]:!border-0 mb-0" style={{ fontSize: '0.9rem' }}>
                <thead>
                  <tr className="text-ink-soft">
                    <th style={{ width: '80px' }}></th>
                    <th className="!text-end">Intraday</th>
                    <th className="!text-end">Positional</th>
                    <th className="!text-end">Total</th>
                    <th className="!text-end" style={{ width: '80px' }}>Returns</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="text-ink-soft font-semibold">Algo</td>
                    <td className="text-end"><PnLDisplay value={metrics.algoIntradayPnl} fullFormat /></td>
                    <td className="text-end"><PnLDisplay value={metrics.algoPositionalPnl} fullFormat /></td>
                    <td className="text-end font-bold"><PnLDisplay value={metrics.algoTotalPnl} fullFormat /></td>
                    <td className={`text-end font-bold ${metrics.algoReturnsPercent >= 0 ? 'text-success-500 dark:text-success-400' : 'text-danger-600 dark:text-danger-400'}`}>
                      {metrics.algoReturnsPercent.toFixed(2)}%
                    </td>
                  </tr>
                                    <tr>
                    <td className="text-ink-soft font-semibold">Broker</td>
                    <td className="text-end"><PnLDisplay value={metrics.brokerIntradayPnl} fullFormat /></td>
                    <td className="text-end"><PnLDisplay value={metrics.brokerPositionalPnl} fullFormat /></td>
                    <td className="text-end font-bold"><PnLDisplay value={metrics.brokerTotalPnl} fullFormat /></td>
                    <td className={`text-end font-bold ${metrics.brokerReturnsPercent >= 0 ? 'text-success-500 dark:text-success-400' : 'text-danger-600 dark:text-danger-400'}`}>
                      {metrics.brokerReturnsPercent.toFixed(2)}%
                    </td>
                  </tr>
                  
                </tbody>
              </table>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {/* Strategy Engine Controls - Sysadmin/Admin only */}
              <Row className="mb-4">
          <Col>
            <EngineMonitor compact />
          </Col>
        </Row>
      

      {/* Filters */}
      {/* totalCount = matching rows across ALL pages (server-side filtered). filteredCount = rows
          shown on the current page after the remaining client-side filters (mismatch/allocation). */}
      <TerminalFilters
        filters={filters}
        onFilterChange={setFilters}
        brokers={brokers}
        totalCount={pagination?.totalCount ?? summaries.length}
        filteredCount={filteredSummaries.length}
      />

      {/* Async bulk square-off job status — persistent banner, manually dismissed
          (no auto-close). Colour tracks the job state. */}
      {squareOffJob && (
        <Alert
          variant={
            squareOffJob.status === 'FAILED'
              ? 'danger'
              : squareOffJob.status === 'COMPLETED'
                ? (squareOffJob.usersFailed > 0 ? 'warning' : 'success')
                : squareOffJob.status === 'RUNNING'
                  ? 'info'
                  : 'secondary'
          }
          dismissible
          onClose={dismissSquareOffJob}
          className="mb-4 py-2"
        >
          <div className="font-bold">
            {/* This job ENQUEUES exits; the actual square-off runs in the background
                dispatcher afterward. So "COMPLETED" = requested/enqueued, not closed. */}
            {squareOffJob.status === 'COMPLETED'
              ? 'Square-off REQUESTED'
              : squareOffJob.status === 'RUNNING'
                ? 'Square-off requesting…'
                : `Square-off ${squareOffJob.status}`}
            {' — '}{squareOffJob.usersProcessed}/{squareOffJob.usersTotal} user(s)
            {squareOffJob.usersFailed > 0 && `, ${squareOffJob.usersFailed} failed`}
            {`, ${squareOffJob.tradesEnqueued} trade(s) enqueued`}
            {squareOffJob.error && ` — ${String(squareOffJob.error).split('\n')[0]}`}
          </div>
          <div className="text-[0.875em] text-ink-soft">
            {squareOffJob.status === 'COMPLETED'
              ? 'Exits enqueued — actual square-off is processing in the background (watch the squareoff pool + active count).'
              : null}
          </div>
          <div className="text-[0.875em] text-ink-soft">
            {squareOffJob.scope || 'scope pending…'}
            {` · job ${squareOffJob.jobId.slice(0, 8)}`}
            {squareOffJob.requestedBy && ` · by ${squareOffJob.requestedBy}`}
          </div>
        </Alert>
      )}

      {/* Server-side pagination (REST + WS share this window). Note: the header
          stats and the filters below operate on the loaded page — full-set
          aggregation/filtering is the deferred server-side-compute work. */}
      {pagination && (
        <TablePagination
          page={pagination.page}
          pageSize={pagination.pageSize}
          totalCount={pagination.totalCount}
          totalPages={pagination.totalPages}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          itemLabel="user-brokers"
          loading={isLoading}
        />
      )}

      {/* Main Table */}
      <TerminalSummaryTable
        summaries={filteredSummaries}
        isLoading={isLoading}
        error={error}
        onRefresh={handleRefresh}
        onSquareOff={handleSquareOff}
        onSquareOffStrategy={handleSquareOffStrategy}
        onGetDetails={getDetails}
        refreshingUsers={refreshingUsers}
        squaringOffUsers={squaringOffUsers}
        onCompleteTrade={handleCompleteTrade}
        onSquareOffTrade={handleSquareOffTrade}
        onCancelTrade={handleCancelTrade}
        onExitPositions={handleExitPositions}
        onExpandedRowChange={setExpandedRowKey}
        expandedRowDetails={expandedRowDetails}
        expandedRowKey={expandedRowKey}
        refreshingExpandedKey={refreshingExpandedKey}
        tradingMode={tradingMode}
      />

      {/* Overall Summary Panel */}
      <OverallSummary
        summaries={filteredSummaries}
        show={showStrategySummary}
        onHide={() => setShowStrategySummary(false)}
        section="strategy"
        tradingMode={tradingMode}
      />
      <OverallSummary
        summaries={filteredSummaries}
        show={showRiskProfile}
        onHide={() => setShowRiskProfile(false)}
        section="risk"
        tradingMode={tradingMode}
      />

      {/* Square Off All Users Confirmation Modal */}
      <Modal
        show={showSquareOffAllModal}
        onHide={() => {
          setShowSquareOffAllModal(false);
          setSquareOffAllConfirmText('');
        }}
        centered
      >
        <Modal.Header closeButton className="bg-danger-600 text-white">
          <Modal.Title>Confirm Square Off All Users</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="danger">
            <strong>Warning:</strong> This action will square off positions for ALL users you have access to.
          </Alert>
          <p>
            You are about to square off{' '}
            <strong>{squareOffScopeLabel(squareOffAllProduct)}</strong>{' '}
            for:
          </p>
          <div className="bg-raised p-4 rounded-md mb-4">
            {squareOffPreview ? (
              <>
                <div>
                  <strong>Users with active trades:</strong> {squareOffPreview.usersWithActiveCount}
                </div>
                <div>
                  <strong>
                    Active Trades{squareOffAllProduct !== 'ALL' ? ` (${PRODUCT_LABELS[squareOffAllProduct]})` : ''}:
                  </strong>{' '}
                  {squareOffAllProduct === 'ALL'
                    ? squareOffPreview.totalActiveTrades
                    : (squareOffPreview.byProduct?.[squareOffAllProduct] ?? 0)}
                </div>
                <div className="text-ink-soft text-[0.875em] mt-1">
                  Across ALL accessible users (server-wide), not just this page.
                </div>
              </>
            ) : (
              <div className="text-ink-soft">
                {isFetchingPreview ? 'Loading fleet-wide counts…' : 'Counts unavailable'}
              </div>
            )}
          </div>
          <Form.Group>
            <Form.Label>
              Type <strong>SQUAREOFF</strong> to confirm:
            </Form.Label>
            <Form.Control
              type="text"
              value={squareOffAllConfirmText}
              onChange={(e) => setSquareOffAllConfirmText(e.target.value)}
              placeholder="SQUAREOFF"
              autoFocus
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            onClick={() => {
              setShowSquareOffAllModal(false);
              setSquareOffAllConfirmText('');
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleSquareOffAll}
            disabled={squareOffAllConfirmText.toUpperCase() !== 'SQUAREOFF' || isSquaringOffAll}
          >
            {isSquaringOffAll ? 'Squaring Off...' : 'Confirm Square Off All'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Square Off By Strategies Modal */}
      <Modal
        show={showSquareOffByStrategiesModal}
        onHide={() => {
          setShowSquareOffByStrategiesModal(false);
          setSquareOffStrategiesConfirmText('');
          setSelectedStrategies(new Set());
        }}
        centered
        size="lg"
      >
        <Modal.Header closeButton className="bg-danger-600 text-white">
          <Modal.Title>Square Off By Strategies</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="danger">
            <strong>Warning:</strong> This action will square off positions for selected strategies across ALL users.
          </Alert>

          {/* One column per engine-managed product (plus a catch-all). Previously hardcoded to
              Intraday + Positional, which mislabelled every CashBuy / MTF equity strategy. */}
          <Row className="mb-4">
            {previewStrategyGroups.map((group) => (
              <Col md={6} key={group.key} className="mb-3">
                <Card className="h-full">
                  <Card.Header className="flex justify-between items-center py-2">
                    <span className="font-bold">{group.label} Strategies</span>
                    <div className="flex gap-1">
                      <Button
                        variant="outline-primary"
                        size="sm"
                        onClick={() => selectAllStrategies(group.rows.map(s => s[0]), true)}
                        disabled={group.rows.length === 0}
                      >
                        All
                      </Button>
                      <Button
                        variant="outline-secondary"
                        size="sm"
                        onClick={() => selectAllStrategies(group.rows.map(s => s[0]), false)}
                        disabled={group.rows.length === 0}
                      >
                        None
                      </Button>
                    </div>
                  </Card.Header>
                  <Card.Body style={{ maxHeight: '300px', overflowY: 'auto' }}>
                    {isFetchingPreview && group.rows.length === 0 ? (
                      <p className="text-ink-soft text-center mb-0">Loading…</p>
                    ) : group.rows.length === 0 ? (
                      <p className="text-ink-soft text-center mb-0">No active {group.label} strategies</p>
                    ) : (
                      group.rows.map(([strategy, count]) => (
                        <Form.Check
                          key={strategy}
                          type="checkbox"
                          id={`${group.key.toLowerCase()}-${strategy}`}
                          label={
                            <span>
                              {strategy}
                              <Badge bg={group.badgeBg} className="ms-2">{count}</Badge>
                            </span>
                          }
                          checked={selectedStrategies.has(strategy)}
                          onChange={() => toggleStrategySelection(strategy)}
                          className="mb-2"
                        />
                      ))
                    )}
                  </Card.Body>
                </Card>
              </Col>
            ))}
          </Row>

          <div className="bg-raised p-4 rounded-md mb-4">
            <div>
              <strong>Selected Strategies:</strong> {selectedStrategies.size}
            </div>
            {selectedStrategies.size > 0 && (
              <div className="mt-1">
                {Array.from(selectedStrategies).map(s => (
                  <Badge key={s} bg="secondary" className="me-1">{s}</Badge>
                ))}
              </div>
            )}
          </div>

          <Form.Group>
            <Form.Label>
              Type <strong>SQUAREOFF</strong> to confirm:
            </Form.Label>
            <Form.Control
              type="text"
              value={squareOffStrategiesConfirmText}
              onChange={(e) => setSquareOffStrategiesConfirmText(e.target.value)}
              placeholder="SQUAREOFF"
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            onClick={() => {
              setShowSquareOffByStrategiesModal(false);
              setSquareOffStrategiesConfirmText('');
              setSelectedStrategies(new Set());
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleSquareOffByStrategies}
            disabled={
              squareOffStrategiesConfirmText.toUpperCase() !== 'SQUAREOFF' ||
              selectedStrategies.size === 0 ||
              isSquaringOffByStrategies
            }
          >
            {isSquaringOffByStrategies
              ? 'Squaring Off...'
              : `Square Off ${selectedStrategies.size} Strategies`}
          </Button>
        </Modal.Footer>
      </Modal>

      <Modal
        show={showBulkCompleteModal}
        onHide={resetBulkCompleteModal}
        size="xl"
        centered
      >
        <Modal.Header closeButton className="bg-success-500 text-white">
          <Modal.Title>Bulk Set Trades As Complete</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="warning">
            Review selected trades carefully before marking them as complete. Exit price defaults to current CMP, and exit date defaults to today.
          </Alert>

          <Row className=" mb-4">
            <Col md={3}>
              <Form.Group>
                <Form.Label>User</Form.Label>
                <UserSelect
                  value={bulkCompleteFilterUser}
                  onChange={(username) => {
                    setBulkCompleteFilterUser(username);
                    setBulkCompleteFilterBroker('');
                    setBulkCompleteFilterStrategy('');
                    setBulkCompleteFilterSymbol('');
                  }}
                  isDisabled={isLoadingBulkCompleteSymbols || isFetchingBulkCompleteTrades}
                />
              </Form.Group>
            </Col>
            <Col md={3}>
              <Form.Group>
                <Form.Label>Broker</Form.Label>
                <Form.Select
                  value={bulkCompleteFilterBroker}
                  onChange={(e) => {
                    setBulkCompleteFilterBroker(e.target.value);
                    setBulkCompleteFilterStrategy('');
                    setBulkCompleteFilterSymbol('');
                  }}
                  disabled={isLoadingBulkCompleteSymbols || isFetchingBulkCompleteTrades}
                >
                  <option value="">All Brokers</option>
                  {bulkCompleteBrokerOptions.map(broker => (
                    <option key={broker} value={broker}>{broker}</option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={3}>
              <Form.Group>
                <Form.Label>Strategy</Form.Label>
                <Form.Select
                  value={bulkCompleteFilterStrategy}
                  onChange={(e) => {
                    setBulkCompleteFilterStrategy(e.target.value);
                    setBulkCompleteFilterSymbol('');
                  }}
                  disabled={isLoadingBulkCompleteSymbols || isFetchingBulkCompleteTrades}
                >
                  <option value="">All Strategies</option>
                  {bulkCompleteStrategyOptions.map(strategy => (
                    <option key={strategy.value} value={strategy.value}>{strategy.label}</option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={3}>
              <Form.Group>
                <Form.Label>Symbol</Form.Label>
                <Form.Select
                  value={bulkCompleteFilterSymbol}
                  onChange={(e) => setBulkCompleteFilterSymbol(e.target.value)}
                  disabled={isLoadingBulkCompleteSymbols || isFetchingBulkCompleteTrades}
                >
                  <option value="">All Symbols</option>
                  {bulkCompleteSymbolOptions.map(symbol => (
                    <option key={symbol} value={symbol}>{symbol}</option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
          </Row>

            <div className="flex justify-between items-center mb-4">
              <div className="text-ink-soft text-[0.875em]">
              {isLoadingBulkCompleteSymbols
                ? 'Loading active symbols...'
                : `${bulkCompleteSymbolOptions.length} active symbols available`}
              </div>
              <Button
                variant="success"
                onClick={handleFetchBulkCompleteTrades}
              disabled={isLoadingBulkCompleteSymbols || isFetchingBulkCompleteTrades}
              >
              {isFetchingBulkCompleteTrades ? (
                <>
                  <Spinner animation="border" size="sm" className="me-2" />
                  Fetching...
                </>
              ) : 'Fetch Trades'}
              </Button>
            </div>

          {bulkCompleteTrades.length > 0 ? (
            <>
              <div className="flex justify-between items-center mb-2">
                <div className="text-ink-soft text-[0.875em]">
                  Showing {bulkCompleteTrades.length} trades. Selected {selectedBulkTradeIds.size}.
                </div>
                <Form.Check
                  type="checkbox"
                  id="bulk-complete-select-all"
                  label="Select All"
                  checked={allBulkTradesSelected}
                  onChange={(e) => handleToggleSelectAllBulkTrades(e.target.checked)}
                />
              </div>
              <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
                <Table striped bordered hover responsive size="sm" className="align-middle">
                  <thead className="bg-raised">
                    <tr>
                      <th style={{ width: '48px' }} />
                      <th>User</th>
                      <th>Broker</th>
                      <th>Strategy</th>
                      <th>Symbol</th>
                      <th>Product</th>
                      <th>Qty</th>
                      <th>Entry</th>
                      <th>CMP</th>
                      <th style={{ minWidth: '120px' }}>Exit Price</th>
                      <th style={{ minWidth: '145px' }}>Exit Date</th>
                      <th style={{ minWidth: '220px' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkCompleteTrades.map(trade => {
                      const selected = selectedBulkTradeIds.has(trade.tradeID);
                      const needsExitDate = trade.product !== 'INTRADAY';
                      const result = bulkCompleteResults[trade.tradeID];
                      return (
                        <tr key={trade.tradeID}>
                          <td>
                            <Form.Check
                              type="checkbox"
                              checked={selected}
                              onChange={() => handleToggleBulkTradeSelection(trade.tradeID)}
                            />
                          </td>
                          <td>{trade.username}</td>
                          <td>{trade.broker}</td>
                          <td>{trade.strategy}</td>
                          <td>{trade.tradingSymbol}</td>
                          <td>
                            <div>{trade.product}</div>
                            <small className="text-ink-soft">{trade.productType}</small>
                          </td>
                          <td>{trade.filledQuantity || trade.quantity}</td>
                          <td>{trade.entry?.toFixed?.(2) ?? trade.entry}</td>
                          <td>{trade.cmp?.toFixed?.(2) ?? trade.cmp}</td>
                          <td>
                            <Form.Control
                              type="number"
                              step="0.05"
                              min="0"
                              value={bulkExitPrices[trade.tradeID] ?? ''}
                              onChange={(e) => setBulkExitPrices(prev => ({ ...prev, [trade.tradeID]: e.target.value }))}
                            />
                          </td>
                          <td>
                            {needsExitDate ? (
                              <Form.Control
                                type="date"
                                value={bulkExitDates[trade.tradeID] ?? todayDate}
                                max={todayDate}
                                onChange={(e) => setBulkExitDates(prev => ({ ...prev, [trade.tradeID]: e.target.value }))}
                              />
                            ) : (
                              <span className="text-ink-soft">Today</span>
                            )}
                          </td>
                          <td>
                            {result ? (
                              result.status === 'success' ? (
                                <Badge bg="success">Success</Badge>
                              ) : (
                                <div>
                                  <Badge bg="danger" className="mb-1">Error</Badge>
                                  <div className="text-[0.875em] text-danger-600 dark:text-danger-400">{result.message}</div>
                                </div>
                              )
                            ) : (
                              <span className="text-ink-soft text-[0.875em]">Not submitted</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            </>
          ) : !isFetchingBulkCompleteTrades ? (
            <Alert variant="light" className="mb-0">
              Use the filters if needed, then click <strong>Fetch Trades</strong> to load matching active trades.
            </Alert>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={resetBulkCompleteModal}>
            Cancel
          </Button>
          <Button
            variant="success"
            onClick={handleBulkCompleteSubmit}
            disabled={
              selectedBulkTradeIds.size === 0 ||
              isSubmittingBulkComplete ||
              bulkCompleteHasInvalidSelectedRows
            }
          >
            {isSubmittingBulkComplete ? 'Setting Complete...' : `Set ${selectedBulkTradeIds.size} Selected Trades As Complete`}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* PnL Chart Bottom Slide Panel */}
      <BottomSlidePanel
        isOpen={showPnlChart}
        onClose={() => setShowPnlChart(false)}
        title="Day P&L & Margin Chart"
        subtitle="Aggregated view across all users"
        height="70vh"
      >
        <PnlChart liveSummaries={summaries} tradingMode={tradingMode} algoOnly={!true} />
      </BottomSlidePanel>

      {/* Strategy States Panel */}
      <StrategyStatesPanel
        show={showStrategyStates}
        onHide={() => setShowStrategyStates(false)}
      />

      {/* Hedge Windows Panel */}
      <HedgeWindowsPanel
        show={showHedgeWindows}
        onHide={() => setShowHedgeWindows(false)}
      />
    </Container>
  );
};

export default TerminalPage;
