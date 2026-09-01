/**
 * Shared Reports Page
 * Used by both Admin and Client Manager portals
 * Comprehensive reports including Trades, EOD PnL, Capital History, and Unaccounted PnL
 */

import { useState, useMemo, useEffect, useCallback } from 'react';
import clsx from 'clsx';
import { BsFileText } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import UserSelect from '@/components/common/UserSelect';
import { useQuery } from '@tanstack/react-query';
import { tradeService, eodPnlService } from '@/services/admin/v2AdminService';
import { useScopedBrokerNames } from '@/hooks/useScopedBrokerNames';
import { useReportsStrategyOptions } from '@/hooks/useReportsStrategyOptions';
import { formatIndianNumber } from '@/utils/formatters';
import type { EODPnlReport, EODPnlResponse } from '@/types/reports';
import { Badge, Button, Spinner, Tooltip } from '@/components/ui';
import { TRADABLE_PRODUCTS, PRODUCT_LABELS, type TradableProduct } from '@/types/product';

const card = 'rounded-card border border-hairline bg-card';
const cell = 'px-2 py-1.5';
const flabel = 'mb-1 block text-xs text-ink-soft';
const ctrl = 'h-[31px] w-full rounded border border-hairline bg-card px-2 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60';
const thRow = 'bg-raised text-xs uppercase text-ink-faint';
const summaryStrip = 'flex flex-wrap gap-4 border-b border-hairline bg-raised px-3 py-2 text-sm text-ink';
const dangerBox = 'm-3 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400';

const tabBtn = (active: boolean) =>
  clsx(
    '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
    active ? 'border-primary-500 text-primary-500' : 'border-transparent text-ink-soft hover:text-ink',
  );

const ReportsPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'trades' | 'eod-pnl'>('trades');

  return (
    <div>
      <PageHeader title="Reports" subtitle="View trades and PnL reports" icon={<BsFileText size={24} />} />

      <div className="mb-3 flex flex-wrap gap-1 border-b border-hairline">
        <button type="button" className={tabBtn(activeTab === 'trades')} onClick={() => setActiveTab('trades')}>Trades</button>
        <button type="button" className={tabBtn(activeTab === 'eod-pnl')} onClick={() => setActiveTab('eod-pnl')}>EOD PnL</button>
      </div>
      {activeTab === 'trades' ? <TradesPanel /> : <EODPnlPanel />}
    </div>
  );
};

// ==================== TRADES PANEL ====================
// Since V306 every product lives in the single TRADES table and the API's `tradeType` is just a row
// filter, so it accepts every tradable product — MTF included. The tabs are derived from the shared
// product constants: a product added there shows up here automatically.
const TRADE_TAB_TITLES: Partial<Record<TradableProduct, string>> = {
  CASHBUY: 'Equity delivery paid for in full (CNC).',
  MTF: 'Equity delivery funded by the broker (MTF) — funding interest is reported in its own column, never folded into charges.',
};
const TRADE_PRODUCTS: { key: TradableProduct; label: string; title?: string }[] = TRADABLE_PRODUCTS.map((key) => ({
  key,
  label: PRODUCT_LABELS[key],
  title: TRADE_TAB_TITLES[key],
}));

interface TradesSummary {
  totalTrades: number;
  totalPnl: number;
  totalCharges: number;
  totalNetPnl: number;
  totalBrokerage?: number;
  totalTurnover?: number;
  totalStt?: number;
  totalSebi?: number;
  totalStampDuty?: number;
  totalGst?: number;
  totalDepository?: number;
}

interface ChargeBreakdown {
  brokerage: number;
  transaction: number;
  stt: number;
  sebi: number;
  stampDuty: number;
  gst: number;
  depository: number;
  total: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rowChargeBreakdown = (t: any): ChargeBreakdown => ({
  brokerage: t.brokerageCharges || 0,
  transaction: t.turnoverCharges || 0,
  stt: t.sttCharges || 0,
  sebi: t.sebiCharges || 0,
  stampDuty: t.stampDutyCharges || 0,
  gst: t.gstCharges || 0,
  depository: t.depositoryCharges || 0,
  total: t.charges || 0,
});

const summaryChargeBreakdown = (s: TradesSummary): ChargeBreakdown => ({
  brokerage: s.totalBrokerage || 0,
  transaction: s.totalTurnover || 0,
  stt: s.totalStt || 0,
  sebi: s.totalSebi || 0,
  stampDuty: s.totalStampDuty || 0,
  gst: s.totalGst || 0,
  depository: s.totalDepository || 0,
  total: s.totalCharges || 0,
});

// Wraps a Charges value with a hover tooltip that splits it into its components.
const ChargesCell: React.FC<{ breakdown: ChargeBreakdown; children: React.ReactNode }> = ({ breakdown, children }) => {
  const rows: Array<[string, number]> = [
    ['Brokerage', breakdown.brokerage],
    ['Transaction', breakdown.transaction],
    ['STT', breakdown.stt],
    ['SEBI', breakdown.sebi],
    ['Stamp Duty', breakdown.stampDuty],
    ['GST', breakdown.gst],
  ];
  if (breakdown.depository > 0) rows.push(['Depository', breakdown.depository]);
  const label = (
    <span className="block min-w-[160px] text-left">
      <span className="mb-1 block font-semibold">Charges breakdown</span>
      {rows.map(([lbl, val]) => (
        <span key={lbl} className="flex justify-between gap-3">
          <span className="opacity-70">{lbl}</span>
          <span>{formatIndianNumber(val, false)}</span>
        </span>
      ))}
      <span className="mt-1 flex justify-between gap-3 border-t border-white/20 pt-1 font-semibold">
        <span>Total</span>
        <span>{formatIndianNumber(breakdown.total, false)}</span>
      </span>
    </span>
  );
  return (
    <Tooltip label={label} placement="top">
      <span className="cursor-help underline decoration-dotted">{children}</span>
    </Tooltip>
  );
};

interface TradesFilterState {
  username: string;
  broker: string;
  strategy: string;
  mode: 'live' | 'paper' | 'mixed';
  fromDate: string;
  toDate: string;
}

const formatDate = (d: Date) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const TradesPanel: React.FC = () => {
  const getDefaultDates = () => {
    const today = new Date();
    const oneWeekAgo = new Date(today);
    oneWeekAgo.setDate(today.getDate() - 7);
    return { fromDate: formatDate(oneWeekAgo), toDate: formatDate(today) };
  };

  const defaultDates = getDefaultDates();
  const defaultFilter: TradesFilterState = { username: '', broker: '', strategy: '', mode: 'live', fromDate: defaultDates.fromDate, toDate: defaultDates.toDate };

  const [filter, setFilter] = useState<TradesFilterState>(defaultFilter);
  const [submittedFilter, setSubmittedFilter] = useState<TradesFilterState>(defaultFilter);

  const brokerNames = useScopedBrokerNames();
  const strategies = useReportsStrategyOptions();

  useEffect(() => {
    if (brokerNames.length === 1 && !filter.broker) {
      setFilter((f) => ({ ...f, broker: brokerNames[0] }));
    }
  }, [brokerNames]);

  const strategyDisplayNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    strategies?.forEach((s) => {
      map[s.strategyName] = s.displayName || s.strategyName;
    });
    return map;
  }, [strategies]);

  const [activeProduct, setActiveProduct] = useState<TradableProduct>('INTRADAY');

  const [productSummaries, setProductSummaries] = useState<Partial<Record<TradableProduct, TradesSummary | null>>>({});
  const handleProductSummary = useCallback((product: TradableProduct, summary: TradesSummary | null) => {
    setProductSummaries((prev) => ({ ...prev, [product]: summary }));
  }, []);

  const combined = useMemo(() => {
    const acc: TradesSummary = { totalTrades: 0, totalPnl: 0, totalCharges: 0, totalNetPnl: 0, totalBrokerage: 0, totalTurnover: 0, totalStt: 0, totalSebi: 0, totalStampDuty: 0, totalGst: 0, totalDepository: 0 };
    for (const p of TRADE_PRODUCTS) {
      const s = productSummaries[p.key];
      if (s) {
        acc.totalTrades += s.totalTrades || 0;
        acc.totalPnl += s.totalPnl || 0;
        acc.totalCharges += s.totalCharges || 0;
        acc.totalNetPnl += s.totalNetPnl || 0;
        acc.totalBrokerage! += s.totalBrokerage || 0;
        acc.totalTurnover! += s.totalTurnover || 0;
        acc.totalStt! += s.totalStt || 0;
        acc.totalSebi! += s.totalSebi || 0;
        acc.totalStampDuty! += s.totalStampDuty || 0;
        acc.totalGst! += s.totalGst || 0;
        acc.totalDepository! += s.totalDepository || 0;
      }
    }
    return acc;
  }, [productSummaries]);

  const handleSubmit = () => setSubmittedFilter({ ...filter });

  return (
    <div className={card}>
      <div className="border-b border-hairline p-3">
        <div className="grid grid-cols-2 items-end gap-2 md:grid-cols-3 lg:grid-cols-6">
          <div>
            <label className={flabel}>Username</label>
            <UserSelect value={filter.username} onChange={(username) => setFilter({ ...filter, username })} />
          </div>
          <div>
            <label className={flabel}>Broker</label>
            <select className={ctrl} value={filter.broker} onChange={(e) => setFilter({ ...filter, broker: e.target.value })}>
              <option value="">All Brokers</option>
              {brokerNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={flabel}>Mode</label>
            <select className={ctrl} value={filter.mode} onChange={(e) => setFilter({ ...filter, mode: e.target.value as 'live' | 'paper' | 'mixed' })}>
              <option value="live">Live</option>
              <option value="paper">Paper</option>
              <option value="mixed">Live + Paper</option>
            </select>
          </div>
          <div>
            <label className={flabel}>Strategy</label>
            <select className={ctrl} value={filter.strategy} onChange={(e) => setFilter({ ...filter, strategy: e.target.value })}>
              <option value="">All Strategies</option>
              {(strategies || []).map((s) => (
                <option key={s.strategyName} value={s.strategyName}>{s.displayName || s.strategyName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={flabel}>From Date</label>
            <input type="date" className={ctrl} value={filter.fromDate} onChange={(e) => setFilter({ ...filter, fromDate: e.target.value })} />
          </div>
          <div>
            <label className={flabel}>To Date</label>
            <input type="date" className={ctrl} value={filter.toDate} onChange={(e) => setFilter({ ...filter, toDate: e.target.value })} />
          </div>
        </div>
        <div className="mt-2">
          <Button variant="primary" onClick={handleSubmit} style={{ width: 120, height: 31 }}>Submit</Button>
        </div>
      </div>
      <div>
        {/* Combined totals across ALL products */}
        <div className={summaryStrip}>
          <span className="text-ink-soft">All products:</span>
          <span><strong>Trades:</strong> {combined.totalTrades}</span>
          <span><strong>P&L:</strong> <span className={combined.totalPnl >= 0 ? 'text-success-500' : 'text-danger-500'}>{formatIndianNumber(combined.totalPnl, false)}</span></span>
          <span><strong>Charges:</strong> <ChargesCell breakdown={summaryChargeBreakdown(combined)}>{formatIndianNumber(combined.totalCharges, false)}</ChargesCell></span>
          <span><strong>Net P&L:</strong> <span className={combined.totalNetPnl >= 0 ? 'font-bold text-success-500' : 'font-bold text-danger-500'}>{formatIndianNumber(combined.totalNetPnl, false)}</span></span>
        </div>
        {/* One tab per product — all of them stay mounted (their summaries feed the combined total); only the active is visible. */}
        <div className="flex flex-wrap gap-1 border-b border-hairline px-2 pt-2">
          {TRADE_PRODUCTS.map((p) => {
            const s = productSummaries[p.key];
            return (
              <button key={p.key} type="button" title={p.title} className={tabBtn(activeProduct === p.key)} onClick={() => setActiveProduct(p.key)}>
                {p.label}{s ? ` (${s.totalTrades})` : ''}
              </button>
            );
          })}
        </div>
        {TRADE_PRODUCTS.map((p) => (
          <div key={p.key} className={activeProduct === p.key ? '' : 'hidden'}>
            <ProductTradesTab product={p.key} submittedFilter={submittedFilter} strategyDisplayNameMap={strategyDisplayNameMap} onSummary={handleProductSummary} />
          </div>
        ))}
      </div>
    </div>
  );
};

// ==================== PRODUCT TRADES TAB (one per product) ====================
interface ProductTradesTabProps {
  product: TradableProduct;
  submittedFilter: TradesFilterState;
  strategyDisplayNameMap: Record<string, string>;
  onSummary: (product: TradableProduct, summary: TradesSummary | null) => void;
}

const ProductTradesTab: React.FC<ProductTradesTabProps> = ({ product, submittedFilter, strategyDisplayNameMap, onSummary }) => {
  const pageSize = 100;
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    setCurrentPage(1);
  }, [submittedFilter]);

  const { data: tradesResponse, isLoading, isError } = useQuery({
    queryKey: ['reports', 'trades', product, submittedFilter, currentPage],
    queryFn: () => tradeService.getTrades({
      username: submittedFilter.username || 'all',
      broker: submittedFilter.broker || undefined,
      tradeType: product,
      mode: submittedFilter.mode || undefined,
      strategy: submittedFilter.strategy || undefined,
      fromDate: submittedFilter.fromDate || undefined,
      toDate: submittedFilter.toDate || undefined,
      page: currentPage,
      pageSize,
    }),
    retry: false,
  });

  const summary = (tradesResponse?.summary as TradesSummary | undefined) || null;
  useEffect(() => {
    onSummary(product, summary);
  }, [summary, product, onSummary]);

  const trades = tradesResponse?.trades || [];
  const totalRecords = tradesResponse?.total || 0;
  const totalPages = tradesResponse?.totalPages || 0;

  const getStrategyDisplayName = (strategyName: string) => strategyDisplayNameMap[strategyName] || strategyName;

  if (isLoading) {
    return <div className="py-10 text-center text-primary-500"><Spinner /></div>;
  }
  if (isError) {
    return <div className={dangerBox}>Failed to load trades. Please check if the server is running.</div>;
  }

  return (
    <>
      {summary && (
        <div className={summaryStrip}>
          <span><strong>Trades:</strong> {summary.totalTrades}</span>
          <span><strong>P&L:</strong> <span className={summary.totalPnl >= 0 ? 'text-success-500' : 'text-danger-500'}>{formatIndianNumber(summary.totalPnl, false)}</span></span>
          <span><strong>Charges:</strong> <ChargesCell breakdown={summaryChargeBreakdown(summary)}>{formatIndianNumber(summary.totalCharges, false)}</ChargesCell></span>
          <span><strong>Net P&L:</strong> <span className={summary.totalNetPnl >= 0 ? 'font-bold text-success-500' : 'font-bold text-danger-500'}>{formatIndianNumber(summary.totalNetPnl, false)}</span></span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
          <thead className={thRow}>
            <tr>
              <th className={`${cell} text-left`}>User</th>
              <th className={`${cell} text-left`}>Broker</th>
              <th className={`${cell} text-left`}>Symbol</th>
              <th className={`${cell} text-left`}>Strategy</th>
              <th className={`${cell} text-left`}>Product</th>
              <th className={`${cell} text-left`}>Direction</th>
              <th className={`${cell} text-right`}>Qty</th>
              <th className={`${cell} text-right`}>Mult</th>
              <th className={`${cell} text-right`}>Entry</th>
              <th className={`${cell} text-right`}>Exit</th>
              <th className={`${cell} text-right`}>P&L</th>
              <th className={`${cell} text-right`}>Charges</th>
              <th className={`${cell} text-right`} title="MTF funding interest — tracked separately, never included in Charges or Net P&L">MTF Int.</th>
              <th className={`${cell} text-right`}>Net P&L</th>
              <th className={`${cell} text-left`}>Start Time</th>
              <th className={`${cell} text-left`}>End Time</th>
              <th className={`${cell} text-left`}>Exit Reason</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 ? (
              <tr><td colSpan={17} className="py-4 text-center text-ink-soft">No trades found</td></tr>
            ) : (
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              trades.map((trade: any) => (
                <tr key={trade.tradeID} className="hover:bg-raised/50">
                  <td className={`${cell} text-ink`}>{trade.username}</td>
                  <td className={cell}><Badge tone="neutral">{trade.broker}</Badge></td>
                  <td className={cell}><code className="text-ink">{trade.tradingSymbol}</code></td>
                  <td className={`${cell} text-ink`}>{getStrategyDisplayName(trade.strategy)}</td>
                  <td className={cell}><Badge tone="info">{trade.product}</Badge></td>
                  <td className={cell}><Badge tone={trade.direction === 'LONG' ? 'success' : 'danger'}>{trade.direction}</Badge></td>
                  <td className={`${cell} text-right text-ink`}>{trade.filledQuantity}/{trade.quantity}</td>
                  <td className={`${cell} text-right text-ink`}>{trade.contractMultiplier || 1}</td>
                  <td className={`${cell} text-right text-ink`}>{trade.entry?.toFixed(2)}</td>
                  <td className={`${cell} text-right text-ink`}>{trade.exit?.toFixed(2)}</td>
                  <td className={`${cell} text-right ${trade.profitLoss >= 0 ? 'text-success-500' : 'text-danger-500'}`}>{trade.profitLoss?.toFixed(2)}</td>
                  <td className={`${cell} text-right text-ink`}><ChargesCell breakdown={rowChargeBreakdown(trade)}>{trade.charges?.toFixed(2)}</ChargesCell></td>
                  <td className={`${cell} text-right text-ink`}>{trade.mtfInterest ? trade.mtfInterest.toFixed(2) : '-'}</td>
                  <td className={`${cell} text-right ${trade.netProfitLoss >= 0 ? 'font-bold text-success-500' : 'font-bold text-danger-500'}`}>{trade.netProfitLoss?.toFixed(2)}</td>
                  <td className={`${cell} text-ink`}>{trade.startTimestamp ? new Date(trade.startTimestamp).toLocaleString() : '-'}</td>
                  <td className={`${cell} text-ink`}>{trade.endTimestamp ? new Date(trade.endTimestamp).toLocaleString() : '-'}</td>
                  <td className={`${cell} text-ink`}>{trade.exitReason || '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-hairline p-2">
        <span className="text-xs text-ink-soft">
          Showing {trades.length > 0 ? (currentPage - 1) * pageSize + 1 : 0} - {Math.min(currentPage * pageSize, totalRecords)} of {totalRecords} trade(s)
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>Previous</Button>
            <span className="text-xs text-ink-soft">Page {currentPage} of {totalPages}</span>
            <Button variant="secondary" size="sm" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>Next</Button>
          </div>
        )}
      </div>
    </>
  );
};

// ==================== EOD PNL PANEL ====================
const EODPnlPanel: React.FC = () => {
  const getDefaultDates = () => {
    const today = new Date();
    const currentMonth = today.getMonth();
    const quarterStartMonth = Math.floor(currentMonth / 3) * 3;
    const quarterStart = new Date(today.getFullYear(), quarterStartMonth, 1);
    return { fromDate: formatDate(quarterStart), toDate: formatDate(today) };
  };

  const defaultDates = getDefaultDates();
  const defaultFilter = {
    username: '',
    broker: '',
    strategy: '',
    // The EOD PnL report filters on the PRODUCT column directly (no per-product table routing),
    // so every engine-managed product is a valid value here — including MTF.
    product: '' as '' | TradableProduct,
    mode: 'live' as 'live' | 'paper' | 'mixed',
    fromDate: defaultDates.fromDate,
    toDate: defaultDates.toDate,
  };

  const [filter, setFilter] = useState(defaultFilter);
  const [submittedFilter, setSubmittedFilter] = useState(defaultFilter);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 100;

  const brokerNames = useScopedBrokerNames();
  const strategies = useReportsStrategyOptions();

  useEffect(() => {
    if (brokerNames.length === 1 && !filter.broker) {
      setFilter((f) => ({ ...f, broker: brokerNames[0] }));
    }
  }, [brokerNames]);

  const strategyOptions = useMemo(() => {
    const all = strategies || [];
    return filter.product ? all.filter((s) => (s.product || '').toUpperCase() === filter.product) : all;
  }, [strategies, filter.product]);

  const strategyDisplayNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    strategies?.forEach((s) => {
      map[s.strategyName] = s.displayName || s.strategyName;
    });
    return map;
  }, [strategies]);

  const getStrategyDisplayName = (strategyName: string) => strategyDisplayNameMap[strategyName] || strategyName;

  const { data: reports, isLoading, isError } = useQuery({
    queryKey: ['reports', 'eodPnl', submittedFilter, currentPage],
    queryFn: () => eodPnlService.getReports({
      username: submittedFilter.username || 'all',
      broker: submittedFilter.broker || 'all',
      strategy: submittedFilter.strategy || 'all',
      product: submittedFilter.product || 'all',
      mode: submittedFilter.mode || undefined,
      fromDate: submittedFilter.fromDate || undefined,
      toDate: submittedFilter.toDate || undefined,
      page: currentPage,
      pageSize,
    }),
    retry: false,
  });

  const handleSubmit = () => {
    setCurrentPage(1);
    setSubmittedFilter({ ...filter });
  };

  const isEodPnlResponse = (data: EODPnlReport[] | EODPnlResponse | undefined): data is EODPnlResponse => {
    return !!data && !Array.isArray(data) && 'records' in data;
  };

  const paginatedReports = useMemo((): EODPnlReport[] => {
    if (!reports) return [];
    return isEodPnlResponse(reports) ? reports.records : reports;
  }, [reports]);

  const totalRecords = isEodPnlResponse(reports) ? reports.total : paginatedReports.length;
  const totalPages = isEodPnlResponse(reports) ? reports.totalPages : Math.ceil(totalRecords / pageSize);

  const summary = useMemo(() => {
    if (isEodPnlResponse(reports) && reports.summary) {
      return {
        totalReports: reports.summary.totalRecords || totalRecords,
        totalPl: reports.summary.totalPnl || 0,
        totalCharges: reports.summary.totalCharges || 0,
        totalNetPl: reports.summary.totalNetPnl || 0,
      };
    }
    if (!paginatedReports || paginatedReports.length === 0) return null;
    return {
      totalReports: paginatedReports.length,
      totalPl: paginatedReports.reduce((sum: number, r) => sum + (r.pl || 0), 0),
      totalCharges: paginatedReports.reduce((sum: number, r) => sum + (r.charges || 0), 0),
      totalNetPl: paginatedReports.reduce((sum: number, r) => sum + (r.netPL || 0), 0),
    };
  }, [reports, paginatedReports, totalRecords]);

  return (
    <div className={card}>
      <div className="border-b border-hairline p-3">
        <div className="grid grid-cols-2 items-end gap-2 md:grid-cols-4 lg:grid-cols-7">
          <div>
            <label className={flabel}>Username</label>
            <UserSelect value={filter.username} onChange={(username) => setFilter({ ...filter, username })} />
          </div>
          <div>
            <label className={flabel}>Broker</label>
            <select className={ctrl} value={filter.broker} onChange={(e) => setFilter({ ...filter, broker: e.target.value })}>
              <option value="">All Brokers</option>
              {brokerNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={flabel}>Product</label>
            <select className={ctrl} value={filter.product} onChange={(e) => setFilter({ ...filter, product: e.target.value as '' | TradableProduct, strategy: '' })}>
              <option value="">All Products</option>
              {TRADABLE_PRODUCTS.map((product) => (
                <option key={product} value={product}>{PRODUCT_LABELS[product]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={flabel}>Mode</label>
            <select className={ctrl} value={filter.mode} onChange={(e) => setFilter({ ...filter, mode: e.target.value as 'live' | 'paper' | 'mixed' })}>
              <option value="live">Live</option>
              <option value="paper">Paper</option>
              <option value="mixed">Live + Paper</option>
            </select>
          </div>
          <div>
            <label className={flabel}>Strategy</label>
            <select className={ctrl} value={filter.strategy} onChange={(e) => setFilter({ ...filter, strategy: e.target.value })}>
              <option value="">All Strategies</option>
              {strategyOptions.map((s) => (
                <option key={s.strategyName} value={s.strategyName}>{s.displayName || s.strategyName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={flabel}>From Date</label>
            <input type="date" className={ctrl} value={filter.fromDate} onChange={(e) => setFilter({ ...filter, fromDate: e.target.value })} />
          </div>
          <div>
            <label className={flabel}>To Date</label>
            <input type="date" className={ctrl} value={filter.toDate} onChange={(e) => setFilter({ ...filter, toDate: e.target.value })} />
          </div>
        </div>
        <div className="mt-2">
          <Button variant="primary" onClick={handleSubmit} disabled={isLoading} style={{ width: 120, height: 31 }}>
            {isLoading ? 'Loading...' : 'Submit'}
          </Button>
        </div>
      </div>
      <div>
        {isLoading ? (
          <div className="py-10 text-center text-primary-500"><Spinner /></div>
        ) : isError ? (
          <div className={dangerBox}>Failed to load EOD PnL reports. Please check if the server is running.</div>
        ) : (
          <>
            {summary && (
              <div className={summaryStrip}>
                <span><strong>Reports:</strong> {summary.totalReports}</span>
                <span><strong>P&L:</strong> <span className={summary.totalPl >= 0 ? 'text-success-500' : 'text-danger-500'}>{formatIndianNumber(summary.totalPl, false)}</span></span>
                <span><strong>Charges:</strong> {formatIndianNumber(summary.totalCharges, false)}</span>
                <span><strong>Net P&L:</strong> <span className={summary.totalNetPl >= 0 ? 'font-bold text-success-500' : 'font-bold text-danger-500'}>{formatIndianNumber(summary.totalNetPl, false)}</span></span>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                <thead className={thRow}>
                  <tr>
                    <th className={`${cell} text-left`}>User</th>
                    <th className={`${cell} text-left`}>Broker</th>
                    <th className={`${cell} text-left`}>Strategy</th>
                    <th className={`${cell} text-left`}>Product</th>
                    <th className={`${cell} text-left`}>Date</th>
                    <th className={`${cell} text-right`}>Capital</th>
                    <th className={`${cell} text-right`}>P&L</th>
                    <th className={`${cell} text-right`}>Charges</th>
                    <th className={`${cell} text-right`} title="MTF funding interest — tracked separately, never included in Charges or Net P&L">MTF Int.</th>
                    <th className={`${cell} text-right`}>Net P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedReports.length === 0 ? (
                    <tr><td colSpan={10} className="py-4 text-center text-ink-soft">No reports found</td></tr>
                  ) : (
                    paginatedReports.map((report, index) => (
                      <tr key={index} className="hover:bg-raised/50">
                        <td className={`${cell} text-ink`}>{report.username}</td>
                        <td className={cell}><Badge tone="neutral">{report.broker}</Badge></td>
                        <td className={`${cell} text-ink`}>{getStrategyDisplayName(report.strategy)}</td>
                        <td className={cell}><Badge tone="info">{report.product}</Badge></td>
                        <td className={`${cell} text-ink`}>{report.dateStr}</td>
                        <td className={`${cell} text-right text-ink`}>{formatIndianNumber(report.capital, false)}</td>
                        <td className={`${cell} text-right ${report.pl >= 0 ? 'text-success-500' : 'text-danger-500'}`}>{report.pl?.toFixed(2)}</td>
                        <td className={`${cell} text-right text-ink`}>{report.charges?.toFixed(2)}</td>
                        <td className={`${cell} text-right text-ink`}>{report.mtfInterest ? report.mtfInterest.toFixed(2) : '-'}</td>
                        <td className={`${cell} text-right ${report.netPL >= 0 ? 'font-bold text-success-500' : 'font-bold text-danger-500'}`}>{report.netPL?.toFixed(2)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {!isError && (
        <div className="flex items-center justify-between border-t border-hairline p-3">
          <span className="text-xs text-ink-soft">
            Showing {paginatedReports.length > 0 ? (currentPage - 1) * pageSize + 1 : 0} - {Math.min(currentPage * pageSize, totalRecords)} of {totalRecords} report(s)
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1 || isLoading}>Previous</Button>
              <span className="text-xs text-ink-soft">Page {currentPage} of {totalPages}</span>
              <Button variant="secondary" size="sm" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages || isLoading}>Next</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ReportsPage;
