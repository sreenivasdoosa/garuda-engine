/**
 * Standalone RMS Breaches Page
 * View and monitor RMS breach logs with filters similar to Alerts page
 */

import { useState, useMemo, useEffect } from 'react';
import { BsSearch, BsArrowClockwise, BsXCircle, BsExclamationTriangle } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import UserSelect from '@/components/common/UserSelect';
import TablePagination from '@/components/common/TablePagination';
import { DEFAULT_PAGE_SIZE } from '@/types/pagination';
import { useQuery } from '@tanstack/react-query';
import { rmsConfigService } from '@/services/admin/v2AdminService';
import { Badge, Button, Spinner } from '@/components/ui';
import type { Tone } from '@/components/ui';

const getSeverityLabel = (severity: number): string => {
  if (severity >= 3) return 'HIGH';
  if (severity >= 2) return 'MEDIUM';
  return 'LOW';
};

const getSeverityTone = (severity: number): Tone => {
  if (severity >= 3) return 'danger';
  if (severity >= 2) return 'warning';
  return 'info';
};

const getDefaultDateRange = () => {
  const today = new Date().toISOString().split('T')[0];
  return { fromDate: today, toDate: today };
};

const label = 'mb-1 block text-xs text-ink-soft';
const ctrl = 'h-8 w-full rounded border border-hairline bg-card px-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60';
const cell = 'px-2 py-1.5 text-[0.8rem]';
const affixBtn = 'flex h-8 items-center justify-center rounded-r border border-l-0 border-hairline bg-raised px-2.5 text-ink-soft hover:text-ink';

const RMSBreachesPage: React.FC = () => {
  const defaultRange = getDefaultDateRange();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [usernameFilter, setUsernameFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [fromDate, setFromDate] = useState(defaultRange.fromDate);
  const [toDate, setToDate] = useState(defaultRange.toDate);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  useEffect(() => {
    setPage(1);
  }, [usernameFilter, typeFilter, fromDate, toDate, searchTerm, severityFilter, categoryFilter, pageSize]);

  const { data: breachPage, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['rms-breaches', page, pageSize, usernameFilter, typeFilter, fromDate, toDate, searchTerm, severityFilter, categoryFilter],
    queryFn: () => rmsConfigService.getBreachesPaginated({ page, pageSize, username: usernameFilter || undefined, type: typeFilter || undefined, startDate: fromDate || undefined, endDate: toDate || undefined, search: searchTerm || undefined, severity: severityFilter || undefined, category: categoryFilter || undefined }),
    refetchInterval: 30000,
  });
  const breaches = breachPage?.data;
  const pagination = breachPage?.pagination;
  const summary = breachPage?.summary;

  const { data: breachFilters } = useQuery({
    queryKey: ['rms-breach-filters'],
    queryFn: () => rmsConfigService.getBreachFilters(),
    staleTime: 60 * 60 * 1000,
  });

  const { data: todayBreaches } = useQuery({
    queryKey: ['rms-breaches-today'],
    queryFn: () => rmsConfigService.getTodayBreaches(),
    refetchInterval: 30000,
  });

  const breachTypeOptions = useMemo(() => {
    if (!breachFilters?.breachTypes) return [];
    return breachFilters.breachTypes.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }));
  }, [breachFilters]);

  const pageBreaches = breaches ?? [];

  const handleSearch = () => setSearchTerm(searchInput);
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const setPresetRange = (days: number) => {
    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - days);
    setFromDate(from.toISOString().split('T')[0]);
    setToDate(today.toISOString().split('T')[0]);
  };

  const setToday = () => {
    const today = new Date().toISOString().split('T')[0];
    setFromDate(today);
    setToDate(today);
  };

  const hasActiveFilters = useMemo(() => {
    const def = getDefaultDateRange();
    return !!(usernameFilter || typeFilter || searchTerm || severityFilter || categoryFilter || fromDate !== def.fromDate || toDate !== def.toDate);
  }, [usernameFilter, typeFilter, searchTerm, severityFilter, categoryFilter, fromDate, toDate]);

  const resetFilters = () => {
    const def = getDefaultDateRange();
    setUsernameFilter('');
    setTypeFilter('');
    setSearchInput('');
    setSearchTerm('');
    setSeverityFilter('');
    setCategoryFilter('');
    setFromDate(def.fromDate);
    setToDate(def.toDate);
  };

  const breachCount = todayBreaches?.length || 0;

  if (error) {
    return (
      <>
        <PageHeader title="RMS Breaches" subtitle="Monitor risk management breach logs" icon={<BsExclamationTriangle size={24} />} />
        <div className="rounded-card border border-hairline bg-card py-4 text-center text-danger-600 dark:text-danger-400">Failed to load breach logs</div>
      </>
    );
  }

  const statCards = [
    { value: breachCount, label: 'Breaches Today', cls: breachCount > 0 ? 'text-warning-500' : 'text-success-500' },
    { value: pagination?.totalCount ?? 0, label: 'Showing (filtered)', cls: 'text-primary-500' },
    { value: summary?.highSeverity ?? 0, label: 'High Severity', cls: 'text-danger-500' },
    { value: summary?.uniqueUsers ?? 0, label: 'Unique Users', cls: 'text-accent-500' },
  ];

  return (
    <div>
      <PageHeader title="RMS Breaches" subtitle="Monitor risk management breach logs" icon={<BsExclamationTriangle size={24} />} />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {statCards.map((c) => (
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
              RMS Breach Log
            </h5>
            {isFetching && <Spinner size="sm" />}
          </div>
          <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <BsArrowClockwise className={isFetching ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>

        <div className="p-3">
          {/* Date Range Row */}
          <div className="mb-2 grid grid-cols-1 items-end gap-2 md:grid-cols-4">
            <div>
              <label className={label}>From Date</label>
              <input type="date" className={ctrl} value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div>
              <label className={label}>To Date</label>
              <input type="date" className={ctrl} value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
            <div className="flex flex-wrap items-end gap-1 md:col-span-2">
              <Button variant="secondary" size="sm" onClick={setToday}>Today</Button>
              <Button variant="secondary" size="sm" onClick={() => setPresetRange(7)}>7D</Button>
              <Button variant="secondary" size="sm" onClick={() => setPresetRange(30)}>30D</Button>
              <Button variant="secondary" size="sm" onClick={() => setPresetRange(90)}>90D</Button>
            </div>
          </div>

          {/* Filters Row */}
          <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-12">
            <div className="flex lg:col-span-3">
              <input className={`${ctrl} rounded-r-none`} placeholder="Search breaches..." value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onKeyDown={handleSearchKeyDown} />
              <button type="button" className={affixBtn} onClick={handleSearch} aria-label="Search">
                <BsSearch />
              </button>
            </div>
            <div className="lg:col-span-2">
              <UserSelect value={usernameFilter} onChange={setUsernameFilter} allOptionLabel="All Users" />
            </div>
            <div className="lg:col-span-2">
              <select className={ctrl} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="">All Breach Types</option>
                {breachTypeOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="lg:col-span-2">
              <select className={ctrl} value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
                <option value="">All Severities</option>
                <option value="1">Low (1)</option>
                <option value="2">Medium (2)</option>
                <option value="3">High (3+)</option>
              </select>
            </div>
            <div className="lg:col-span-2">
              <select className={ctrl} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                <option value="">All Categories</option>
                {breachFilters?.categories?.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
            <div className="lg:col-span-1">
              {hasActiveFilters && (
                <Button variant="danger" size="sm" className="w-full" onClick={resetFilters} title="Clear Filters">
                  <BsXCircle />
                </Button>
              )}
            </div>
          </div>

          {/* Results Info */}
          <div className="mb-2 text-xs text-ink-soft">
            Showing {pageBreaches.length} of {pagination?.totalCount ?? 0} breach(es) &bull; Auto-refreshes every 30s
          </div>

          {/* Pagination (server-side) */}
          {pagination && (
            <TablePagination
              page={pagination.page}
              pageSize={pagination.pageSize}
              totalCount={pagination.totalCount}
              totalPages={pagination.totalPages}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              itemLabel="breaches"
              loading={isLoading}
            />
          )}

          {/* Breaches Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
              <thead className="bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={`${cell} text-left`} style={{ width: '160px' }}>Time</th>
                  <th className={`${cell} text-left`} style={{ width: '80px' }}>Severity</th>
                  <th className={`${cell} text-left`} style={{ width: '120px' }}>User</th>
                  <th className={`${cell} text-left`} style={{ width: '100px' }}>Symbol</th>
                  <th className={`${cell} text-left`} style={{ width: '140px' }}>Breach Type</th>
                  <th className={`${cell} text-left`} style={{ width: '110px' }}>Category</th>
                  <th className={`${cell} text-left`}>Details</th>
                  <th className={`${cell} text-left`} style={{ width: '130px' }}>Current / Limit</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={8} className="py-4 text-center text-ink-soft">
                      <Spinner size="sm" /> Loading breaches...
                    </td>
                  </tr>
                ) : pageBreaches.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-4 text-center text-ink-soft">No breaches found</td>
                  </tr>
                ) : (
                  pageBreaches.map((breach, idx) => (
                    <tr key={breach.id || idx} className="hover:bg-raised/50">
                      <td className={`${cell} whitespace-nowrap text-ink`}>{new Date(breach.breachTime).toLocaleString()}</td>
                      <td className={cell}>
                        <Badge tone={getSeverityTone(breach.severity)}>{getSeverityLabel(breach.severity)}</Badge>
                      </td>
                      <td className={cell}>
                        <span className="font-medium text-ink">{breach.username}</span>
                        {breach.broker && <small className="block text-ink-soft">{breach.broker}</small>}
                      </td>
                      <td className={cell}>
                        <code className="text-ink">{breach.tradingSymbol}</code>
                      </td>
                      <td className={cell}>
                        <Badge tone={breach.severity >= 3 ? 'danger' : breach.severity >= 2 ? 'warning' : 'neutral'}>{breach.breachType?.replace(/_/g, ' ')}</Badge>
                      </td>
                      <td className={`${cell} truncate text-ink`} title={breach.breachCategory}>{breach.breachCategory?.replace(/_/g, ' ')}</td>
                      <td className={`${cell} text-ink`} title={breach.breachDetails}>{breach.breachDetails}</td>
                      <td className={cell}>
                        <small className="text-danger-500">{breach.currentValue}</small>
                        <small className="text-ink-soft"> / </small>
                        <small className="text-success-500">{breach.limitValue}</small>
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

export default RMSBreachesPage;
