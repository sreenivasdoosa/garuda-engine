/**
 * RMS Breaches: what the gate refused, and why.
 *
 * One row per breach, not per refusal: an order stopped for a wide spread
 * and thin volume is two facts, and the question this page answers is how
 * often each one stopped us. Filtered in the database, so the count and
 * the cards agree with the page.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BsArrowClockwise, BsExclamationTriangle, BsSearch, BsXCircle } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import TablePagination from '@/components/common/TablePagination';
import { DEFAULT_PAGE_SIZE } from '@/types/pagination';
import { rmsLiveService } from '@/services/admin/rmsLiveService';
import { tradingClientService } from '@/services/admin/tradingClientService';
import { Badge, Button, Spinner } from '@/components/ui';
import type { Tone } from '@/components/ui';

const severityLabel = (severity: number): string => (severity >= 3 ? 'HIGH' : severity >= 2 ? 'MEDIUM' : 'LOW');
const severityTone = (severity: number): Tone => (severity >= 3 ? 'danger' : severity >= 2 ? 'warning' : 'info');

const today = () => new Date().toISOString().split('T')[0];
const daysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
};

const label = 'mb-1 block text-xs text-ink-soft';
const ctrl =
  'h-8 w-full rounded border border-hairline bg-card px-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60';
const cell = 'px-2 py-1.5 text-[0.8rem]';
const affixBtn =
  'flex h-8 items-center justify-center rounded-r border border-l-0 border-hairline bg-raised px-2.5 text-ink-soft hover:text-ink';

const BreachesPage: React.FC = () => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [clientFilter, setClientFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [fromDate, setFromDate] = useState(today());
  const [toDate, setToDate] = useState(today());
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  useEffect(() => {
    setPage(1);
  }, [clientFilter, typeFilter, fromDate, toDate, searchTerm, severityFilter, categoryFilter, pageSize]);

  const breaches = useQuery({
    queryKey: ['rms', 'breaches', page, pageSize, clientFilter, typeFilter, fromDate, toDate, searchTerm, severityFilter, categoryFilter],
    queryFn: () =>
      rmsLiveService.breaches({
        page,
        pageSize,
        tradingClientId: clientFilter || undefined,
        type: typeFilter || undefined,
        startDate: fromDate || undefined,
        endDate: toDate || undefined,
        search: searchTerm || undefined,
        severity: severityFilter || undefined,
        category: categoryFilter || undefined,
      }),
    refetchInterval: 30000,
  });
  const filters = useQuery({
    queryKey: ['rms', 'breach-filters'],
    queryFn: () => rmsLiveService.breachFilters(),
    staleTime: 60 * 60 * 1000,
  });
  const todays = useQuery({
    queryKey: ['rms', 'breaches-today'],
    queryFn: () => rmsLiveService.breachesToday(),
    refetchInterval: 30000,
  });
  const clients = useQuery({ queryKey: ['trading-clients'], queryFn: () => tradingClientService.getAll() });

  const rows = breaches.data?.data ?? [];
  const pagination = breaches.data?.pagination;
  const summary = breaches.data?.summary;

  const hasFilters = useMemo(
    () =>
      !!(clientFilter || typeFilter || searchTerm || severityFilter || categoryFilter || fromDate !== today() || toDate !== today()),
    [clientFilter, typeFilter, searchTerm, severityFilter, categoryFilter, fromDate, toDate],
  );
  const reset = () => {
    setClientFilter('');
    setTypeFilter('');
    setSearchInput('');
    setSearchTerm('');
    setSeverityFilter('');
    setCategoryFilter('');
    setFromDate(today());
    setToDate(today());
  };

  const header = (
    <PageHeader title="RMS Breaches" subtitle="What the gate refused, and why" icon={<BsExclamationTriangle size={24} />} />
  );

  if (breaches.error) {
    return (
      <>
        {header}
        <div className="rounded-card border border-hairline bg-card py-4 text-center text-danger-600 dark:text-danger-400">
          Could not load the breach log: {(breaches.error as Error).message}
        </div>
      </>
    );
  }

  const todayCount = todays.data?.length ?? 0;
  const cards = [
    { value: todayCount, label: 'Breaches today', cls: todayCount > 0 ? 'text-warning-500' : 'text-success-500' },
    { value: pagination?.totalCount ?? 0, label: 'Matching the filters', cls: 'text-primary-500' },
    { value: summary?.highSeverity ?? 0, label: 'High severity', cls: 'text-danger-500' },
    { value: summary?.uniqueClients ?? 0, label: 'Accounts affected', cls: 'text-accent-500' },
  ];

  return (
    <div>
      {header}

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-card border border-hairline bg-card p-4 text-center">
            <div className={`text-2xl font-bold ${c.cls}`}>{c.value}</div>
            <div className="text-xs text-ink-soft">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="rounded-card border border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline p-3">
          <div className="flex items-center gap-2">
            <h5 className="mb-0 flex items-center gap-2 font-semibold text-ink">
              <BsExclamationTriangle className="text-warning-500" />
              Breach log
            </h5>
            {breaches.isFetching && <Spinner size="sm" />}
          </div>
          <Button variant="secondary" size="sm" onClick={() => breaches.refetch()} disabled={breaches.isFetching}>
            <BsArrowClockwise className={breaches.isFetching ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>

        <div className="p-3">
          <div className="mb-2 grid grid-cols-1 items-end gap-2 md:grid-cols-4">
            <div>
              <label className={label}>From</label>
              <input type="date" className={ctrl} value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div>
              <label className={label}>To</label>
              <input type="date" className={ctrl} value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
            <div className="flex flex-wrap items-end gap-1 md:col-span-2">
              <Button variant="secondary" size="sm" onClick={() => { setFromDate(today()); setToDate(today()); }}>
                Today
              </Button>
              {[7, 30, 90].map((d) => (
                <Button key={d} variant="secondary" size="sm" onClick={() => { setFromDate(daysAgo(d)); setToDate(today()); }}>
                  {d}D
                </Button>
              ))}
            </div>
          </div>

          <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-12">
            <div className="flex lg:col-span-3">
              <input
                className={`${ctrl} rounded-r-none`}
                placeholder="details, symbol, type, strategy or account"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && setSearchTerm(searchInput)}
              />
              <button type="button" className={affixBtn} onClick={() => setSearchTerm(searchInput)} aria-label="Search">
                <BsSearch />
              </button>
            </div>
            <div className="lg:col-span-2">
              <select className={ctrl} value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}>
                <option value="">All accounts</option>
                {(clients.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName} ({c.broker})
                  </option>
                ))}
              </select>
            </div>
            <div className="lg:col-span-2">
              <select className={ctrl} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="">All breach types</option>
                {(filters.data?.breachTypes ?? []).map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
            <div className="lg:col-span-2">
              <select className={ctrl} value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
                <option value="">All severities</option>
                <option value="1">Low (1)</option>
                <option value="2">Medium (2)</option>
                <option value="3">High (3+)</option>
              </select>
            </div>
            <div className="lg:col-span-2">
              <select className={ctrl} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                <option value="">All categories</option>
                {(filters.data?.categories ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
            <div className="lg:col-span-1">
              {hasFilters && (
                <Button variant="danger" size="sm" className="w-full" onClick={reset} title="Clear filters">
                  <BsXCircle />
                </Button>
              )}
            </div>
          </div>

          <div className="mb-2 text-xs text-ink-soft">
            Showing {rows.length} of {pagination?.totalCount ?? 0} breach(es). Refreshes every 30s.
          </div>

          {pagination && (
            <TablePagination
              page={pagination.page}
              pageSize={pagination.pageSize}
              totalCount={pagination.totalCount}
              totalPages={pagination.totalPages}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              itemLabel="breaches"
              loading={breaches.isLoading}
            />
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
              <thead className="bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={`${cell} text-left`} style={{ width: 160 }}>Time</th>
                  <th className={`${cell} text-left`} style={{ width: 80 }}>Severity</th>
                  <th className={`${cell} text-left`} style={{ width: 130 }}>Account</th>
                  <th className={`${cell} text-left`} style={{ width: 150 }}>Symbol</th>
                  <th className={`${cell} text-left`} style={{ width: 150 }}>Breach</th>
                  <th className={`${cell} text-left`} style={{ width: 110 }}>Category</th>
                  <th className={`${cell} text-left`}>Details</th>
                  <th className={`${cell} text-left`} style={{ width: 130 }}>Was / limit</th>
                </tr>
              </thead>
              <tbody>
                {breaches.isLoading ? (
                  <tr>
                    <td colSpan={8} className="py-4 text-center text-ink-soft">
                      <Spinner size="sm" /> Loading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-4 text-center text-ink-soft">
                      Nothing refused in this range.
                    </td>
                  </tr>
                ) : (
                  rows.map((b) => (
                    <tr key={b.id} className="hover:bg-raised/50">
                      <td className={`${cell} whitespace-nowrap text-ink`}>
                        {b.breachTime ? new Date(b.breachTime).toLocaleString() : '-'}
                      </td>
                      <td className={cell}>
                        <Badge tone={severityTone(b.severity)}>{severityLabel(b.severity)}</Badge>
                      </td>
                      <td className={cell}>
                        <span className="font-medium text-ink">{b.tradingClient ?? b.tradingClientId ?? '-'}</span>
                        {b.broker && <small className="block text-ink-soft">{b.broker}</small>}
                      </td>
                      <td className={cell}>
                        <code className="text-ink">{b.tradingSymbol}</code>
                        {b.strategyName && <small className="block text-ink-soft">{b.strategyName}</small>}
                      </td>
                      <td className={cell}>
                        <Badge tone={b.severity >= 3 ? 'danger' : b.severity >= 2 ? 'warning' : 'neutral'}>
                          {b.breachType?.replace(/_/g, ' ')}
                        </Badge>
                      </td>
                      <td className={`${cell} truncate text-ink`}>{b.breachCategory?.replace(/_/g, ' ')}</td>
                      <td className={`${cell} text-ink`} title={b.breachDetails ?? ''}>{b.breachDetails}</td>
                      <td className={cell}>
                        <small className="text-danger-500">{b.currentValue ?? '-'}</small>
                        <small className="text-ink-soft"> / </small>
                        <small className="text-success-500">{b.limitValue ?? '-'}</small>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BreachesPage;
