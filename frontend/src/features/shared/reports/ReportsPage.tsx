/**
 * Reports: the trades, and the day's P&L.
 *
 * Both read the trades table the engine writes, so a report is right the
 * minute a trade closes. The filters apply before any grouping: a daily
 * row means "this day, for whatever was selected", and the strategy-wise
 * view only splits a day further. CSV and Excel carry the same rows.
 */

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { BsArrowClockwise, BsDownload, BsFileText, BsXCircle } from 'react-icons/bs';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { PageHeader } from '@/components/common';
import { Badge, Button, Spinner } from '@/components/ui';
import type { Tone } from '@/components/ui';
import { reportsService } from '@/services/reports/reportsService';
import type { DailyPnlRow, ReportFilters, ReportTotals, TradeReportRow } from '@/types/reports';

const card = 'rounded-card border border-hairline bg-card';
const label = 'mb-1 block text-xs text-ink-soft';
const ctrl = 'h-8 w-full rounded border border-hairline bg-card px-2 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60';
const cell = 'px-2 py-1.5 text-[0.8rem]';
const head = `${cell} text-left`;
const num = `${cell} text-right tabular-nums`;

const tabBtn = (active: boolean) =>
  clsx('-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors', active ? 'border-primary-500 text-primary-500' : 'border-transparent text-ink-soft hover:text-ink');

const isoDay = (d: Date) => d.toISOString().split('T')[0];
const today = () => isoDay(new Date());
const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 86400000));

/** Money arrives as an exact string; shown with Indian grouping, never recomputed. */
const money = (value: string | null | undefined): string => {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : value;
};
const pnlTone = (value: string | null | undefined): string =>
  value === null || value === undefined ? 'text-ink-faint' : Number(value) > 0 ? 'text-success-500' : Number(value) < 0 ? 'text-danger-500' : 'text-ink';

const stateTone = (state: string): Tone =>
  state === 'COMPLETED' ? 'success' : state === 'CANCELLED' || state === 'FAILED' ? 'danger' : state === 'ACTIVE' ? 'blue' : 'neutral';

// ---- shared pieces ----------------------------------------------------------

const useReportFilters = () => {
  const [filters, setFilters] = useState<ReportFilters>({ fromDate: daysAgo(30), toDate: today(), paper: 'live' });
  const set = (key: keyof ReportFilters, value: string | boolean | undefined) => setFilters((f) => ({ ...f, [key]: value || undefined }));
  const reset = () => setFilters({ fromDate: daysAgo(30), toDate: today(), paper: 'live' });
  return { filters, set, reset };
};

const FilterBar: React.FC<{
  filters: ReportFilters;
  set: (key: keyof ReportFilters, value: string | boolean | undefined) => void;
  reset: () => void;
  withState?: boolean;
  withGrouping?: boolean;
}> = ({ filters, set, reset, withState = false, withGrouping = false }) => {
  const { data: options } = useQuery({ queryKey: ['reports', 'filters'], queryFn: () => reportsService.getFilters(), staleTime: 60000 });
  return (
    <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
      <div>
        <span className={label}>From</span>
        <input type="date" className={ctrl} value={filters.fromDate ?? ''} onChange={(e) => set('fromDate', e.target.value)} />
      </div>
      <div>
        <span className={label}>To</span>
        <input type="date" className={ctrl} value={filters.toDate ?? ''} onChange={(e) => set('toDate', e.target.value)} />
      </div>
      <div>
        <span className={label}>Account</span>
        <select className={ctrl} value={filters.tradingClientId ?? ''} onChange={(e) => set('tradingClientId', e.target.value)}>
          <option value="">All accounts</option>
          {options?.tradingClients.map((c) => (
            <option key={c.id} value={c.id}>{c.displayName} ({c.broker.toLowerCase()})</option>
          ))}
        </select>
      </div>
      <div>
        <span className={label}>Strategy</span>
        <select className={ctrl} value={filters.strategy ?? ''} onChange={(e) => set('strategy', e.target.value)}>
          <option value="">All strategies</option>
          {options?.strategies.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div>
        <span className={label}>Product</span>
        <select className={ctrl} value={filters.product ?? ''} onChange={(e) => set('product', e.target.value)}>
          <option value="">All products</option>
          {options?.products.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>
      <div>
        <span className={label}>Paper or live</span>
        <select className={ctrl} value={filters.paper ?? ''} onChange={(e) => set('paper', e.target.value)}>
          <option value="live">Live</option>
          <option value="paper">Paper</option>
          <option value="">Both</option>
        </select>
      </div>
      {withState && (
        <div>
          <span className={label}>State</span>
          <select className={ctrl} value={filters.state ?? ''} onChange={(e) => set('state', e.target.value)}>
            <option value="">All states</option>
            {options?.states.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      )}
      {withGrouping && (
        <div>
          <span className={label}>Split each day</span>
          <div className="flex h-8 items-center gap-3 text-sm text-ink">
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!filters.byStrategy} onChange={(e) => set('byStrategy', e.target.checked)} /> by strategy</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!filters.byAccount} onChange={(e) => set('byAccount', e.target.checked)} /> by account</label>
          </div>
        </div>
      )}
      <div className="flex items-end">
        <Button variant="ghost" size="sm" onClick={reset} title="Last 30 days, live, everything">
          <BsXCircle /> Reset
        </Button>
      </div>
    </div>
  );
};

const TotalsStrip: React.FC<{ totals: ReportTotals | undefined; extra?: { label: string; value: React.ReactNode }[] }> = ({ totals, extra = [] }) => {
  const tiles = [
    { label: 'Gross P&L', value: <span className={pnlTone(totals?.grossPnl)}>{money(totals?.grossPnl)}</span> },
    { label: 'Net P&L', value: <span className={pnlTone(totals?.netPnl)}>{money(totals?.netPnl)}</span>, hint: 'charges not computed yet' },
    { label: 'Closed trades', value: totals ? `${totals.closed} of ${totals.trades}` : '—' },
    { label: 'Win rate', value: totals?.winRate ? `${totals.winRate}%` : '—', hint: totals ? `${totals.wins} won · ${totals.losses} lost · ${totals.flat} flat` : undefined },
    { label: 'Best / worst', value: totals ? `${money(totals.best)} / ${money(totals.worst)}` : '—' },
    ...extra,
  ];
  return (
    <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t) => (
        <div key={t.label} className={`${card} p-3 text-center`}>
          <div className="text-lg font-bold text-ink">{t.value}</div>
          <div className="text-xs text-ink-soft">{t.label}</div>
          {'hint' in t && t.hint && <div className="text-[0.7rem] text-ink-faint">{t.hint}</div>}
        </div>
      ))}
    </div>
  );
};

const ExportButtons: React.FC<{ onExport: (format: 'csv' | 'xlsx') => Promise<void>; disabled?: boolean }> = ({ onExport, disabled }) => {
  const exporting = useMutation({
    mutationFn: (format: 'csv' | 'xlsx') => onExport(format),
    onError: (e: Error) => toast.error(e.message || 'The export failed'),
  });
  return (
    <div className="flex gap-1">
      <Button variant="secondary" size="sm" onClick={() => exporting.mutate('csv')} disabled={disabled || exporting.isPending}>
        <BsDownload /> CSV
      </Button>
      <Button variant="secondary" size="sm" onClick={() => exporting.mutate('xlsx')} disabled={disabled || exporting.isPending}>
        <BsDownload /> Excel
      </Button>
    </div>
  );
};

// ---- the trades ---------------------------------------------------------------

const TradesPanel: React.FC = () => {
  const { filters, set, reset } = useReportFilters();
  const query = useQuery({ queryKey: ['reports', 'trades', filters], queryFn: () => reportsService.getTrades(filters), staleTime: 15000 });
  const rows = query.data?.rows ?? [];
  return (
    <>
      <FilterBar filters={filters} set={set} reset={reset} withState />
      <TotalsStrip totals={query.data?.totals} />
      <div className={card}>
        <div className="flex items-center justify-between border-b border-hairline p-3">
          <h5 className="mb-0 flex items-center gap-2 font-semibold text-ink">
            Trades <small className="font-normal text-ink-soft">{query.data ? `${rows.length} between ${query.data.fromDate} and ${query.data.toDate}` : ''}</small>
            {query.data?.truncated && <Badge tone="warning">first 5,000 only; narrow the range</Badge>}
            {query.isFetching && <Spinner size="sm" />}
          </h5>
          <div className="flex items-center gap-2">
            <ExportButtons onExport={(f) => reportsService.exportTrades(filters, f)} disabled={rows.length === 0} />
            <Button variant="secondary" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}><BsArrowClockwise /></Button>
          </div>
        </div>
        {query.error && <div className="p-3 text-sm text-danger-500">{(query.error as Error).message}</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
            <thead className="bg-raised text-xs uppercase text-ink-faint">
              <tr>
                <th className={head}>Day</th>
                <th className={head}>Account</th>
                <th className={head}>Strategy</th>
                <th className={head}>Symbol</th>
                <th className={head}>Product</th>
                <th className={head}>Side</th>
                <th className={num}>Qty</th>
                <th className={num}>Entry</th>
                <th className={num}>Exit</th>
                <th className={head}>Exit reason</th>
                <th className={head}>State</th>
                <th className={num}>Gross P&L</th>
                <th className={head}>Trade</th>
              </tr>
            </thead>
            <tbody>
              {query.isLoading ? (
                <tr><td colSpan={13} className="py-4 text-center text-ink-soft"><Spinner size="sm" /> Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={13} className="py-4 text-center text-ink-soft">No trade in this range matches.</td></tr>
              ) : (
                rows.map((r: TradeReportRow) => (
                  <tr key={r.tradeId} className="hover:bg-raised/50">
                    <td className={`${cell} whitespace-nowrap text-ink`}>{r.tradingDay ?? '—'}</td>
                    <td className={`${cell} text-ink`}>{r.tradingClient ?? r.tradingClientId}{r.isPaper && <Badge tone="info" className="ml-1">paper</Badge>}</td>
                    <td className={`${cell} text-ink`}>{r.strategy}</td>
                    <td className={`${cell} font-mono text-ink`}>{r.tradingSymbol}</td>
                    <td className={`${cell} text-ink`}>{r.product}</td>
                    <td className={cell}><Badge tone={r.direction === 'LONG' ? 'success' : 'danger'}>{r.direction}</Badge></td>
                    <td className={`${num} text-ink`}>{r.filledQuantity}/{r.quantity}</td>
                    <td className={`${num} text-ink`}>{money(r.entry)}</td>
                    <td className={`${num} text-ink`}>{money(r.exit)}</td>
                    <td className={`${cell} text-ink-soft`}>{r.exitReason ?? r.failureReason ?? ''}</td>
                    <td className={cell}><Badge tone={stateTone(r.state)}>{r.state}</Badge></td>
                    <td className={`${num} font-medium ${pnlTone(r.grossPnl)}`}>{money(r.grossPnl)}</td>
                    <td className={`${cell} font-mono text-[0.7rem] text-ink-faint`}>{r.tradeId.length > 14 ? `${r.tradeId.slice(0, 14)}…` : r.tradeId}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

// ---- the day's P&L -----------------------------------------------------------

const DailyPnlPanel: React.FC = () => {
  const { filters, set, reset } = useReportFilters();
  const query = useQuery({ queryKey: ['reports', 'daily', filters], queryFn: () => reportsService.getDailyPnl(filters), staleTime: 15000 });
  const rows = query.data?.rows ?? [];
  const split = !!filters.byStrategy || !!filters.byAccount;
  const extra = useMemo(() => (query.data ? [{ label: 'Trading days', value: query.data.tradingDays }] : []), [query.data]);
  return (
    <>
      <FilterBar filters={filters} set={set} reset={reset} withGrouping />
      <TotalsStrip totals={query.data?.totals} extra={extra} />
      <div className={card}>
        <div className="flex items-center justify-between border-b border-hairline p-3">
          <h5 className="mb-0 flex items-center gap-2 font-semibold text-ink">
            Daily P&L
            <small className="font-normal text-ink-soft">
              {filters.strategy ? `${filters.strategy} only` : 'every selected strategy pooled'}{split ? ', each day split' : ''}; a trade counts on the day it exits
            </small>
            {query.isFetching && <Spinner size="sm" />}
          </h5>
          <div className="flex items-center gap-2">
            <ExportButtons onExport={(f) => reportsService.exportDailyPnl(filters, f)} disabled={rows.length === 0} />
            <Button variant="secondary" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}><BsArrowClockwise /></Button>
          </div>
        </div>
        {query.error && <div className="p-3 text-sm text-danger-500">{(query.error as Error).message}</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
            <thead className="bg-raised text-xs uppercase text-ink-faint">
              <tr>
                <th className={head}>Trading day</th>
                {filters.byAccount && <th className={head}>Account</th>}
                {filters.byStrategy && <th className={head}>Strategy</th>}
                <th className={head}>Paper</th>
                <th className={num}>Trades</th>
                <th className={num}>Won</th>
                <th className={num}>Lost</th>
                <th className={num}>Gross P&L</th>
                <th className={num}>Charges</th>
                <th className={num}>Net P&L</th>
              </tr>
            </thead>
            <tbody>
              {query.isLoading ? (
                <tr><td colSpan={10} className="py-4 text-center text-ink-soft"><Spinner size="sm" /> Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={10} className="py-4 text-center text-ink-soft">No closed trade in this range matches.</td></tr>
              ) : (
                rows.map((r: DailyPnlRow, i) => (
                  <tr key={`${r.tradingDay}-${r.tradingClientId}-${r.strategy}-${r.isPaper}-${i}`} className="hover:bg-raised/50">
                    <td className={`${cell} whitespace-nowrap font-medium text-ink`}>{r.tradingDay}</td>
                    {filters.byAccount && <td className={`${cell} text-ink`}>{r.tradingClient ?? r.tradingClientId}</td>}
                    {filters.byStrategy && <td className={`${cell} text-ink`}>{r.strategy}</td>}
                    <td className={cell}>{r.isPaper ? <Badge tone="info">paper</Badge> : <Badge tone="success">live</Badge>}</td>
                    <td className={`${num} text-ink`}>{r.trades}</td>
                    <td className={`${num} text-success-500`}>{r.wins}</td>
                    <td className={`${num} text-danger-500`}>{r.losses}</td>
                    <td className={`${num} font-medium ${pnlTone(r.grossPnl)}`}>{money(r.grossPnl)}</td>
                    <td className={`${num} text-ink-faint`} title="Not computed until the charges phase">{money(r.charges)}</td>
                    <td className={`${num} font-medium ${pnlTone(r.netPnl)}`}>{money(r.netPnl)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

// ---- the page ---------------------------------------------------------------

const ReportsPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'trades' | 'daily'>('trades');
  return (
    <div>
      <PageHeader title="Reports" subtitle="The trades, and the day's P&L, as the engine wrote them" icon={<BsFileText size={24} />} />
      <div className="mb-3 flex flex-wrap gap-1 border-b border-hairline">
        <button type="button" className={tabBtn(activeTab === 'trades')} onClick={() => setActiveTab('trades')}>Trades</button>
        <button type="button" className={tabBtn(activeTab === 'daily')} onClick={() => setActiveTab('daily')}>Daily P&L</button>
      </div>
      {activeTab === 'trades' ? <TradesPanel /> : <DailyPnlPanel />}
    </div>
  );
};

export default ReportsPage;
